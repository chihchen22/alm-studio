/**
 * Plan and routing-policy routes over a real booted platform (harness Plane 4). The suite boots the SERVER, not a unit router, so a route that is
 * never registered in server.ts fails here with a 404.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CATALOG, type GateReport } from "@alm/engine";
import type {
  AssumptionSet, BehavioralClassId, ChartOfAccounts, PortfolioSpec, Position, ProductFamilyDef, RunPlan,
} from "@alm/engine";
import { bindAssumptions } from "@alm/engine/src/scenario";
import {
  BETA_DEFAULT_PARAMS, fixedPosition, MORTGAGE_DEFAULT_PARAMS, mortgagePosition,
  NMD_B_DEFAULT_PARAMS, NMD_DEFAULT_PARAMS, nmdBetaPosition, nmdPosition,
} from "@alm/engine/src/run/__tests__/fixtures";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, warmCatalog, type TestPlatform } from "./harness";
import { loadOperatorPlugins, OperatorPluginConfigError } from "../plugins/load";
import type { SubmitBody } from "../http/routes/runs";
import { spawnRun } from "../jobs/spawnRun";
import { EXAMPLE_DIMENSION_ROWS } from "@alm/engine/src/plan/__tests__/exampleDimensions";
import type { RunEvent } from "../jobs/types";

/** The book and the assumption set the shipped example plan's selectors bind to. */
const EXAMPLE_BOOK_ID = "example-plan-book-v1";
const EXAMPLE_SETS_ID = "example-plan-sets-v1";

const BEHAVIORAL_CLASS_IDS: readonly string[] = [
  "prepayment", "client-rate-asset", "draw-utilization", "product-mix",
  "new-volume", "decay", "early-withdrawal", "deposit-beta",
];

/**
 * The book the synthetic dimension rows describe (packages/engine/src/plan/__tests__/exampleDimensions.ts): one family per product
 * family, each DECLARING the behavioral classes its rows carry, so the routing
 * gate's R3 and R4 bind the example plan's eight behavioral stages. The seeded
 * vanilla and synthetic books carry no behavioral classes, so neither can stand
 * in for it. The instrument type follows the family's classes, because an
 * overlay kind the instrument cannot consume is refused when the run resolves
 * its assumptions.
 */
function bookDimensionsPortfolio(): PortfolioSpec {
  const doc = { positions: EXAMPLE_DIMENSION_ROWS };
  const families: ProductFamilyDef[] = [];
  const byFamily = new Map<string, ProductFamilyDef>();
  for (const row of doc.positions) {
    const id = row.dims.productFamily;
    let family = byFamily.get(id);
    if (family === undefined) {
      family = {
        id, label: id,
        side: row.dims.side.toLowerCase() === "liability" ? "liability" : "asset",
        instrumentType: "fixed-loan",
        coaNodeId: `node-${families.length}`,
        behavioralClasses: [],
      };
      byFamily.set(id, family);
      families.push(family);
    }
    const classes = family.behavioralClasses!;
    for (const cls of row.dims.behavioralClasses) {
      if (BEHAVIORAL_CLASS_IDS.includes(cls) && !classes.includes(cls as BehavioralClassId)) {
        classes.push(cls as BehavioralClassId);
      }
    }
  }
  const make = {
    "fixed-loan": fixedPosition, mortgage: mortgagePosition, nmd: nmdPosition, "nmd-b": nmdBetaPosition,
  } as Record<string, (id: string) => Position>;
  for (const family of families) {
    const classes = family.behavioralClasses ?? [];
    family.instrumentType = classes.includes("deposit-beta")
      ? "nmd-b"
      : classes.includes("decay")
        ? "nmd"
        : classes.includes("prepayment")
          ? "mortgage"
          : "fixed-loan";
  }
  const positions = doc.positions.map((row) => {
    const family = byFamily.get(row.dims.productFamily)!;
    return {
      ...make[family.instrumentType]!(row.id),
      familyId: family.id,
      coaNodeId: family.coaNodeId,
      // The calibration segment the fixture rows carry. Two of the
      // MMA / Savings rows split rate shoppers from relationship money, so the
      // example plan's decay predicate is exercised on more than one value.
      dimensions: { segment: row.dims.segment },
    };
  });
  const coa: ChartOfAccounts = {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "liabilities", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      ...families.map((f, i) => ({
        id: f.coaNodeId, label: f.label, parentId: f.side === "asset" ? "assets" : "liabilities",
        side: f.side, isLeaf: true, familyId: f.id, order: i,
      })),
    ],
    families,
  };
  return {
    id: EXAMPLE_BOOK_ID, label: "Example dimensions book (example-plan fixture)", asOf: "2026-03-31", coa, positions,
    taxonomy: {
      schemaVersion: "1.0.0", id: "demo-dimensions-v1", label: "Demo dimensions",
      dimensions: [
        { id: "segment", label: "Calibration segment", values: ["Rate shoppers", "Relationship", "Whole book"] },
      ],
    },
  };
}

/**
 * One binding per behavioral stage of the example plan, on the family that
 * stage's selector names. The stages are the licences (L1), so a
 * binding no stage selects, or one two stages select, refuses the compile.
 */
function exampleAssumptions(): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: EXAMPLE_SETS_ID,
    label: "One binding per behavioral stage of the example plan",
    bindings: [
      { familyId: "Mortgages", modelVersion: "x", overlay: { kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS } },
      { familyId: "Fixed Loans", modelVersion: "x", overlay: { kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS } },
      { familyId: "Investments", modelVersion: "x", overlay: { kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS } },
      { familyId: "DDA (Non-Interest)", modelVersion: "x", overlay: { kind: "nmd-decay", params: NMD_DEFAULT_PARAMS } },
      { familyId: "MMA / Savings", modelVersion: "x", overlay: { kind: "deposit-beta", params: BETA_DEFAULT_PARAMS } },
      { familyId: "MMA / Savings", modelVersion: "x", overlay: { kind: "nmd-decay", params: NMD_B_DEFAULT_PARAMS } },
      { familyId: "CDs", modelVersion: "x", overlay: { kind: "cd-rollover", renewalProbability: 0.6, offeredSpreadBp: 25, termMonths: 12 } },
    ],
  };
}

/**
 * The plan the repository ships as its worked example, read from disk, with its
 * `inputs` block pointed at the artifacts this store holds. Nothing else is
 * touched: the stage graph under test is the shipped one, so a stage added to
 * or removed from the example plan moves these assertions with it.
 */
function examplePlanBody(): RunPlan & { inputs: RunPlan["inputs"] } {
  const plan = JSON.parse(
    readFileSync(join(repoRoot(), "docs", "harness", "example-plan.json"), "utf8"),
  ) as RunPlan;
  return {
    ...plan,
    inputs: {
      ...plan.inputs,
      marketSnapshot: SEED_IDS.market,
      positionBook: EXAMPLE_BOOK_ID,
      routingPolicy: SEED_IDS.routingPolicy,
      assumptionSets: [EXAMPLE_SETS_ID],
    },
  };
}

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  const store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  const spec = bookDimensionsPortfolio();
  store.putDocument("portfolios", spec.id, spec, {
    label: spec.label, asOf: spec.asOf, positionCount: spec.positions.length,
  });
  seedAssumptionSet(exampleAssumptions());
});

/** Bind and write one assumption set into the booted platform's store. */
function seedAssumptionSet(set: AssumptionSet): void {
  const bound = bindAssumptions(set);
  new FileStore(t.storeRoot).putDocument("assumption-sets", bound.id, bound, {
    label: bound.label, bindingsContentHash: bound.contentHash, bindingCount: bound.bindings.length,
  });
}
afterAll(() => t.close());

/**
 * The fixture plan over the seeded vanilla book: contractual only, so no
 * behavioral stages. Its metric stages declare exactly what their mounted
 * plugins read (T6 holds a metric to equality since piece 1c), which is why
 * EVE and FTP name a FundingCurve producer: st-tlp, the all-in overlay leg.
 * Position is context-supplied, so no stage produces it.
 */
function vanillaPlan() {
  return {
    schemaVersion: "1.4.0", planId: "PLAN-VANILLA-1", label: "Vanilla book, regulatory grid", authoredBy: "person", asOf: "2026-03-31",
    grid: { horizonMonths: 360 },
    inputs: { marketSnapshot: SEED_IDS.market, positionBook: SEED_IDS.vanillaPortfolio, routingPolicy: "model-map-default-v1", assumptionSets: [SEED_IDS.vanillaAssumptions] },
    stages: [
      { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], params: { dayCount: "ACT/360" } },
      { id: "st-tlp", component: "alm-tlp-overlay", kind: "curve", consumes: ["ZeroCurve", "MarketSnapshot"], produces: ["FundingCurve"], params: { dayCount: "ACT/360" }, dependsOn: ["st-curve"] },
      { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
      { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-term"] },
      { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
      { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"], produces: ["EveResult"], dependsOn: ["st-curve", "st-tlp", "st-cashflow"] },
      { id: "st-gap", component: "alm-gap-analytics", kind: "metric", consumes: ["Cashflow", "RepricingSchedule", "Position"], produces: ["GapResult"], dependsOn: ["st-cashflow"] },
      { id: "st-ftp", component: "engine.metric.ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"], produces: ["FtpResult"], dependsOn: ["st-curve", "st-tlp", "st-term", "st-cashflow", "st-nii"] },
    ],
    scenarios: [{ ref: "regulatory-grid-v1#S0" }, { ref: "regulatory-grid-v1#S100" }, { ref: "regulatory-grid-v1#S-100" }, { ref: "regulatory-grid-v1#S200" }, { ref: "regulatory-grid-v1#S-200" }],
    reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
    validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
  };
}

/** The first scenario id of a plan: an inline id, or the text after "#" in a ref. */
function scenarioIdOfFirst(p: { scenarios: Array<{ id?: string; ref?: string }> }): string {
  const s = p.scenarios[0]!;
  return s.ref !== undefined ? s.ref.slice(s.ref.indexOf("#") + 1) : s.id!;
}

describe("plan routes", () => {
  it("seeds the routing policy and lists it", async () => {
    const r = await api<Array<{ id: string }>>(t.base, "GET", "/api/routing-policies");
    expect(r.status).toBe(200);
    expect(r.body.map((p) => p.id)).toContain("model-map-default-v1");
  });
  it("serves the shipped scenario library", async () => {
    const r = await api<Array<{ id: string }>>(t.base, "GET", "/api/plans/library");
    expect(r.body.map((l) => l.id)).toContain("regulatory-grid-v1");
  });
  it("validates the vanilla plan: both gates pass", async () => {
    const r = await api<{ type: GateReport; routing: GateReport }>(t.base, "POST", "/api/plans/validate", { plan: vanillaPlan() });
    expect(r.status).toBe(200);
    expect(r.body.type.passed).toBe(true);
    expect(r.body.routing.passed).toBe(true);
  });
  it("reports a T4 failure on an unresolved dependsOn with HTTP 200", async () => {
    const p = vanillaPlan();
    p.stages.find((s) => s.id === "st-term")!.dependsOn = ["st-nowhere"];
    const r = await api<{ type: GateReport }>(t.base, "POST", "/api/plans/validate", { plan: p });
    expect(r.status).toBe(200);
    expect(r.body.type.failures[0]!.rule).toBe("T4");
    expect(r.body.type.failures[0]!.stageId).toBe("st-term");
  });
  it("returns 422 naming the field on a malformed plan", async () => {
    // parseRunPlan reports the FIRST field that fails, and it checks
    // schemaVersion/authoredBy/grid/inputs before planId; dropping planId from
    // an otherwise valid plan is what puts planId in the message.
    const { planId, ...noPlanId } = vanillaPlan();
    expect(planId).toBe("PLAN-VANILLA-1");
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/plans/validate", { plan: noPlanId });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("planId");
  });
  it("returns 422 naming the field on a plan that is only a schemaVersion", async () => {
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/plans/validate", { plan: { schemaVersion: "1.4.0" } });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("authoredBy");
  });
  it("runs the vanilla plan and stamps the plan into the stored request", async () => {
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: vanillaPlan(), label: "via plan" });
    expect(r.status).toBe(202);
    const stored = JSON.parse(readFileSync(join(t.storeRoot, "runs", r.body.runId, "request.json"), "utf8"));
    expect(stored.request.plan.planId).toBe("PLAN-VANILLA-1");
    expect(stored.submission.scenarioSlateId).toBe("plan-PLAN-VANILLA-1");
  });
  it("refuses to run a rejected plan with 422 and both reports", async () => {
    const p = vanillaPlan();
    p.grid.horizonMonths = 0;
    const r = await api<{ error: { code: string; detail: { type: GateReport } } }>(t.base, "POST", "/api/plans/run", { plan: p });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plan_rejected");
    expect(r.body.error.detail.type.failures[0]!.rule).toBe("T3");
  });
  it("registers on the real server, not only in a unit router", async () => {
    const r = await api(t.base, "GET", "/api/plans/library");
    expect(r.status).toBe(200);
  });
});

describe("plan tags reach the envelope", () => {
  /**
   * The vanilla plan plus one stage the run pipeline does not execute. It sits
   * in the NII metric's dependsOn so T5 sees it reach a metric, and it produces
   * a type NOTHING consumes, which is the shape ruling 13 tags rather than
   * refuses. It may not stand between st-term and st-cashflow: since piece 1c
   * an edge resolves against the DIRECT dependsOn, so two RatePath producers
   * there would be a T1 refusal rather than a tag.
   */
  function hullWhitePlan() {
    const p = vanillaPlan();
    p.planId = "PLAN-HW-1";
    p.label = "Vanilla book plus a declared Hull-White stage";
    p.stages.splice(2, 0, {
      id: "st-hw", component: "alm-hull-white", kind: "term-structure",
      consumes: ["ZeroCurve", "CapVolSurface"], produces: ["ClientRatePath"], dependsOn: ["st-curve"],
    } as (typeof p.stages)[number]);
    const nii = p.stages.find((s) => s.id === "st-nii")!;
    nii.dependsOn = [...(nii.dependsOn ?? []), "st-hw"];
    return p;
  }

  /** The same stage, but now the only producer of a type the NII metric reads. */
  function loadBearingHullWhitePlan() {
    const p = hullWhitePlan();
    p.planId = "PLAN-HW-2";
    p.label = "Vanilla book whose NII depends on the Hull-White stage";
    const nii = p.stages.find((s) => s.id === "st-nii")!;
    nii.consumes = [...nii.consumes, "ClientRatePath"] as (typeof nii.consumes);
    return p;
  }

  it("echoes the compile-time tag, stores it, and merges it into the served result", async () => {
    const r = await api<{ runId: string; notImplemented: Array<{ layer: string; reason: string }> }>(
      t.base, "POST", "/api/plans/run", { plan: hullWhitePlan(), label: "hull-white declared" },
    );
    expect(r.status).toBe(202);
    const layers = r.body.notImplemented.map((n) => n.layer);
    expect(layers).toContain("plan.stage.st-hw");

    const stored = JSON.parse(readFileSync(join(t.storeRoot, "runs", r.body.runId, "request.json"), "utf8"));
    expect(stored.planTags.map((n: { layer: string }) => n.layer)).toContain("plan.stage.st-hw");

    // The vanilla book is nine positions, so waiting out the child is cheap.
    const done = await waitFor(
      () => api<{ state: string }>(t.base, "GET", `/api/runs/${r.body.runId}`).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      90_000,
    );
    expect(done.state).toBe("done");
    const section = await api<Array<{ layer: string }>>(
      t.base, "GET", `/api/runs/${r.body.runId}/result/notImplemented`,
    );
    expect(section.status).toBe(200);
    expect(section.body.map((n) => n.layer)).toContain("plan.stage.st-hw");
  }, 120_000);

  /**
   * The other half of ruling 13: the same unexecuted stage stops being a tag
   * and becomes a refusal the moment a metric reads a type only it produces,
   * so nothing downstream can read as a run that covered it.
   */
  it("refuses the plan when a metric depends on a stage no mounted plugin executes", async () => {
    const r = await api<{ error: { message: string } }>(
      t.base, "POST", "/api/plans/run", { plan: loadBearingHullWhitePlan(), label: "hull-white load bearing" },
    );
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("st-hw");
    expect(r.body.error.message).toContain("alm-hull-white");
  });

  it("stores no planTags on a plain /api/runs submission", async () => {
    const r = await api<{ runId: string }>(t.base, "POST", "/api/runs", {
      portfolioId: SEED_IDS.vanillaPortfolio,
      marketId: SEED_IDS.market,
      scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    });
    expect(r.status).toBe(202);
    const stored = JSON.parse(readFileSync(join(t.storeRoot, "runs", r.body.runId, "request.json"), "utf8"));
    expect(stored.planTags).toBeUndefined();
    expect(stored.request.plan).toBeUndefined();
  });
});

describe("routing policy writes", () => {
  function seededPolicy(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(repoRoot(), "docs", "harness", "model-map.json"), "utf8"));
  }

  it("accepts a valid policy under a new id with 201", async () => {
    const policy = { ...seededPolicy(), id: "model-map-test-clone-v1", label: "Cloned policy (test)" };
    const r = await api<{ id: string }>(t.base, "POST", "/api/routing-policies", { policy });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe("model-map-test-clone-v1");
    const list = await api<Array<{ id: string }>>(t.base, "GET", "/api/routing-policies");
    expect(list.body.map((p) => p.id)).toContain("model-map-test-clone-v1");
  });

  it("refuses a malformed policy with 422 naming the field", async () => {
    const policy = seededPolicy();
    delete policy.classes;
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/routing-policies", { policy });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("classes");
  });

  it("refuses to overwrite the seeded policy id with 409", async () => {
    const r = await api<{ error: { code: string; message: string } }>(
      t.base, "POST", "/api/routing-policies", { policy: seededPolicy() },
    );
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("model-map-default-v1");
  });
});

describe("plan-run scenario slates are append-only", () => {
  it("refuses a second plan carrying the same id but different scenarios with 409", async () => {
    const first = vanillaPlan();
    first.planId = "PLAN-SLATE-1";
    expect((await api(t.base, "POST", "/api/plans/run", { plan: first })).status).toBe(202);

    const second = vanillaPlan();
    second.planId = "PLAN-SLATE-1";
    second.scenarios = [{ ref: "regulatory-grid-v1#S0" }, { ref: "regulatory-grid-v1#S100" }];
    const r = await api<{ error: { code: string; message: string } }>(
      t.base, "POST", "/api/plans/run", { plan: second },
    );
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("plan-PLAN-SLATE-1");
  }, 30_000);
});

describe("a plan run's launch slate is mirrored at once", () => {
  it("answers on the catalog lineage read with no re-sync", async () => {
    await warmCatalog(t.base);
    const p = vanillaPlan();
    p.planId = "PLAN-MIRROR-1";
    expect((await api(t.base, "POST", "/api/plans/run", { plan: p })).status).toBe(202);
    const lin = await api<{ collection: string; id: string }>(t.base, "GET", "/api/catalog/lineage/scenario-slates/plan-PLAN-MIRROR-1");
    expect(lin.status).toBe(200);
    expect(lin.body).toMatchObject({ collection: "scenario-slates", id: "plan-PLAN-MIRROR-1" });
  }, 30_000);
});

describe("balance plans", () => {
  /** A flat target on a family of the seeded vanilla book, at its opening balance. */
  function flatBalancePlan(id: string) {
    const store = new FileStore(t.storeRoot);
    const spec = store.getDocument<{
      positions: Array<{ familyId: string; terms: { notional: number } }>;
    }>("portfolios", SEED_IDS.vanillaPortfolio).doc;
    const familyId = spec.positions[0]!.familyId;
    const opening = spec.positions
      .filter((p) => p.familyId === familyId)
      .reduce((a, p) => a + p.terms.notional, 0);
    return {
      schemaVersion: "1.0.0", id, label: `Flat ${familyId} (test)`, asOf: "2026-03-31",
      targets: [{
        familyId,
        path: [{ month: 12, balance: opening }, { month: 60, balance: opening }],
        newBusinessPricing: { spreadOverIndexBp: 150, termMonths: 60 },
      }],
      unlistedFamilies: "runoff",
    };
  }

  it("accepts a balance plan with 201 and lists it", async () => {
    const r = await api<{ id: string }>(t.base, "POST", "/api/balance-plans", {
      balancePlan: flatBalancePlan("bp-flat-v1"),
    });
    expect(r.status).toBe(201);
    const list = await api<Array<{ id: string }>>(t.base, "GET", "/api/balance-plans");
    expect(list.body.map((b) => b.id)).toContain("bp-flat-v1");
  });

  it("refuses a malformed balance plan with 422 naming the field", async () => {
    const bad = flatBalancePlan("bp-bad-v1") as Record<string, unknown>;
    (bad.targets as Array<Record<string, unknown>>)[0]!.newBusinessPricing = { spreadOverIndexBp: "150", termMonths: 60 };
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/balance-plans", { balancePlan: bad });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("newBusinessPricing.spreadOverIndexBp");
  });

  it("refuses a repeated balance-plan id with 409", async () => {
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/balance-plans", {
      balancePlan: flatBalancePlan("bp-flat-v1"),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain("bp-flat-v1");
  });

  it("serves one stored balance plan's body, and 404 for an unknown id", async () => {
    const r = await api<{ id: string; asOf: string; targets: unknown[] }>(t.base, "GET", "/api/balance-plans/bp-flat-v1");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("bp-flat-v1");
    expect(r.body.asOf).toBe("2026-03-31");
    expect(r.body.targets).toHaveLength(1);
    const missing = await api(t.base, "GET", "/api/balance-plans/bp-nope");
    expect(missing.status).toBe(404);
  });

  it("lists each balance plan with its as-of", async () => {
    const list = await api<Array<{ id: string; asOf: string }>>(t.base, "GET", "/api/balance-plans");
    expect(list.body.find((b) => b.id === "bp-flat-v1")?.asOf).toBe("2026-03-31");
  });

  it("resolves scenarioBalancePlans and refuses an unknown mapped id with 422", async () => {
    const p = vanillaPlan() as ReturnType<typeof vanillaPlan> & { scenarioBalancePlans?: Record<string, string> };
    p.planId = "PLAN-BALANCE-MAP-BAD";
    p.scenarioBalancePlans = { [scenarioIdOfFirst(p)]: "bp-nope" };
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/plans/run", { plan: p });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('unknown balance plan "bp-nope"');
  });

  it("runs a plan whose one scenario maps to the stored balance plan", async () => {
    const p = vanillaPlan() as ReturnType<typeof vanillaPlan> & { scenarioBalancePlans?: Record<string, string> };
    p.planId = "PLAN-BALANCE-MAP-1";
    const first = scenarioIdOfFirst(p);
    p.scenarioBalancePlans = { [first]: "bp-flat-v1" };
    p.stages.push({
      id: "st-balance", component: "engine.balance-plan", kind: "balance-new-business",
      consumes: ["Position", "RatePath", "Cashflow"], produces: ["Cashflow"], dependsOn: ["st-cashflow", "st-term"],
    } as (typeof p.stages)[number]);
    p.stages.find((s) => s.id === "st-nii")!.dependsOn = ["st-balance"];
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: p });
    expect(r.status).toBe(202);
    const stored = JSON.parse(readFileSync(join(t.storeRoot, "runs", r.body.runId, "request.json"), "utf8"));
    expect(Object.keys(stored.request.plan.scenarioBalancePlanHashes)).toEqual([first]);
    expect(stored.request.scenarios[0].newBusiness.mode).toBe("dynamic");
    expect(stored.request.scenarios.slice(1).every((s: { newBusiness: { mode: string } }) => s.newBusiness.mode === "static")).toBe(true);
  }, 30_000);

  it("runs a plan that references the stored balance plan", async () => {
    const p = vanillaPlan() as ReturnType<typeof vanillaPlan> & { balancePlan?: string };
    p.planId = "PLAN-BALANCE-1";
    p.balancePlan = "bp-flat-v1";
    p.stages.push({
      id: "st-balance", component: "engine.balance-plan", kind: "balance-new-business",
      consumes: ["Position", "RatePath", "Cashflow"], produces: ["Cashflow"],
      dependsOn: ["st-cashflow", "st-term"],
    } as (typeof p.stages)[number]);
    // T5: a stage that reaches no metric is an orphan, so the NII metric reads
    // the new-business cashflows. It reads them from the balance stage ALONE:
    // an edge resolves against the direct dependsOn, so naming the contractual
    // stage there too would be two Cashflow producers on one edge, which T1
    // refuses. The balance stage reads the contractual series itself.
    p.stages.find((s) => s.id === "st-nii")!.dependsOn = ["st-balance"];
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: p });
    expect(r.status).toBe(202);
    const stored = JSON.parse(readFileSync(join(t.storeRoot, "runs", r.body.runId, "request.json"), "utf8"));
    expect(stored.request.plan.planId).toBe("PLAN-BALANCE-1");
    expect(stored.request.scenarios[0].newBusiness.mode).toBe("dynamic");
  }, 30_000);
});

describe("the submit body's plan block stays additive", () => {
  it("accepts a plan block written before ruling 14's hashes existed", () => {
    // Compile-time assertion first: the old two-field shape must still satisfy
    // SubmitBody["plan"], which is why policyHash is optional on PlanRef.
    const legacy: SubmitBody["plan"] = { planId: "PLAN-OLD-1", planHash: "a".repeat(64) };
    expect(legacy.policyHash).toBeUndefined();
    expect(legacy.balancePlanHash).toBeUndefined();
  });
});

/**
 * The validate route now compiles through the mounted
 * profile, so a refusal the gates cannot express (a profile that will not
 * mount, a scenario that cannot run, a stage no plugin executes) is reported as
 * a compile block at 200 rather than escaping as a 500.
 */
describe("POST /api/plans/validate compile block", () => {
  it("reports compile passed for a plan that both gates accept", async () => {
    const r = await api<{ type: GateReport; routing: GateReport; compile: unknown; profileHash: string }>(
      t.base, "POST", "/api/plans/validate", { plan: vanillaPlan() },
    );
    expect(r.status).toBe(200);
    expect(r.body.type.passed).toBe(true);
    expect(r.body.routing.passed).toBe(true);
    expect(r.body.compile).toEqual({ passed: true });
    expect(r.body.profileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a profile mount refusal in the compile block, not as a 500", async () => {
    const p = vanillaPlan() as ReturnType<typeof vanillaPlan> & { profile?: unknown };
    p.profile = { rows: [{ id: "r-ghost", plugin: "acme.not.installed" }] };
    const r = await api<{
      type: GateReport; routing: GateReport;
      compile: { passed: boolean; detail: string; error: string };
      runLog: Array<{ t: string; profileHash?: string }>;
    }>(t.base, "POST", "/api/plans/validate", { plan: p });
    expect(r.status).toBe(200);
    expect(r.body.compile.passed).toBe(false);
    expect(r.body.compile.detail).toContain("acme.not.installed");
    expect(r.body.compile.error).toBe("PlanRejected");
    // The tree never mounted, so neither gate ran. Both reports SAY that,
    // rather than reporting a pass nobody checked.
    for (const report of [r.body.type, r.body.routing]) {
      expect(report.passed).toBe(false);
      expect(report.failures).toEqual([]);
      expect(report.checked).toHaveLength(1);
      expect(report.checked[0]).toContain("gate not run");
      expect(report.checked[0]).toContain("acme.not.installed");
    }
    // A mount refusal still carries the profile it tried and the kernel's word.
    expect(r.body.runLog[0]!.t).toBe("profile");
    expect(r.body.runLog.some((e) => e.t === "refuse")).toBe(true);
  });

  it("reports a scenario refusal in the compile block when both gates pass", async () => {
    const p = vanillaPlan();
    p.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" } },
      { id: "R200", label: "R200", rateSpec: { kind: "parallel", shockBp: 200 }, timing: { kind: "ramp", months: 12 } },
    ] as unknown as (typeof p.scenarios);
    const r = await api<{
      type: GateReport; routing: GateReport; compile: { passed: boolean; detail: string; error: string };
      runLog: Array<{ t: string; error?: string }>;
    }>(t.base, "POST", "/api/plans/validate", { plan: p });
    expect(r.status).toBe(200);
    expect(r.body.type.passed).toBe(true);
    expect(r.body.routing.passed).toBe(true);
    expect(r.body.compile.passed).toBe(false);
    expect(r.body.compile.detail).toContain("R200");
    expect(r.body.compile.error).toBe("ScenarioNotExecutableError");
    // A refused compile carries the log it had written, refuse entry included.
    expect(r.body.runLog[0]!.t).toBe("profile");
    expect(r.body.runLog.some((e) => e.t === "refuse" && (e.error ?? "").includes("R200"))).toBe(true);
  });

  it("reports an unmounted component in the compile block naming the stage", async () => {
    const p = vanillaPlan();
    p.stages.push({
      id: "st-hw", component: "alm-hull-white", kind: "term-structure",
      consumes: ["ZeroCurve", "CapVolSurface"], produces: ["ClientRatePath"], dependsOn: ["st-curve"],
    } as (typeof p.stages)[number]);
    const nii = p.stages.find((s) => s.id === "st-nii")!;
    nii.consumes = [...nii.consumes, "ClientRatePath"] as (typeof nii.consumes);
    nii.dependsOn = [...(nii.dependsOn ?? []), "st-hw"];
    const r = await api<{
      type: GateReport; routing: GateReport;
      compile: { passed: boolean; detail: string; error: string };
    }>(t.base, "POST", "/api/plans/validate", { plan: p });
    expect(r.status).toBe(200);
    expect(r.body.compile.passed).toBe(false);
    expect(r.body.compile.detail).toContain("st-hw");
    expect(r.body.compile.error).toBe("PlanNotExecutableError");
    // Both waterfalls ran before the stage refusal, so the reports are the REAL
    // ones: the type gate saw the same unmounted stage and raised T1 against
    // it. The old fallback reported type.passed: true here.
    expect(r.body.type.passed).toBe(false);
    expect(r.body.type.failures.map((f) => `${f.rule}@${f.stageId}`)).toContain("T1@st-hw");
    expect(r.body.routing.passed).toBe(true);
    expect(r.body.routing.checked.length).toBeGreaterThan(0);
  });

  /**
   * The case the synthesized-pass fallback got wrong: the stage refusal is
   * raised BEFORE compile checks whether the gates passed, so a plan that is
   * both mistyped and unexecutable used to be reported as type.passed: true.
   */
  it("reports the real type failure when a gate ALSO failed under a stage refusal", async () => {
    const p = vanillaPlan();
    p.grid.horizonMonths = 0; // T3
    p.stages.push({
      id: "st-hw", component: "alm-hull-white", kind: "term-structure",
      consumes: ["ZeroCurve", "CapVolSurface"], produces: ["ClientRatePath"], dependsOn: ["st-curve"],
    } as (typeof p.stages)[number]);
    const nii = p.stages.find((s) => s.id === "st-nii")!;
    nii.consumes = [...nii.consumes, "ClientRatePath"] as (typeof nii.consumes);
    nii.dependsOn = [...(nii.dependsOn ?? []), "st-hw"];
    const r = await api<{
      type: GateReport; routing: GateReport;
      compile: { passed: boolean; detail: string; error: string };
    }>(t.base, "POST", "/api/plans/validate", { plan: p });
    expect(r.status).toBe(200);
    expect(r.body.compile.error).toBe("PlanNotExecutableError");
    expect(r.body.compile.detail).toContain("st-hw");
    expect(r.body.type.passed).toBe(false);
    // Both the grid rule and the unmounted-stage rule, from the report the
    // waterfall actually produced.
    expect(r.body.type.failures.map((f) => f.rule)).toContain("T3");
    expect(r.body.type.failures.map((f) => `${f.rule}@${f.stageId}`)).toContain("T1@st-hw");
  });
});

describe("POST /api/plans/run: patch layers, the base-scenario rule, and the envelope", () => {
  it("refuses a plan whose scenarios carry no base scenario, before writing a slate", async () => {
    const p = vanillaPlan();
    p.planId = "PLAN-NO-BASE";
    p.scenarios = [{ id: "S100", label: "S100", rateSpec: { kind: "parallel", shockBp: 100 } }] as unknown as (typeof p.scenarios);
    const r = await api<{ error: { code: string; message: string } }>(t.base, "POST", "/api/plans/run", { plan: p });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plan_not_runnable");
    expect(r.body.error.message).toContain("exactly one base scenario");
    const slates = await api<Array<{ id: string }>>(t.base, "GET", "/api/scenario-slates");
    expect(slates.body.some((s) => s.id === "plan-PLAN-NO-BASE")).toBe(false);
  });

  it("refuses a plan carrying two base scenarios, naming both", async () => {
    const p = vanillaPlan();
    p.planId = "PLAN-TWO-BASE";
    p.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" } },
      { id: "S0b", label: "S0b", rateSpec: { kind: "base" } },
    ] as unknown as (typeof p.scenarios);
    const r = await api<{ error: { code: string; message: string } }>(t.base, "POST", "/api/plans/run", { plan: p });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plan_not_runnable");
    expect(r.body.error.message).toContain("S0");
    expect(r.body.error.message).toContain("S0b");
    const slates = await api<Array<{ id: string }>>(t.base, "GET", "/api/scenario-slates");
    expect(slates.body.some((s) => s.id === "plan-PLAN-TWO-BASE")).toBe(false);
  });

  it("applies request patch layers after the plan's own rows", async () => {
    const patched = vanillaPlan();
    patched.planId = "PLAN-PATCHED";
    const r = await api<{ runId: string; profileHash: string }>(t.base, "POST", "/api/plans/run", {
      plan: patched,
      patches: [{ label: "no-ftp", patches: [{ disable: "metric.ftp" }] }],
    });
    expect(r.status).toBe(202);
    expect(r.body.profileHash).toMatch(/^[0-9a-f]{64}$/);

    const plainPlan = vanillaPlan();
    plainPlan.planId = "PLAN-PLAIN";
    const plain = await api<{ runId: string; profileHash: string }>(
      t.base, "POST", "/api/plans/run", { plan: plainPlan },
    );
    expect(plain.status).toBe(202);
    expect(r.body.profileHash).not.toBe(plain.body.profileHash);

    // The composed profile, not only its hash, is persisted for the child: the
    // run that computes the numbers mounts the same rows the gates ran on.
    const stored = JSON.parse(readFileSync(join(t.storeRoot, "runs", r.body.runId, "request.json"), "utf8"));
    expect(stored.profileHash).toBe(r.body.profileHash);
    const ftpRow = stored.profile.rows.find((row: { id: string }) => row.id === "metric.ftp");
    expect(ftpRow.disabled).toBe(true);
    const plainStored = JSON.parse(readFileSync(join(t.storeRoot, "runs", plain.body.runId, "request.json"), "utf8"));
    expect(plainStored.profile.rows.find((row: { id: string }) => row.id === "metric.ftp").disabled).toBeUndefined();

    // The proof that the persisted profile reaches the CHILD, where the numbers
    // are computed. Both runs walk the same plan, whose st-ftp stage names the
    // FTP plugin; the CHILD decides which stages are executable against the
    // profile IT mounted. With the row switched off, st-ftp is walked as
    // not-executable and the envelope carries no ftp block; on the default rows
    // the same stage executes and the block is there. A child that quietly fell
    // back to the built-in default would have computed an FTP block the
    // submitter had switched off.
    const endOf = (runId: string) =>
      waitFor(
        () => api<{ state: string; error?: { message: string; detail?: string } }>(
          t.base, "GET", `/api/runs/${runId}`,
        ).then((x) => x.body),
        (s) => s.state === "done" || s.state === "error",
        90_000,
      );
    const resultOf = (runId: string) =>
      JSON.parse(readFileSync(join(t.storeRoot, "runs", runId, "result.json"), "utf8")) as {
        ftp?: unknown;
        provenance: { runLog: Array<{ t: string; stageId?: string; skipped?: string }> };
      };
    const ftpStage = (runId: string) =>
      resultOf(runId).provenance.runLog.find((e) => e.t === "stage" && e.stageId === "st-ftp");

    const patchedEnd = await endOf(r.body.runId);
    expect(patchedEnd.state, JSON.stringify(patchedEnd.error)).toBe("done");
    expect(ftpStage(r.body.runId)?.skipped).toBe("not-executable");
    expect(resultOf(r.body.runId).ftp).toBeUndefined();

    const plainEnd = await endOf(plain.body.runId);
    expect(plainEnd.state).toBe("done");
    expect(ftpStage(plain.body.runId)?.skipped).toBeUndefined();
    expect(resultOf(plain.body.runId).ftp).toBeDefined();
  }, 180_000);

  it("GET /result/ftp on a run whose plan had no FTP stage answers 404 with the neutral reason (slice three decision 123)", async () => {
    const p = vanillaPlan();
    p.planId = "PLAN-NO-FTP";
    p.stages = p.stages.filter((s) => !s.produces.includes("FtpResult"));
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: p });
    expect(r.status, r.text).toBe(202);
    const end = await waitFor(
      () => api<{ state: string }>(t.base, "GET", `/api/runs/${r.body.runId}`),
      (s) => s.body.state === "done" || s.body.state === "error",
      90_000,
    );
    expect(end.body.state, end.text).toBe("done");
    const ftp = await api<{ error: { message: string } }>(t.base, "GET", `/api/runs/${r.body.runId}/result/ftp`);
    expect(ftp.status).toBe(404);
    expect(ftp.body.error.message).toBe(
      `the run carries no ftp block: its plan had no FTP stage, its book is seasoned, or it predates the block (run "${r.body.runId}")`,
    );
  }, 120_000);

  it("refuses a patch naming a row the profile does not have, naming the layer", async () => {
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/plans/run", {
      plan: vanillaPlan(),
      patches: [{ label: "typo-layer", patches: [{ disable: "metric.nii-typo" }] }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("typo-layer");
    expect(r.body.error.message).toContain("metric.nii-typo");
  });

  it("carries the profile hash and the compile-time run log on the 202 envelope", async () => {
    const p = vanillaPlan();
    p.planId = "PLAN-LOG";
    const r = await api<{ runId: string; profileHash: string; runLog: Array<{ t: string }> }>(
      t.base, "POST", "/api/plans/run", { plan: p },
    );
    expect(r.status).toBe(202);
    expect(r.body.profileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(r.body.runLog)).toBe(true);
    expect(r.body.runLog[0]!.t).toBe("profile");
    expect(r.body.runLog.some((e) => e.t === "gate")).toBe(true);
    const stored = JSON.parse(readFileSync(join(t.storeRoot, "runs", r.body.runId, "request.json"), "utf8"));
    expect(stored.planRunLog[0].t).toBe("profile");
  }, 30_000);
});

/**
 * Final fix wave. The 422 detail on a run refusal, the patch layers at
 * validate, and the profile pin the runner child checks before it mounts.
 */
describe("a run refusal never reports a gate that did not run", () => {
  it("fills the 422 detail with not-run reports when the profile will not mount", async () => {
    const p = vanillaPlan() as ReturnType<typeof vanillaPlan> & { profile?: unknown };
    p.planId = "PLAN-GHOST-PROFILE";
    p.profile = { rows: [{ id: "r-ghost", plugin: "acme.not.installed" }] };
    const r = await api<{ error: { code: string; message: string; detail: { type: GateReport; routing: GateReport } } }>(
      t.base, "POST", "/api/plans/run", { plan: p },
    );
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plan_rejected");
    // The tree never mounted, so neither waterfall ran. PlanRejected carries
    // the EMPTY reports its constructor was handed, and those read passed:true;
    // echoing them into the detail would show the Plan page two green gates.
    for (const report of [r.body.error.detail.type, r.body.error.detail.routing]) {
      expect(report.passed).toBe(false);
      expect(report.failures).toEqual([]);
      expect(report.checked).toHaveLength(1);
      expect(report.checked[0]).toContain("gate not run");
      expect(report.checked[0]).toContain("acme.not.installed");
    }
    // Nothing was written for a plan that never compiled.
    const slates = await api<Array<{ id: string }>>(t.base, "GET", "/api/scenario-slates");
    expect(slates.body.some((x) => x.id === "plan-PLAN-GHOST-PROFILE")).toBe(false);
  });

  it("still carries the REAL reports in the detail when the gates did run", async () => {
    const p = vanillaPlan();
    p.planId = "PLAN-REAL-REPORTS";
    p.grid.horizonMonths = 0; // T3
    const r = await api<{ error: { detail: { type: GateReport; routing: GateReport } } }>(
      t.base, "POST", "/api/plans/run", { plan: p },
    );
    expect(r.status).toBe(422);
    expect(r.body.error.detail.type.failures.map((f) => f.rule)).toContain("T3");
    expect(r.body.error.detail.routing.checked.length).toBeGreaterThan(0);
  });
});

describe("POST /api/plans/validate composes the request's patch layers", () => {
  it("validates the PATCHED tree: a disabling layer turns the compile block into a refusal", async () => {
    const plain = await api<{ compile: unknown; profileHash: string }>(
      t.base, "POST", "/api/plans/validate", { plan: vanillaPlan() },
    );
    expect(plain.status).toBe(200);
    expect(plain.body.compile).toEqual({ passed: true });

    // The contractual pass is the only producer of RepricingSchedule, which the
    // gap metric reads, so switching its row off makes the plan unexecutable.
    const patched = await api<{
      compile: { passed: boolean; detail: string; error: string };
      runLog: Array<{ t: string; profileHash?: string }>;
    }>(t.base, "POST", "/api/plans/validate", {
      plan: vanillaPlan(),
      patches: [{ label: "no-contractual", patches: [{ disable: "contractual" }] }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.compile.passed).toBe(false);
    expect(patched.body.compile.error).toBe("PlanNotExecutableError");
    expect(patched.body.compile.detail).toContain("st-cashflow");
    // The tree the refusal was raised against is the PATCHED one, so the hash
    // the compile logged differs from the unpatched call's.
    expect(patched.body.runLog[0]!.t).toBe("profile");
    expect(patched.body.runLog[0]!.profileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(patched.body.runLog[0]!.profileHash).not.toBe(plain.body.profileHash);
  });

  it("reports the patched profile and hash on a layer the plan still compiles under", async () => {
    const plain = await api<{ profileHash: string; profile: { rows: Array<{ id: string; disabled?: boolean }> } }>(
      t.base, "POST", "/api/plans/validate", { plan: vanillaPlan() },
    );
    const patched = await api<{
      compile: unknown; profileHash: string; profile: { rows: Array<{ id: string; disabled?: boolean }> };
    }>(t.base, "POST", "/api/plans/validate", {
      plan: vanillaPlan(),
      patches: [{ label: "no-ftp", patches: [{ disable: "metric.ftp" }] }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.compile).toEqual({ passed: true });
    expect(patched.body.profileHash).not.toBe(plain.body.profileHash);
    expect(patched.body.profile.rows.find((row) => row.id === "metric.ftp")!.disabled).toBe(true);
    expect(plain.body.profile.rows.find((row) => row.id === "metric.ftp")!.disabled).toBeUndefined();
  });

  it("refuses a malformed patch layer at validate, naming the layer", async () => {
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/plans/validate", {
      plan: vanillaPlan(),
      patches: [{ label: "", patches: [] }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("patches[0].label");
  });
});

/**
 * Final fix wave, finding 3. The child pins the PROFILE the way it already
 * pins the portfolio: the rows on disk must hash to the hash the submission
 * recorded, or the run would compute on one tree and stamp another into
 * provenance. Driven through the real child, spawned on a run directory whose
 * profile row was edited after the submission wrote it.
 */
describe("the runner child checks the profile against the pinned hash", () => {
  /** Copy a submitted run directory, passing its request.json through `edit`. */
  function forkRunDir(runId: string, into: string, edit: (stored: Record<string, unknown>) => void): string {
    const dir = join(t.storeRoot, "runs", into);
    mkdirSync(dir, { recursive: true });
    const stored = JSON.parse(readFileSync(join(t.storeRoot, "runs", runId, "request.json"), "utf8"));
    edit(stored);
    writeFileSync(join(dir, "request.json"), JSON.stringify(stored));
    return dir;
  }

  /** Run the real child to exit, returning every protocol event it printed. */
  function runChild(dir: string): Promise<{ code: number | null; events: RunEvent[] }> {
    return new Promise((resolve) => {
      const events: RunEvent[] = [];
      spawnRun(dir, repoRoot(), {
        onEvent: (e) => events.push(e),
        onExit: ({ code }) => resolve({ code, events }),
      });
    });
  }

  let runId: string;
  beforeAll(async () => {
    const p = vanillaPlan();
    p.planId = "PLAN-PROFILE-PIN";
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: p });
    expect(r.status).toBe(202);
    runId = r.body.runId;
  }, 30_000);

  it("refuses a run whose profile rows were edited after the hash was pinned", async () => {
    const dir = forkRunDir(runId, "tampered-profile", (stored) => {
      const profile = stored.profile as { rows: Array<{ id: string; disabled?: boolean }> };
      // One row switched off after the gates ran: the hash no longer describes
      // the tree, and mounting it would answer a different question.
      profile.rows.find((row) => row.id === "metric.ftp")!.disabled = true;
    });
    const { code, events } = await runChild(dir);
    expect(code).not.toBe(0);
    const error = events.find((e) => e.t === "error") as { t: "error"; message: string } | undefined;
    expect(error).toBeDefined();
    expect(error!.message).toContain("profile hash mismatch");
    // Both hashes are named, so the operator can tell which side moved.
    const pinned = JSON.parse(readFileSync(join(t.storeRoot, "runs", runId, "request.json"), "utf8")).profileHash;
    expect(error!.message).toContain(pinned);
    expect(error!.message).toMatch(/on disk hash [0-9a-f]{64}/);
    // It refused before mounting, so no result landed.
    expect(existsSync(join(dir, "result.json"))).toBe(false);
  }, 60_000);

  it("runs a stored request whose profile still agrees with its hash", async () => {
    const dir = forkRunDir(runId, "untampered-profile", () => {});
    const { code, events } = await runChild(dir);
    expect(events.find((e) => e.t === "error")).toBeUndefined();
    expect(code).toBe(0);
    expect(existsSync(join(dir, "result.json"))).toBe(true);
  }, 120_000);
});

describe("operator plugin loading", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alm-operator-plugins-"));
  });
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("loads nothing and refuses nothing when var/plugins.json lists no plugin", () => {
    const loaded = loadOperatorPlugins(join(repoRoot(), "var", "plugins.json"));
    expect(loaded.catalog.size).toBe(BUILTIN_CATALOG.size);
    expect([...loaded.sources.values()].every((s) => s === "builtin")).toBe(true);
  });

  it("runs the built-ins when there is no config file at all", () => {
    const loaded = loadOperatorPlugins(join(tmpDir, "no-such-config.json"));
    expect(loaded.catalog.size).toBe(BUILTIN_CATALOG.size);
  });

  /**
   * An ABSENT list means "built-ins only"; a list that is there but unreadable
   * means the operator wrote something down and it did not take effect. The
   * two must not collapse into the same silent fallback.
   */
  it("refuses a config that is there but is not valid JSON, naming the path", () => {
    const path = join(tmpDir, "plugins-malformed.json");
    writeFileSync(path, '{ "plugins": [ { "path": "a.mjs" }, ] ');
    expect(() => loadOperatorPlugins(path)).toThrow(OperatorPluginConfigError);
    expect(() => loadOperatorPlugins(path)).toThrow(/plugins-malformed\.json: the plugin list is not valid JSON/);
  });

  it("refuses a config naming a file that is not there, and says which", () => {
    const path = join(tmpDir, "plugins-missing.json");
    writeFileSync(path, JSON.stringify({ plugins: [{ path: "var/plugins/ghost.mjs" }] }));
    expect(() => loadOperatorPlugins(path)).toThrow(OperatorPluginConfigError);
    expect(() => loadOperatorPlugins(path)).toThrow(/ghost\.mjs/);
  });

  /**
   * A relative entry is relative to the CONFIG, so the HTTP process and the
   * runner child resolve the same list to the same files whatever directory
   * each was started in. Resolving against process.cwd() would make the list
   * mean different things in the two processes that must agree.
   */
  it("resolves a relative plugin entry against the config's directory, not the cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "alm-operator-relative-"));
    try {
      writeFileSync(join(dir, "relative-demo.mjs"), 'export default { id: "acme.relative", apply() { return () => {}; } };\n');
      const configPath = join(dir, "plugins.json");
      writeFileSync(configPath, JSON.stringify({ plugins: [{ path: "./relative-demo.mjs" }] }));
      // The cwd (the repo root) holds no such file, so a cwd-relative resolve
      // would refuse here rather than load.
      expect(process.cwd()).not.toBe(dir);
      const loaded = loadOperatorPlugins(configPath);
      expect(loaded.catalog.get("acme.relative")).toBeDefined();
      expect(loaded.sources.get("acme.relative")).toEqual({
        path: "./relative-demo.mjs",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a plugin module that throws while it loads, naming the file", () => {
    const mjs = join(tmpDir, "throws-on-load.mjs");
    writeFileSync(mjs, 'throw new Error("acme boot failure");\n');
    const configPath = join(tmpDir, "plugins-throws.json");
    writeFileSync(configPath, JSON.stringify({ plugins: [{ path: mjs }] }));
    expect(() => loadOperatorPlugins(configPath)).toThrow(OperatorPluginConfigError);
    expect(() => loadOperatorPlugins(configPath)).toThrow(/throws-on-load\.mjs" threw while loading/);
    expect(() => loadOperatorPlugins(configPath)).toThrow(/acme boot failure/);
  });

  it("loads a listed plugin and records its path and sha-256", () => {
    const mjs = join(tmpDir, "acme-demo.mjs");
    writeFileSync(mjs, 'export default { id: "acme.demo", apply() { return () => {}; } };\n');
    const configPath = join(tmpDir, "plugins-one.json");
    writeFileSync(configPath, JSON.stringify({ plugins: [{ path: mjs }] }));
    const loaded = loadOperatorPlugins(configPath);
    expect(loaded.catalog.size).toBe(BUILTIN_CATALOG.size + 1);
    expect(loaded.catalog.get("acme.demo")).toBeDefined();
    const source = loaded.sources.get("acme.demo");
    expect(source).toEqual({ path: mjs, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("refuses a plugin whose id an already-loaded plugin owns", () => {
    const mjs = join(tmpDir, "collide.mjs");
    writeFileSync(mjs, 'export default { id: "engine.metric.nii", apply() { return () => {}; } };\n');
    const configPath = join(tmpDir, "plugins-collide.json");
    writeFileSync(configPath, JSON.stringify({ plugins: [{ path: mjs }] }));
    expect(() => loadOperatorPlugins(configPath)).toThrow(/engine\.metric\.nii/);
  });

  it("refuses a module that default-exports something that is not a plugin", () => {
    const mjs = join(tmpDir, "notaplugin.mjs");
    writeFileSync(mjs, "export default 42;\n");
    const configPath = join(tmpDir, "plugins-bad.json");
    writeFileSync(configPath, JSON.stringify({ plugins: [{ path: mjs }] }));
    expect(() => loadOperatorPlugins(configPath)).toThrow(/notaplugin\.mjs/);
  });
});

/**
 * The graph the gates checked is the graph the run walks.
 * The run executes in a CHILD process, so the compiled plan document is
 * persisted beside the composed profile and handed to the walker there; without
 * it the child would derive the default plan and compute a different graph.
 */
describe("POST /api/plans/run persists the graph the run walks", () => {
  it("stores the compiled plan document beside the profile", async () => {
    const plan = examplePlanBody();
    const res = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan });
    expect(res.status).toBe(202);
    const stored = JSON.parse(
      readFileSync(join(t.storeRoot, "runs", res.body.runId, "request.json"), "utf8"),
    ) as { planDocument?: { stages: Array<{ id: string }> }; profile?: unknown };
    expect(stored.planDocument, "the child needs the graph, not only the profile").toBeDefined();
    expect(stored.planDocument!.stages.map((s) => s.id)).toEqual(plan.stages.map((s) => s.id));
    expect(stored.planDocument!.stages.map((s) => s.id)).toContain("st-ftp");
    expect(stored.profile).toBeDefined();
  }, 30_000);

  /**
   * The executor's own refusal family, answered at the front door. L2 is raised
   * by the compiler as a RequiredMetricMissingError, which is an ExecutorError
   * and not a PlanRejected, so without the mapping it would have escaped the
   * route as a bare 422 message with no detail block at all. A WALK-time
   * refusal cannot reach this path: the walk happens in the child, so it lands
   * as a failed job rather than an HTTP status.
   */
  it("answers an executor refusal with 422 and the compile detail shape", async () => {
    const p = vanillaPlan();
    p.planId = "PLAN-NO-GAP";
    // The gap metric is the only producer of GapResult, one of the three result
    // slots every run must fill. Both gates still pass: nothing consumes what
    // the dropped stage produced, so this is a licensing refusal, not a typing
    // one, and it is raised where the compiler licenses the graph.
    p.stages = p.stages.filter((s) => s.id !== "st-gap");
    const r = await api<{ error: { code: string; message: string; detail: { error: string } } }>(
      t.base, "POST", "/api/plans/run", { plan: p },
    );
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plan_not_runnable");
    expect(r.body.error.message).toContain("GapResult");
    expect(r.body.error.detail.error).toBe("RequiredMetricMissingError");
    // Nothing was written for a plan that never compiled.
    const slates = await api<Array<{ id: string }>>(t.base, "GET", "/api/scenario-slates");
    expect(slates.body.some((x) => x.id === "plan-PLAN-NO-GAP")).toBe(false);
  });

  it("carries one stage entry per executed stage into the result envelope", async () => {
    const plan = examplePlanBody();
    const res = await api<{ runId: string; notImplemented?: Array<{ layer: string }> }>(
      t.base, "POST", "/api/plans/run", { plan },
    );
    expect(res.status).toBe(202);
    const runId = res.body.runId;
    // The stages the compile tolerated with no mounted plugin: walked as
    // skipped, never executed. Counted from what the compiler reported rather
    // than written down, so a plugin arriving for one of them moves both sides.
    const tolerated = (res.body.notImplemented ?? []).filter((n) => n.layer.startsWith("plan.stage.")).length;
    expect(tolerated).toBeGreaterThan(0);

    const end = await waitFor(
      () => api<{ state: string; error?: { detail?: string } }>(
        t.base, "GET", `/api/runs/${runId}`,
      ).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      120_000,
    );
    expect(end.state, JSON.stringify(end.error)).toBe("done");

    const result = JSON.parse(
      readFileSync(join(t.storeRoot, "runs", runId, "result.json"), "utf8"),
    ) as { provenance: { runLog: Array<{ t: string; stageId?: string; skipped?: string }> } };
    const stages = result.provenance.runLog.filter((e) => e.t === "stage");
    const executed = stages.filter((e) => e.skipped !== "not-executable");
    expect(stages.map((e) => e.stageId)).toEqual(plan.stages.map((s) => s.id));
    expect(stages).toHaveLength(plan.stages.length);
    expect(executed).toHaveLength(plan.stages.length - tolerated);
    // The log says WHICH graph ran, and that it was the submitted one rather
    // than a default derived in the child.
    const planEntry = result.provenance.runLog.find((e) => e.t === "plan") as
      | { t: "plan"; planId?: string; derived?: boolean }
      | undefined;
    expect(planEntry).toBeDefined();
    expect(planEntry!.derived).toBe(false);
    expect(planEntry!.planId).toBe(plan.planId);
  }, 180_000);
});

/**
 * Piece 2a at the front door. The two refusals a dimension bag makes possible
 * are compile refusals, so `/api/plans/run` answers them as a 422 carrying the
 * class name, and `/api/plans/validate` reports the same class in its compile
 * block rather than throwing: a validate call asked a question and is owed an
 * answer. Both are asserted, because the two routes report the same refusal in
 * two different shapes and a regression in either one is a regression.
 */
describe("piece 2a: the dimension bag's compile refusals over the example plan", () => {
  it("refuses a decay binding the stage predicate leaves uncovered, naming the position", async () => {
    // Narrow the shipped predicate so the "Whole book" deposit rows fall
    // outside it. X-DDA-1 is the DDA (Non-Interest) row the decay binding
    // covers and the narrowed stage no longer licenses.
    const plan = examplePlanBody();
    plan.stages.find((s) => s.id === "st-decay-nmd")!.selector = {
      behavioralClasses: "decay", dimensions: { segment: ["Rate shoppers"] },
    };
    const run = await api<{ error: { code: string; message: string; detail: { error: string } } }>(
      t.base, "POST", "/api/plans/run", { plan },
    );
    expect(run.status).toBe(422);
    expect(run.body.error.code).toBe("plan_not_runnable");
    expect(run.body.error.detail.error).toBe("UnlicensedBindingError");
    expect(run.body.error.message).toContain("does not cover position");
    expect(run.body.error.message).toContain("X-DDA-1");

    const validate = await api<{ compile: { passed: boolean; error: string; detail: string } }>(
      t.base, "POST", "/api/plans/validate", { plan },
    );
    expect(validate.status).toBe(200);
    expect(validate.body.compile.passed).toBe(false);
    expect(validate.body.compile.error).toBe("UnlicensedBindingError");
    expect(validate.body.compile.detail).toContain("does not cover position");
  });

  it("refuses two decay bindings on one family whose predicates overlap on a position", async () => {
    const sets = exampleAssumptions();
    sets.id = "example-plan-sets-overlap";
    // The family-wide decay binding on DDA (Non-Interest) plus a second one
    // whose predicate names the segment that family's only row carries: both
    // match X-DDA-1, which is L3's refusal.
    sets.bindings.push({ ...sets.bindings[3]!, selector: { segment: ["Whole book"] } });
    seedAssumptionSet(sets);
    const plan = examplePlanBody();
    plan.inputs.assumptionSets = [sets.id];
    const run = await api<{ error: { code: string; message: string; detail: { error: string } } }>(
      t.base, "POST", "/api/plans/run", { plan },
    );
    expect(run.status).toBe(422);
    expect(run.body.error.detail.error).toBe("OverlappingBindingError");
    expect(run.body.error.message).toContain("X-DDA-1");

    const validate = await api<{ compile: { passed: boolean; error: string } }>(
      t.base, "POST", "/api/plans/validate", { plan },
    );
    expect(validate.status).toBe(200);
    expect(validate.body.compile.error).toBe("OverlappingBindingError");
  });
});

/**
 * Piece 2b at the front door. A view that cannot partition the book is a
 * compile refusal, so `/api/plans/run` answers it as a 422 carrying the class
 * name and the engine's message. The class itself is pinned inside the engine;
 * this is the one case that drives the mapping over HTTP.
 */
describe("piece 2b: a view that cannot partition the book refuses at the front door", () => {
  it("422s a plan whose view groups on a dimension the book's taxonomy does not declare", async () => {
    const plan = examplePlanBody();
    plan.views = [{ id: "by-vintage", label: "By vintage", groupBy: ["vintage"] }];
    const run = await api<{ error: { code: string; message: string; detail: { error: string } } }>(
      t.base, "POST", "/api/plans/run", { plan },
    );
    expect(run.status).toBe(422);
    expect(run.body.error.code).toBe("plan_not_runnable");
    expect(run.body.error.detail.error).toBe("ViewDefinitionError");
    expect(run.body.error.message).toContain('view "by-vintage" cannot partition the book');
    expect(run.body.error.message).toContain("the book's taxonomy declares no such dimension");
  }, 30_000);
});

/**
 * Studio blank path D4: a run that throws in the deterministic arm lands as one
 * typed line, not a Node stack with this machine's absolute paths. The book is
 * written straight into the store (import and validate refuse a seasoned
 * floater since the D3 round) and launched through /api/runs, which does not
 * validate positions, so the child meets the engine's own SeasoningError.
 */
describe("a failed run reports one line", () => {
  it("records `runnerEntry: SeasoningError: ...` with no stack frame and no absolute path", async () => {
    const store = new FileStore(t.storeRoot);
    const base = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.vanillaPortfolio).doc;
    const book: PortfolioSpec = {
      ...base,
      id: "vanilla-seasoned-floater-d4",
      positions: base.positions.map((p, i) =>
        i === 1
          ? {
              ...p,
              terms: {
                id: p.id, type: "floating-loan", label: "Seasoned floater", notional: 100_000_000,
                maturityMonths: 36, originationOffsetMonths: -6, amortType: "level-pay",
                indexTenorMonths: 1, margin: 0.0125, resetFrequencyMonths: 1,
              },
            }
          : p,
      ),
    };
    store.putDocument("portfolios", book.id, book, {
      label: book.label, asOf: book.asOf, positionCount: book.positions.length,
    });

    const r = await api<{ runId: string }>(t.base, "POST", "/api/runs", {
      portfolioId: book.id,
      marketId: SEED_IDS.market,
      scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    });
    expect(r.status).toBe(202);
    const end = await waitFor(
      () => api<{ state: string; error?: { message: string; detail?: string } }>(
        t.base, "GET", `/api/runs/${r.body.runId}`,
      ).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      90_000,
    );
    expect(end.state).toBe("error");
    const status = JSON.parse(
      readFileSync(join(t.storeRoot, "runs", r.body.runId, "status.json"), "utf8"),
    ) as { error?: { message: string; detail?: string } };
    expect(status.error!.message).toMatch(/^runnerEntry: SeasoningError: /);
    // The class and the engine's own reason stay: diagnosable, only the stack goes.
    expect(status.error!.message).toContain("originationOffsetMonths -6");
    expectOneLineFailure(status.error!, [repoRoot(), t.storeRoot, process.cwd()]);
    expect(end.error!.message).toBe(status.error!.message);
  }, 120_000);

  /**
   * The check above must be able to fail. It reads the FIELDS (a stringified
   * object escapes the newlines a stack is made of), so a stack re-added to
   * either field, or an absolute path of this checkout or store, is refused.
   */
  it("the one-line check refuses a stack or an absolute path in message or detail", () => {
    const roots = ["/work/repo", "/work/store"];
    const clean = { message: "runnerEntry: SeasoningError: instrument \"loan-1\" (floating-loan): offset -6" };
    expect(() => expectOneLineFailure(clean, roots)).not.toThrow();
    const frames = "\n    at seasoningOffsetOf (/work/repo/packages/engine/src/portfolio/seasoning.ts:137:13)";
    expect(() => expectOneLineFailure({ message: clean.message + frames }, roots)).toThrow();
    expect(() => expectOneLineFailure({ ...clean, detail: "SeasoningError: x" + frames }, roots)).toThrow();
    expect(() => expectOneLineFailure({ ...clean, detail: "a detail line" }, roots)).toThrow();
    expect(() => expectOneLineFailure({ message: clean.message + " in /work/store/portfolios/x.json" }, roots)).toThrow();
    expect(() => expectOneLineFailure({ message: clean.message + " (node_modules/tsx)" }, roots)).toThrow();
  });
});

/**
 * One typed line and nothing else: no detail field (that is where the old
 * bootstrap catch put the stack), no stack frame in either field, and none of
 * the given absolute roots (repo, store, cwd) as a substring, whichever
 * directory the checkout lives under.
 */
function expectOneLineFailure(error: { message: string; detail?: string }, roots: string[]): void {
  expect(error.detail).toBeUndefined();
  const text = [error.message, error.detail ?? ""].join("\n");
  expect(text).not.toMatch(/\n\s+at /);
  expect(text).not.toMatch(/\bat \S+ \(/);
  expect(text).not.toContain("node_modules");
  expect(text).not.toContain("/Users/");
  for (const root of roots) expect(text).not.toContain(root);
}
