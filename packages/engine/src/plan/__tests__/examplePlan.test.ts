/**
 * Round-2 ruling 3 and spec Section 8.5, second half. The plan the repository
 * ships as its worked example passes both gates and compiles against the
 * default profile, over a fixture book built from the synthetic dimension rows
 * of exampleDimensions.ts: the acceptance the piece-1 brief critic found unproved.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { mountProfile } from "@alm/harness";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { BehavioralClassId, RunPlan } from "../../contracts/plan";
import type { ChartOfAccounts, ProductFamilyDef } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { defaultHarness } from "../../plugins/defaultHarness";
import { resolveDefaultContext } from "../../run/engine";
import { buildRunResult } from "../../run/orchestrate";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { UnlicensedBindingError } from "../../run/executorErrors";
import {
  AS_OF,
  baseAssumptions,
  BETA_DEFAULT_PARAMS,
  fixedPosition,
  HORIZON,
  loadMarket,
  makeRunRequest,
  MORTGAGE_DEFAULT_PARAMS,
  mortgagePosition,
  NMD_B_DEFAULT_PARAMS,
  NMD_DEFAULT_PARAMS,
  nmdBetaPosition,
  nmdPosition,
  segmentedNmdBook,
  twoSidedBook,
} from "../../run/__tests__/fixtures";
import { compilePlan, registryProducers } from "../compile";
import { fixturePlan } from "./fixtures";
import { EXAMPLE_DIMENSION_ROWS, type ExampleDimensionRow } from "./exampleDimensions";
import { parseRoutingPolicy, parseRunPlan } from "../parse";
import { routingGate } from "../routingGate";
import { typeGate } from "../typeGate";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const readJson = (rel: string) => JSON.parse(readFileSync(`${ROOT}${rel}`, "utf8")) as unknown;

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

type DimensionRow = ExampleDimensionRow;

function isClassId(x: string): x is BehavioralClassId {
  return [
    "prepayment", "client-rate-asset", "draw-utilization", "product-mix",
    "new-volume", "decay", "early-withdrawal", "deposit-beta",
  ].includes(x);
}

type Instrument = "fixed-loan" | "mortgage" | "nmd" | "nmd-b";

function instrumentFor(classes: readonly string[]): Instrument {
  if (classes.includes("deposit-beta")) return "nmd-b";
  if (classes.includes("decay")) return "nmd";
  if (classes.includes("prepayment")) return "mortgage";
  return "fixed-loan";
}

function positionFor(id: string, family: ProductFamilyDef): Position {
  const make = {
    "fixed-loan": fixedPosition,
    mortgage: mortgagePosition,
    nmd: nmdPosition,
    "nmd-b": nmdBetaPosition,
  }[family.instrumentType as Instrument];
  return { ...make(id), familyId: family.id, coaNodeId: family.coaNodeId };
}

/**
 * The dimension-row fixture: one family per product family, each family
 * DECLARING the classes its rows carry (ruling 1), so the routing gate binds
 * client-rate-asset, which no overlay kind derives, and draw-utilization, which
 * the `commitment-draw` overlay HAS derived since piece 7 but which this fixture
 * declares anyway because it carries no commitment binding. The plan's selectors
 * name product families, so the family id is the product family and the position
 * rows attach to it.
 */
function bookDimensionsPortfolio(): PortfolioSpec {
  const doc: { positions: readonly DimensionRow[] } = { positions: EXAMPLE_DIMENSION_ROWS };
  const families: ProductFamilyDef[] = [];
  const byFamily = new Map<string, ProductFamilyDef>();
  const positions: Position[] = [];
  for (const row of doc.positions) {
    const id = row.dims.productFamily;
    let family = byFamily.get(id);
    if (family === undefined) {
      family = {
        id,
        label: id,
        side: row.dims.side.toLowerCase() === "liability" ? "liability" : "asset",
        instrumentType: "fixed-loan",
        coaNodeId: `node-${families.length}`,
        behavioralClasses: [],
      };
      byFamily.set(id, family);
      families.push(family);
    }
    for (const cls of row.dims.behavioralClasses) {
      if (isClassId(cls) && !family.behavioralClasses!.includes(cls)) family.behavioralClasses!.push(cls);
    }
  }
  for (const family of families) family.instrumentType = instrumentFor(family.behavioralClasses ?? []);
  for (const row of doc.positions) {
    positions.push({
      ...positionFor(row.id, byFamily.get(row.dims.productFamily)!),
      dimensions: { segment: row.dims.segment },
    });
  }
  const coa: ChartOfAccounts = {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "liabilities", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      ...families.map((f, i) => ({
        id: f.coaNodeId,
        label: f.label,
        parentId: f.side === "asset" ? "assets" : "liabilities",
        side: f.side,
        isLeaf: true,
        familyId: f.id,
        order: i,
      })),
    ],
    families,
  };
  return {
    id: "example-dimensions-book-v1",
    label: "Example dimensions book",
    asOf: "2026-03-31",
    coa,
    positions,
    taxonomy: {
      schemaVersion: "1.0.0",
      id: "demo-dimensions-v1",
      label: "Demo dimensions",
      dimensions: [
        { id: "segment", label: "Calibration segment", values: ["Rate shoppers", "Relationship", "Whole book"] },
      ],
    },
  };
}

/**
 * One binding per behavioral stage of the plan, on the family that stage's
 * selector names. The plan's stages are the LICENCES, so a binding
 * on a family no stage selects is refused at compile, which is acceptance (b)
 * seen from the other side.
 */
function exampleAssumptions(portfolio: PortfolioSpec): AssumptionSet {
  const family = (id: string) => portfolio.coa.families.find((f) => f.id === id)!.id;
  return {
    schemaVersion: "1.0.0",
    id: "example-plan-v1",
    label: "One binding per behavioral stage",
    bindings: [
      { familyId: family("Mortgages"), modelVersion: "x", overlay: { kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS } },
      { familyId: family("Fixed Loans"), modelVersion: "x", overlay: { kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS } },
      { familyId: family("Investments"), modelVersion: "x", overlay: { kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS } },
      { familyId: family("DDA (Non-Interest)"), modelVersion: "x", overlay: { kind: "nmd-decay", params: NMD_DEFAULT_PARAMS } },
      { familyId: family("MMA / Savings"), modelVersion: "x", overlay: { kind: "deposit-beta", params: BETA_DEFAULT_PARAMS } },
      { familyId: family("MMA / Savings"), modelVersion: "x", overlay: { kind: "nmd-decay", params: NMD_B_DEFAULT_PARAMS } },
      { familyId: family("CDs"), modelVersion: "x", overlay: { kind: "cd-rollover", renewalProbability: 0.6, offeredSpreadBp: 25, termMonths: 12 } },
    ],
  };
}

/**
 * Drop the two provenance fields that record which graph ran, and nothing else.
 * `runLog` names the stages; `profileHash` is stamped only when the run took the
 * process default context, so the caller-mounted walk carries no stamp rather
 * than a guessed one. Both runs mount the same profile from the same catalog.
 */
function strip(result: RunResult): unknown {
  const provenance = { ...result.provenance } as Record<string, unknown>;
  delete provenance.runLog;
  delete provenance.profileHash;
  return { ...result, provenance };
}

/**
 * The example plan's stage graph, with the selectors retargeted at the
 * four-position fixture's families (FIXED, MORTGAGE, DDA, MMA) and the three
 * stages the fixture has no family for removed. The SHAPE under test is the
 * example plan's: a behavioral chain, a contractual stage reading the last link,
 * a balance stage, and four metrics.
 */
function fixturePlanShapedLikeExample(example: RunPlan): RunPlan {
  const keep = new Set([
    "st-curve", "st-tlp", "st-term",
    "st-prepay-mortgage", "st-decay-nmd", "st-beta-hys",
    "st-cashflow", "st-balance-plan", "st-nii", "st-eve", "st-gap", "st-ftp",
  ]);
  const retarget: Record<string, string> = {
    "st-prepay-mortgage": "MORTGAGE",
    "st-decay-nmd": "DDA",
    "st-beta-hys": "MMA",
  };
  const stages = example.stages
    .filter((s) => keep.has(s.id))
    .map((s) => ({
      ...s,
      ...(retarget[s.id] !== undefined ? { selector: { ...s.selector, productFamily: retarget[s.id]! } } : {}),
      dependsOn: (s.dependsOn ?? []).filter((d) => keep.has(d)),
    }));
  // The chain the three surviving behavioral stages form, in plan order.
  stages.find((s) => s.id === "st-decay-nmd")!.dependsOn = ["st-prepay-mortgage", "st-term"];
  stages.find((s) => s.id === "st-beta-hys")!.dependsOn = ["st-decay-nmd", "st-term"];
  stages.find((s) => s.id === "st-cashflow")!.dependsOn = ["st-beta-hys", "st-term"];
  stages.find((s) => s.id === "st-balance-plan")!.dependsOn = ["st-cashflow", "st-beta-hys", "st-term"];
  stages.find((s) => s.id === "st-nii")!.dependsOn = ["st-balance-plan"];
  stages.find((s) => s.id === "st-eve")!.dependsOn = ["st-cashflow", "st-curve", "st-tlp", "st-beta-hys"];
  stages.find((s) => s.id === "st-gap")!.dependsOn = ["st-cashflow", "st-beta-hys"];
  stages.find((s) => s.id === "st-ftp")!.dependsOn = ["st-cashflow", "st-curve", "st-tlp", "st-term", "st-nii", "st-beta-hys"];
  return { ...example, stages, asOf: AS_OF, grid: { horizonMonths: HORIZON } };
}

/**
 * The shipped `st-decay-nmd` selector carries a segment predicate, and the
 * retargeted stage keeps it (that is the path under test). The fixture book is
 * therefore TAGGED: one segment tag declaring the shipped values, and every
 * position on "Whole book", which is what an untagged book means when an author
 * writes a predicate over it. Stripping the predicate instead would leave the
 * shipped stage's dimensions unexercised.
 */
function taggedTwoSidedBook(): PortfolioSpec {
  const book = twoSidedBook();
  book.taxonomy = {
    schemaVersion: "1.0.0",
    id: "PF-RUN-segments",
    label: "Fixture segments",
    dimensions: [
      { id: "segment", label: "Calibration segment", values: ["Rate shoppers", "Relationship", "Whole book"] },
    ],
  };
  book.positions = book.positions.map((p) => ({ ...p, dimensions: { segment: "Whole book" } }));
  return book;
}

/**
 * The fixture set with a DDA decay binding that MOVES the book. baseAssumptions
 * binds the kernel term defaults the positions already carry, so applying that
 * overlay and dropping it give the same numbers; a faster closure and a smaller
 * rate-driven ceiling make an unapplied overlay visible.
 */
function decayThatBites(): AssumptionSet {
  const set = baseAssumptions();
  const decay = set.bindings[1]!;
  set.bindings[1] = {
    ...decay,
    overlay: { ...decay.overlay, params: { ...NMD_DEFAULT_PARAMS, closureSteady: 0.4, maxRateDecay: 0.5 } },
  } as typeof decay;
  return set;
}

describe("docs/harness/example-plan.json", () => {
  it("parses at schema 1.4.0", () => {
    const plan = parseRunPlan(readJson("docs/harness/example-plan.json"));
    expect(plan.schemaVersion).toBe("1.4.0");
    expect(plan.stages.length).toBe(17);
  });

  it("passes the type gate against the mounted registry", () => {
    const plan = parseRunPlan(readJson("docs/harness/example-plan.json")) as RunPlan;
    const portfolio = bookDimensionsPortfolio();
    const harness = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const report = typeGate(plan, portfolio.asOf, registryProducers(harness));
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.passed).toBe(true);
    harness.dispose();
  });

  it("passes the routing gate against model-map.json and the fixture book", () => {
    const plan = parseRunPlan(readJson("docs/harness/example-plan.json")) as RunPlan;
    const policy = parseRoutingPolicy(readJson("docs/harness/model-map.json"));
    const portfolio = bookDimensionsPortfolio();
    const report = routingGate(plan, policy, portfolio, [exampleAssumptions(portfolio)]);
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("compiles against the default profile", () => {
    const plan = parseRunPlan(readJson("docs/harness/example-plan.json")) as RunPlan;
    const portfolio = bookDimensionsPortfolio();
    const compiled = compilePlan(
      plan,
      {
        portfolio,
        marketSnapshot: market,
        assumptionSets: [exampleAssumptions(portfolio)],
        policy: parseRoutingPolicy(readJson("docs/harness/model-map.json")),
        libraries: SHIPPED_LIBRARIES,
        catalog: BUILTIN_CATALOG,
      },
      { runId: "RUN-EX", seed: "1", timestamps: { startedAt: "", finishedAt: "" } },
    );
    expect(compiled.compile.passed).toBe(true);
    expect(compiled.request.scenarios.map((s) => s.id)).toEqual(["S0", "S100", "S-100", "S200", "S-200"]);
    // The two catalog stages awaiting an executor say so, in the plan's own
    // words rather than by passing silently (ruling 13). Every behavioral stage
    // that DOES execute licenses at least one binding, so no unbound tag rides.
    expect(compiled.notImplemented.map((n) => n.layer).sort()).toEqual([
      "plan.stage.st-client-rate",
      "plan.stage.st-draw",
    ]);
    compiled.harness.dispose();
  });

  it("walks on the four-position fixture and equals the plan-less result", () => {
    // Acceptance (a), third leg: the same book through the compiled example
    // plan and through the derived default plan, compared on everything except
    // the provenance fields that record WHICH graph ran.
    //
    // The equality bites only if the walked run APPLIES the decay overlay. The
    // shipped fixture set binds the kernel's own term defaults, so a dropped
    // overlay and an applied one give the same numbers and the comparison would
    // pass on a walk that licensed nothing. The DDA decay binding is perturbed
    // here, locally, so an unapplied overlay is a different balance path and a
    // different EVE.
    const plan = parseRunPlan(readJson("docs/harness/example-plan.json")) as RunPlan;
    const portfolio = taggedTwoSidedBook();
    const request = makeRunRequest(market, { assumptionSets: [decayThatBites()] });
    const base = resolveDefaultContext();
    const planLess = buildRunResult(request, portfolio, { ...base, harness: defaultHarness() });

    // The example plan's stage graph over the fixture book: the plan's own
    // selectors name the dimension-row families, so the fixture run reuses the
    // plan's SHAPE with the fixture's licensing, which is what the walker reads.
    const harness = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const walked = buildRunResult(request, portfolio, {
      ...base,
      harness,
      plan: fixturePlanShapedLikeExample(plan),
    });
    harness.dispose();
    expect(JSON.stringify(strip(walked))).toBe(JSON.stringify(strip(planLess)));

    // And the log says the decay stage licensed the binding rather than passing
    // the book through: the shipped stage predicate was CARRIED onto the
    // retargeted stage, so this is the predicate covering a tagged book, not a
    // predicate quietly dropped.
    const log = walked.provenance.runLog ?? [];
    const decay = log.find((e) => e.t === "stage" && e.stageId === "st-decay-nmd");
    expect(decay, "the decay stage ran").toBeDefined();
    expect(decay!.t === "stage" && decay!.skipped).toBeUndefined();
    const license = log.find(
      (e) => e.t === "license" && e.stageId === "st-decay-nmd" && e.familyId === "DDA",
    );
    expect(license, "the DDA decay binding is licensed to the retargeted stage").toBeDefined();
    expect(license!.t === "license" && license!.bindingIndex).toBe(1);
  });

  /**
   * Finding 1, part (i). The walker computes the licensing when the caller
   * hands it a plan the request was not compiled from. A stage predicate that
   * leaves one of the binding's positions uncovered used to have that binding
   * silently dropped, which is an answer with a model missing from it. It is a
   * refusal, built exactly as the compiler's L1 builds it.
   */
  it("refuses a caller-supplied plan whose stage predicate uncovers a binding", () => {
    const plan = fixturePlan();
    plan.stages.find((s) => s.id === "st-decay")!.selector = {
      behavioralClasses: "decay",
      dimensions: { segment: "rate-shopper" },
    };
    // The request's portfolioId is the fixture's, so the segmented book takes
    // that id: the walker refuses a resolved book the request does not name.
    const portfolio = segmentedNmdBook("PF-RUN");
    const request = makeRunRequest(market, { assumptionSets: [baseAssumptions()] });
    const harness = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    let caught: unknown;
    try {
      buildRunResult(request, portfolio, { ...resolveDefaultContext(), harness, plan });
    } catch (err) {
      caught = err;
    }
    harness.dispose();
    expect(caught).toBeInstanceOf(UnlicensedBindingError);
    const e = caught as UnlicensedBindingError;
    expect(e.uncoveredPositionId).toBe("D3");
    expect(e.bindingIndex).toBe(1);
    expect(e.familyId).toBe("DDA");
    expect(e.runLog, "a refusal carries the log the walk had").toBeDefined();
  });
});
