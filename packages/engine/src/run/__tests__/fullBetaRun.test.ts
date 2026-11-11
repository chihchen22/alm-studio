/**
 * The full beta form through the run pipeline. A deposit-beta binding carrying a full
 * form reaches the deposit as `fullBeta`, the static pass hands it each scenario's short-rate shift, the regulatory
 * convention leaves it whole and slots it frozen, "shocked-level" slots it at the scenario's level, and the blocks
 * that cannot read the form refuse or stand aside.
 *
 * The book is the four-deposit fixture; only HYS-A is bound a full form. Its parameters are round so the expected
 * cash flows are worked by hand: static beta 0.20 damped by 0.5 after a rise gives beta_eff 0.10 and a paid rate
 * of 0.10 + 0.10 x 4 = 0.50 percent at the 4 percent base state; +100 bp moves the target to 0.60 percent, so
 * month 1 pays 0.55 percent on $100 million.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { DepositBetaFullForm, PortfolioSpec } from "../../contracts/position";
import type { RunRequest, RunResult } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { depositShiftPctOf } from "../../nmd/fullBetaRun";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { runStochastic } from "../stochastic";
import { loadMarket, makeRunRequest } from "./fixtures";
import { HYS_A_CURVE, fourNmdBook } from "../../nmd/__tests__/fixtures";

const FORM: DepositBetaFullForm = {
  alphaPct: 0.1,
  deltaUp: 0.5,
  deltaDown: 0.25,
  volRatio: 1,
  baseShortRatePct: 4,
  baseLastMove: "rise",
  staticBeta: 0.2,
  balances: "flat",
};

const FULL_SET: AssumptionSet = {
  schemaVersion: "1.0.0",
  id: "AS-FULL",
  label: "HYS-A on the full beta form",
  bindings: [{ familyId: "HYS-A", modelVersion: "t", overlay: { kind: "deposit-beta", params: { ...HYS_A_CURVE, lambda: 0.5 }, fullForm: FORM } }],
};

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const scenario = (id: string, rateSpec: Scenario["rateSpec"], mode: "static" | "dynamic" = "static"): Scenario => ({
  id,
  label: id,
  rateSpec,
  assumptionSetId: FULL_SET.id,
  newBusiness: { mode, rules: [] },
});

function request(book: PortfolioSpec, scenarios: Scenario[] = [scenario("S0", { kind: "base" }), scenario("U100", { kind: "parallel", shockBp: 100 })]): RunRequest {
  return makeRunRequest(market, { runId: "RUN-FULL", portfolioId: book.id, scenarios, assumptionSets: [FULL_SET] });
}

function ctx(extra?: Partial<RunPipelineContext>): RunPipelineContext {
  return { ...resolveDefaultContext(), ...extra };
}

function series(result: RunResult, scenarioId: string, familyId: string) {
  return result.cashflows.byScenario.find((s) => s.scenarioId === scenarioId)!.byFamily.find((f) => f.familyId === familyId)!.series;
}

const HYS_A = 100_000_000;
const onlyHysA = (): PortfolioSpec => {
  const book = fourNmdBook();
  return { ...book, positions: book.positions.filter((p) => p.id === "hys-a") };
};

describe("full beta form in a run", () => {
  it("the shift at tenor zero: base 0, parallel shockBp, twist shortBp, custom read at tenor 0, in percent", () => {
    expect(depositShiftPctOf(scenario("a", { kind: "base" }))).toBe(0);
    expect(depositShiftPctOf(scenario("b", { kind: "parallel", shockBp: -200 }))).toBe(-2);
    expect(depositShiftPctOf(scenario("c", { kind: "twist", shortBp: 300, longBp: -100, pivotYears: 5 }))).toBe(3);
    expect(depositShiftPctOf(scenario("d", { kind: "custom", shocks: [{ tenorYears: 0.25, shockBp: 150 }, { tenorYears: 10, shockBp: 0 }] }))).toBe(1.5);
  });

  it("the bound deposit pays its base paid rate at base and one step toward the shocked target in month 1", () => {
    const book = fourNmdBook();
    const result = buildRunResult(request(book), book, ctx());
    expect(series(result, "S0", "HYS-A").interest[0]).toBeCloseTo((HYS_A * 0.005) / 12, 4);
    expect(series(result, "U100", "HYS-A").interest[0]).toBeCloseTo((HYS_A * 0.0055) / 12, 4);
    expect(series(result, "U100", "HYS-A").interest[1]).toBeCloseTo((HYS_A * 0.00575) / 12, 4);
    expect(series(result, "U100", "HYS-A").balance.every((b) => b === HYS_A)).toBe(true);
    // FTP stands aside on a full-form deposit, with its reason in the register.
    expect(result.ftp).toBeUndefined();
    expect(result.notImplemented.map((n) => n.layer)).toContain("ftp.full-beta-form");
  });

  it('"regulatory" leaves the full-form deposit whole and frozen; every other deposit splits as before', () => {
    const book = fourNmdBook();
    const result = buildRunResult(request(book), book, ctx({ nmdConvention: "regulatory" }));
    const parents = new Set(Object.values(result.parentOf ?? {}));
    expect(parents.has("hys-a")).toBe(false);
    expect(parents.has("hys-b")).toBe(true);
    // Frozen: pass-through min(0.10, 0.50), core min(0.90, 0.90); the 10 percent non-core slice leaves at month 1.
    for (const s of ["S0", "U100"]) expect(series(result, s, "HYS-A").principal[0]).toBeCloseTo(HYS_A * 0.1, 3);
  });

  it('"shocked-level" slots the full-form book at each scenario\'s level and records the convention', () => {
    const book = onlyHysA();
    const result = buildRunResult(request(book), book, ctx({ nmdConvention: "shocked-level" }));
    expect(result.nmdConvention).toBe("shocked-level");
    expect(result.parentOf).toBeUndefined();
    // +100: beta_eff 0.20 x 0.5 = 0.10 still (static beta), so the core is 0.90; a fall of 100 bp gives 0.20 x 0.75.
    expect(series(result, "U100", "HYS-A").principal[0]).toBeCloseTo(HYS_A * 0.1, 3);
    const down = buildRunResult(request(book, [scenario("S0", { kind: "base" }), scenario("D100", { kind: "parallel", shockBp: -100 })]), book, ctx({ nmdConvention: "shocked-level" }));
    expect(series(down, "D100", "HYS-A").principal[0]).toBeCloseTo(HYS_A * 0.15, 3);
  });

  it('"shocked-level" splits a deposit without the full form exactly as "regulatory" does', () => {
    const book = fourNmdBook();
    const shocked = buildRunResult(request(book), book, ctx({ nmdConvention: "shocked-level" }));
    const frozen = buildRunResult(request(book), book, ctx({ nmdConvention: "regulatory" }));
    // The same children under the same parents; HYS-A stays whole under both.
    expect(shocked.parentOf).toEqual(frozen.parentOf);
    expect(new Set(Object.values(shocked.parentOf ?? {})).has("hys-a")).toBe(false);
    // Every family but the full-form one carries the same cash flows in every scenario, bit for bit.
    for (const s of ["S0", "U100"]) {
      const fams = shocked.cashflows.byScenario.find((x) => x.scenarioId === s)!.byFamily.map((f) => f.familyId).filter((f) => f !== "HYS-A");
      expect(fams.length).toBeGreaterThan(0);
      for (const f of fams) expect(series(shocked, s, f)).toEqual(series(frozen, s, f));
    }
    // HYS-A: frozen keeps the base core (non-core 0.10 of the book leaves in month 1); shocked-level reads +100 bp's level.
    expect(series(frozen, "U100", "HYS-A").principal[0]).toBeCloseTo(HYS_A * 0.1, 3);
  });

  it('"shocked-level" refuses a book whose deposits carry no full form at all', () => {
    const book = fourNmdBook();
    const noForm = makeRunRequest(market, {
      runId: "RUN-NOFORM",
      portfolioId: book.id,
      scenarios: [{ ...scenario("S0", { kind: "base" }), assumptionSetId: "AS-NONE" }],
      assumptionSets: [{ schemaVersion: "1.0.0", id: "AS-NONE", label: "no form", bindings: [] }],
    });
    expect(() => buildRunResult(noForm, book, ctx({ nmdConvention: "shocked-level" }))).toThrow(/no deposit carries one under the base scenario's set/);
  });

  it("refuses the opt-ins that rebuild deposits on bumped paths, and dynamic new business", () => {
    const book = onlyHysA();
    expect(() => buildRunResult(request(book), book, ctx({ seg: true }))).toThrow(/seg cannot run beside the full beta form/);
    expect(() => buildRunResult(request(book), book, ctx({ keyRate: true }))).toThrow(/keyRate cannot run beside/);
    expect(() => buildRunResult(request(book), book, ctx({ eveChannels: true }))).toThrow(/eveChannels cannot run beside/);
    const dyn = request(book, [scenario("S0", { kind: "base" }, "dynamic")]);
    expect(() => buildRunResult(dyn, book, ctx())).toThrow(/static-runoff scenarios only/);
  });

  it("the stochastic entry refuses a set that binds the full form", () => {
    const book = onlyHysA();
    expect(() => runStochastic(request(book, [scenario("S0", { kind: "base" })]), book, { nPaths: 20 })).toThrow(
      /binds the full beta form/,
    );
  });
});
