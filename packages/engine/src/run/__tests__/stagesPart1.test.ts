/**
 * Each stage function wraps by reference the call the pre-1c
 * pipeline made, so each one must equal that call exactly on the four-position
 * fixture. The comparison is on the produced artifact, not on a recomputation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TLP_CURVE, buildTLPCurve, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import type { PlanStage } from "../../contracts/plan";
import { defaultHarness } from "../../plugins/defaultHarness";
import { buildBaseCurve } from "../../scenario";
import { buildScenarioRatePath } from "../../projection/static";
import { runCurveStage, runTermStructureStage, runTlpStage, tlpFromSnapshot } from "../stages";
import type { StageInput, StageRunEnv } from "../stages";
import { makeTestEnv } from "./stageEnv";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

const EMPTY: StageInput = { run: {}, scenario: {}, assumptionSet: {} };

function stage(id: string, kind: PlanStage["kind"], component: string): PlanStage {
  return { id, component, kind, consumes: [], produces: [] };
}

let market: MarketSnapshot;
let env: StageRunEnv;
beforeAll(async () => {
  market = await loadMarket();
  env = makeTestEnv(makeRunRequest(market), twoSidedBook(), defaultHarness());
});

describe("runCurveStage", () => {
  it("produces the bootstrapped risk-free curve at run scope, equal to buildBaseCurve", () => {
    const out = runCurveStage(env, stage("st-curve", "curve", "engine.curve.bootstrap"), EMPTY);
    expect(JSON.stringify(out.run!.ZeroCurve)).toBe(JSON.stringify(buildBaseCurve(market)));
    // One type per leg: the bootstrap stage produces no funding curve.
    expect(Object.keys(out.run!)).toEqual(["ZeroCurve"]);
    expect(out.scenario).toBeUndefined();
    expect(out.assumptionSet).toBeUndefined();
  });
});

describe("runTlpStage", () => {
  it("produces the all-in leg as its own FundingCurve type", () => {
    const base = runCurveStage(env, stage("st-curve", "curve", "engine.curve.bootstrap"), EMPTY);
    const input: StageInput = { run: { ZeroCurve: base.run!.ZeroCurve }, scenario: {}, assumptionSet: {} };
    const out = runTlpStage(env, stage("st-tlp", "curve", "engine.tlp-overlay"), input);
    expect(Object.keys(out.run!)).toEqual(["FundingCurve"]);
    expect(JSON.stringify(out.run!.FundingCurve)).toBe(JSON.stringify(tlpFromSnapshot(env.request)));
  });

  it("refuses when the ZeroCurve edge it declares reached it with nothing", () => {
    const bare: StageInput = { run: {}, scenario: {}, assumptionSet: {} };
    expect(() => runTlpStage(env, stage("st-tlp", "curve", "engine.tlp-overlay"), bare)).toThrow(/ZeroCurve/);
  });

  it("builds the overlay from the snapshot's nodes, and the kernel default when it has none", () => {
    const withNodes = { ...env.request, marketSnapshot: market };
    expect(JSON.stringify(tlpFromSnapshot(withNodes))).toBe(
      JSON.stringify(market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE),
    );
    const bare = { ...env.request, marketSnapshot: { ...market, tlpNodes: [] } };
    expect(JSON.stringify(tlpFromSnapshot(bare))).toBe(JSON.stringify(DEFAULT_TLP_CURVE));
  });
});

describe("runTermStructureStage", () => {
  it("produces one RatePath and one DiscountFactorPath per scenario, equal to the direct call", () => {
    const base = runCurveStage(env, stage("st-curve", "curve", "engine.curve.bootstrap"), EMPTY);
    const input: StageInput = { run: { ZeroCurve: base.run!.ZeroCurve }, scenario: {}, assumptionSet: {} };
    const out = runTermStructureStage(env, stage("st-term", "term-structure", "engine.rate-path.deterministic"), input);
    const paths = out.scenario!.RatePath!;
    const dfs = out.scenario!.DiscountFactorPath!;
    expect([...paths.keys()]).toEqual(env.request.scenarios.map((s) => s.id));
    for (const scenario of env.request.scenarios) {
      const direct = buildScenarioRatePath(
        base.run!.ZeroCurve as ZeroCurve,
        scenario,
        env.horizonMonths,
      );
      expect(JSON.stringify(paths.get(scenario.id))).toBe(JSON.stringify(direct));
      // One object carries both: the deterministic path holds its own discount factors.
      expect(dfs.get(scenario.id)).toBe(paths.get(scenario.id));
    }
  });

  it("logs one ratePaths resolve entry per scenario, naming the registered plugin", () => {
    const entries: string[] = [];
    const logging: StageRunEnv = { ...env, log: (e) => { if (e.t === "resolve") entries.push(`${e.key}:${e.scope.scenarioId ?? ""}`); } };
    const base = runCurveStage(logging, stage("st-curve", "curve", "engine.curve.bootstrap"), EMPTY);
    runTermStructureStage(
      logging,
      stage("st-term", "term-structure", "engine.rate-path.deterministic"),
      { run: { ZeroCurve: base.run!.ZeroCurve }, scenario: {}, assumptionSet: {} },
    );
    expect(entries).toEqual(env.request.scenarios.map((s) => `ratePaths:${s.id}`));
  });
});
