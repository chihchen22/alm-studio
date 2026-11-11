/**
 * The three stage functions that turn a book into series.
 * Each is compared against the call the pre-1c pipeline made, on the same
 * fixture, with the same seams.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot, NMDTerms } from "@alm/kernel";
import type { LicensedBinding, PlanStage } from "../../contracts/plan";
import type { PortfolioSpec } from "../../contracts/position";
import type { ScenarioCashflows } from "../../contracts/results";
import { defaultHarness } from "../../plugins/defaultHarness";
import { assembleScenarioCashflows } from "../../portfolio";
import { applyStaticOverlays } from "../../projection/static";
import { projectDynamicScenario } from "../../projection/dynamic";
import { buildCellPlan } from "../../portfolio/cells";
import { foldCellsToFamilies } from "../shard/chunk";
import { runStaticPass, type StaticPassGroup } from "../shard/staticPass";
import {
  runBalanceStage,
  runBehavioralStage,
  runContractualStage,
  runCurveStage,
  runTermStructureStage,
} from "../stages";
import type { StageInput, StageRunEnv } from "../stages";
import { PlanGraphError } from "../executorErrors";
import { bindAssumptions, UnknownFamilyError } from "../../scenario";
import { makeTestEnv } from "./stageEnv";
import {
  baseAssumptions,
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  segmentedAssumptions,
  segmentedNmdBook,
  twoSidedBook,
  NMD_DEFAULT_PARAMS,
  RELATIONSHIP_NMD_PARAMS,
} from "./fixtures";

const EMPTY: StageInput = { run: {}, scenario: {}, assumptionSet: {} };

function stage(id: string, kind: PlanStage["kind"], component: string): PlanStage {
  return { id, component, kind, consumes: [], produces: [] };
}

/** Every binding of the fixture set, licensed to one stage. */
function licenseAllTo(stageId: string): LicensedBinding[] {
  return baseAssumptions().bindings.map((b, bindingIndex) => ({
    stageId,
    assumptionSetId: "AS-BASE",
    familyId: b.familyId,
    kind: b.overlay.kind,
    bindingIndex,
  }));
}

let market: MarketSnapshot;
let env: StageRunEnv;
let paths: StageInput;
beforeAll(async () => {
  market = await loadMarket();
  env = makeTestEnv(makeRunRequest(market), twoSidedBook(), defaultHarness());
  const curve = runCurveStage(env, stage("st-curve", "curve", "engine.curve.bootstrap"), EMPTY);
  const term = runTermStructureStage(
    env,
    stage("st-term", "term-structure", "engine.rate-path.deterministic"),
    { run: { ZeroCurve: curve.run!.ZeroCurve }, scenario: {}, assumptionSet: {} },
  );
  paths = { run: {}, scenario: term.scenario!, assumptionSet: {} };
});

describe("runBehavioralStage", () => {
  it("applied to every binding, equals the one-pass applyStaticOverlays", () => {
    const licensed = { ...env, licensedBindings: licenseAllTo("st-b") };
    const out = runBehavioralStage(licensed, stage("st-b", "behavioral", "engine.behavioral.prepay"), paths);
    const book = out.assumptionSet!.Position!.get("AS-BASE") as PortfolioSpec;
    const direct = applyStaticOverlays(twoSidedBook(), env.setById.get("AS-BASE")!, env.behavioral);
    expect(JSON.stringify(book)).toBe(JSON.stringify(direct));
  });

  it("split across a chain of three stages, still equals the one pass", () => {
    const all = licenseAllTo("");
    const chain = ["st-prepay", "st-decay", "st-beta"];
    let input = paths;
    let book = twoSidedBook();
    for (let i = 0; i < chain.length; i++) {
      const only = [{ ...all[i]!, stageId: chain[i]! }];
      const out = runBehavioralStage(
        { ...env, licensedBindings: only },
        stage(chain[i]!, "behavioral", "engine.behavioral.prepay"),
        input,
      );
      book = out.assumptionSet!.Position!.get("AS-BASE") as PortfolioSpec;
      input = { run: {}, scenario: paths.scenario, assumptionSet: { Position: out.assumptionSet!.Position } };
    }
    const direct = applyStaticOverlays(twoSidedBook(), env.setById.get("AS-BASE")!, env.behavioral);
    expect(JSON.stringify(book)).toBe(JSON.stringify(direct));
  });

  /** The fixture set plus one binding on a family the COA does not carry. */
  function ghostSetEnv(licensedBindings: LicensedBinding[]): StageRunEnv {
    const bad = baseAssumptions();
    bad.bindings.push({
      familyId: "GHOST",
      overlay: { kind: "nmd-decay", params: NMD_DEFAULT_PARAMS },
      modelVersion: "ghost-1",
    });
    return { ...env, setById: new Map([["AS-BASE", bindAssumptions(bad)]]), licensedBindings };
  }

  it("validates the WHOLE set even when it licenses one binding of it", () => {
    // The defect is in a binding this stage does NOT license. Splitting the
    // validation gate across stages would let it through whichever stage did
    // not happen to see it, so the gate runs over the whole set regardless.
    const badEnv = ghostSetEnv([licenseAllTo("st-b")[0]!]);
    expect(() =>
      runBehavioralStage(badEnv, stage("st-b", "behavioral", "engine.behavioral.prepay"), paths),
    ).toThrow(UnknownFamilyError);
  });

  it("validates the whole set even when it licenses NOTHING of it", () => {
    // Ruling P1 is unconditional. A stage licensing no binding still runs the
    // gate, or a defective set reaches the contractual pass unrefused whenever
    // the plan happens to give it no licensee.
    const badEnv = ghostSetEnv([]);
    expect(() =>
      runBehavioralStage(badEnv, stage("st-b", "behavioral", "engine.behavioral.prepay"), paths),
    ).toThrow(UnknownFamilyError);
  });

  it("licensing no binding returns the book it received, object-identical", () => {
    const out = runBehavioralStage({ ...env, licensedBindings: [] }, stage("st-b", "behavioral", "engine.behavioral.prepay"), paths);
    expect(out.assumptionSet!.Position!.get("AS-BASE")).toBe(env.portfolio);
  });

  it("piece 2a: licenses by bindingIndex, so the second decay binding on DDA reaches D3 only", () => {
    const book = segmentedNmdBook();
    const set = segmentedAssumptions();
    // Binding 1 (the rate-shopper decay) binds the fixture DEFAULTS, so licensing
    // it moves no number and could not tell the two match rules apart. Give it
    // params that differ, and D1 reveals whether binding 1 was licensed.
    const shopperParams = { ...NMD_DEFAULT_PARAMS, closureSteady: NMD_DEFAULT_PARAMS.closureSteady * 3 };
    set.bindings[1] = { ...set.bindings[1]!, overlay: { kind: "nmd-decay", params: shopperParams } };
    const request = makeRunRequest(market, {
      portfolioId: book.id,
      assumptionSets: [set],
      scenarios: regulatoryScenarios(set.id),
    });
    const segEnv: StageRunEnv = {
      ...makeTestEnv(request, book, defaultHarness()),
      licensedBindings: [
        { stageId: "st-x", assumptionSetId: set.id, familyId: "DDA", kind: "nmd-decay", bindingIndex: 3 },
      ],
    };
    const stageX: PlanStage = {
      id: "st-x",
      component: "engine.behavioral.nmd-decay",
      kind: "behavioral",
      consumes: ["Position", "RatePath"],
      produces: ["Position"],
    };
    const out = runBehavioralStage(segEnv, stageX, EMPTY);
    const effective = out.assumptionSet!.Position!.get(set.id) as PortfolioSpec;
    const terms = (id: string) => (effective.positions.find((p) => p.id === id)!.terms as NMDTerms).nmdParams;
    expect(terms("D3")).toEqual(RELATIONSHIP_NMD_PARAMS);
    expect(terms("D1")).toEqual(NMD_DEFAULT_PARAMS);
  });
});

describe("runContractualStage", () => {
  it("produces the same series the pre-1c static pass produced", () => {
    const licensed = { ...env, licensedBindings: licenseAllTo("st-b") };
    const behavioral = runBehavioralStage(licensed, stage("st-b", "behavioral", "engine.behavioral.prepay"), paths);
    const input: StageInput = {
      run: {},
      scenario: paths.scenario,
      assumptionSet: { Position: behavioral.assumptionSet!.Position },
    };
    const out = runContractualStage(env, stage("st-cashflow", "contractual-cashflow", "engine.contractual"), input);

    const effective = applyStaticOverlays(twoSidedBook(), env.setById.get("AS-BASE")!, env.behavioral);
    const groups: StaticPassGroup[] = [
      {
        positions: effective.positions,
        scenarios: env.request.scenarios.map((s) => ({
          scenarioId: s.id,
          rateSpec: s.rateSpec,
          path: paths.scenario.RatePath!.get(s.id) as never,
        })),
      },
    ];
    const cellPlan = buildCellPlan(env.portfolio, undefined);
    const cells = runStaticPass(groups, cellPlan, env.horizonMonths, undefined, market);
    for (const s of env.request.scenarios) {
      const direct = assembleScenarioCashflows(
        effective,
        s.id,
        foldCellsToFamilies(cells.get(s.id)!, cellPlan.familyCellRange, env.horizonMonths),
        env.horizonMonths,
      );
      expect(JSON.stringify(out.scenario!.Cashflow!.get(s.id))).toBe(JSON.stringify(direct));
    }
  });

  it("produces a RepricingSchedule per scenario carrying the family index", () => {
    const out = runContractualStage(env, stage("st-cashflow", "contractual-cashflow", "engine.contractual"), paths);
    for (const s of env.request.scenarios) {
      const fs = out.scenario!.RepricingSchedule!.get(s.id) as { famIndex: Map<string, number> };
      expect([...fs.famIndex.keys()]).toEqual(env.portfolio.coa.families.map((f) => f.id));
    }
  });

  it("refuses a scenario naming an assumption set the run does not bind, typed", () => {
    const stray = {
      ...env.request,
      scenarios: env.request.scenarios.map((s) => (s.id === "S0" ? { ...s, assumptionSetId: "AS-GHOST" } : s)),
    };
    const strayEnv = { ...env, request: stray };
    const st = stage("st-cashflow", "contractual-cashflow", "engine.contractual");
    expect(() => runContractualStage(strayEnv, st, paths)).toThrow(PlanGraphError);
    expect(() => runContractualStage(strayEnv, st, paths)).toThrow(
      /scenario "S0" references unknown assumption set "AS-GHOST"/,
    );
  });
});

describe("runBalanceStage", () => {
  it("passes a static scenario's contractual series through, object-identical", () => {
    const contractual = runContractualStage(env, stage("st-cashflow", "contractual-cashflow", "engine.contractual"), paths);
    const input: StageInput = { run: {}, scenario: { ...paths.scenario, ...contractual.scenario }, assumptionSet: {} };
    const out = runBalanceStage(env, stage("st-balance", "balance-new-business", "engine.balance-plan"), input);
    for (const s of env.request.scenarios) {
      expect(out.scenario!.Cashflow!.get(s.id)).toBe(contractual.scenario!.Cashflow!.get(s.id));
    }
  });

  it("projects a dynamic scenario exactly as projectDynamicScenario does", () => {
    const dynamicRequest = {
      ...env.request,
      scenarios: env.request.scenarios.map((s) =>
        s.id === "S0" ? { ...s, newBusiness: { mode: "dynamic" as const, rules: [] } } : s,
      ),
    };
    const dynEnv = makeTestEnv(dynamicRequest, twoSidedBook(), defaultHarness());
    const curve = runCurveStage(dynEnv, stage("st-curve", "curve", "engine.curve.bootstrap"), EMPTY);
    const term = runTermStructureStage(
      dynEnv,
      stage("st-term", "term-structure", "engine.rate-path.deterministic"),
      { run: { ZeroCurve: curve.run!.ZeroCurve }, scenario: {}, assumptionSet: {} },
    );
    const dynPaths: StageInput = { run: {}, scenario: term.scenario!, assumptionSet: {} };
    const contractual = runContractualStage(dynEnv, stage("st-cashflow", "contractual-cashflow", "engine.contractual"), dynPaths);
    const out = runBalanceStage(
      dynEnv,
      stage("st-balance", "balance-new-business", "engine.balance-plan"),
      { run: {}, scenario: { ...dynPaths.scenario, ...contractual.scenario }, assumptionSet: {} },
    );
    const direct = projectDynamicScenario(
      twoSidedBook(),
      {
        scenario: dynamicRequest.scenarios.find((s) => s.id === "S0")!,
        ratePath: dynPaths.scenario.RatePath!.get("S0") as never,
        assumptions: dynEnv.setById.get("AS-BASE")!,
      },
      dynEnv.grid,
      dynEnv.behavioral,
    );
    expect(JSON.stringify(out.scenario!.Cashflow!.get("S0") as ScenarioCashflows)).toBe(
      JSON.stringify(direct.cashflows),
    );
  });
});
