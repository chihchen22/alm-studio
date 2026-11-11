// packages/engine/src/run/__tests__/macroRun.test.ts (A2 sharded leg, A9, F9, R6 inheritance, I2 metric paths)
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import { MacroRefusedError, NO_MACRO, macroTargetsOf, resolveRunMacro, type RunMacro } from "../../macro/runMacro";
import { buildCellPlan } from "../../portfolio/cells";
import { applyStaticOverlays } from "../../projection/static";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../../scenario";
import { SHARD_CHUNK } from "../shard/chunk";
import { DEFAULT_CELL_BUDGET_BYTES, runStaticPass } from "../shard/staticPass";
import { runStochastic } from "../stochastic";
import { makeRunRequest, regulatoryScenarios } from "./fixtures";
import { housingSet, macroMarket, runOn, syntheticBook } from "./macroFixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await macroMarket(); }, 120_000);
const demo = housingSet("demo", null), mapped = housingSet("mapped", "hpi-down-30"), flat = housingSet("flat", "hpi-flat");
const SHOCKED = ["S100", "S-100", "S200", "S-200"];

describe("the mapped shard round trip (blocker 1)", () => {
  // The run-level book (2500 positions) is one chunk of 4096, so a run never spawns a
  // worker on it. The pass is driven directly on the mapped effective book repeated
  // four times (more than 8192 positions), which the pass cuts into three worker slices.
  it("sharded equals inline on a mapped book, and the workers rebuild the path from its wire form", () => {
    const req = makeRunRequest(market, { assumptionSets: [mapped], scenarios: regulatoryScenarios(mapped.id) });
    const macro = resolveRunMacro(req, market);
    expect(macro.kind).toBe("path");
    const effective = applyStaticOverlays(syntheticBook(), mapped, undefined, macroTargetsOf(macro));
    const positions: Position[] = [0, 1, 2, 3].flatMap((k) => effective.positions.map((p) => ({ ...p, id: `${p.id}-r${k}`, terms: { ...p.terms, id: `${p.terms.id}-r${k}` } })));
    const book: PortfolioSpec = { ...effective, positions };
    // Preconditions, restated: more than one worker runs, and the book reaches the wrapper.
    expect(SHARD_CHUNK).toBe(4096);
    expect(positions.length).toBe(4 * effective.positions.length);
    expect(positions.length).toBeGreaterThan(2 * 4096);
    expect(Math.min(4, Math.max(1, Math.ceil(positions.length / 4096)))).toBe(3);
    expect(positions.filter((p) => Object.prototype.hasOwnProperty.call(p.terms, "housing")).length).toBeGreaterThan(0);
    const cellPlan = buildCellPlan(book, undefined);
    const base = buildBaseCurve(market);
    const scenarios = [
      { scenarioId: "S0", rateSpec: { kind: "base" as const }, path: buildRatePath(base, 360) },
      { scenarioId: "S100", rateSpec: { kind: "parallel" as const, shockBp: 100 }, path: buildRatePath(shockedCurve(base, { kind: "parallel", shockBp: 100 }), 360) },
    ];
    const pass = (shards: number, m: RunMacro) => {
      const out = runStaticPass([{ positions, scenarios }], cellPlan, 360, shards, market, DEFAULT_CELL_BUDGET_BYTES, undefined, m);
      return JSON.stringify([...out.entries()].map(([id, sink]) => [id, Object.entries(sink).map(([k, v]) => [k, Array.isArray(v) ? v.map((a) => Array.from(a as Float64Array)) : Array.from(v as Float64Array)])]));
    };
    const sharded = pass(4, macro), inline = pass(1, macro);
    expect(sharded).toBe(inline);
    // Power: the mapped path moves the numbers, so equality is not two kernel schedules.
    expect(inline).not.toBe(pass(1, NO_MACRO));
  }, 300_000);
});

describe("mapped runs", () => {
  it("a mapped run differs from the unmapped run and logs the mapping", () => {
    const a = runOn(market, demo), b = runOn(market, mapped);
    expect(JSON.stringify(b.cashflows)).not.toBe(JSON.stringify(a.cashflows));
    const macroKeys = (r: typeof a) => (r.provenance.runLog ?? []).filter((e) => e.t === "resolve" && e.key.startsWith("macro/"));
    expect(macroKeys(b).length).toBe(2);
    expect(macroKeys(a).length).toBe(0);
  });
  it("a scenario set carrying a different mapping refuses at the run entry", () => {
    expect(() => runOn(market, mapped, { scenarioSets: { S100: flat } })).toThrow(MacroRefusedError);
  });
  it("R6: shocked scenarios on a housing set with no mapping inherit the base's path, equal to the all-mapped run", () => {
    const { macroBindings: _drop, ...rest } = mapped;
    void _drop;
    const inherit: AssumptionSet = { ...rest, id: "inherit" };
    const all = runOn(market, mapped);
    const inherited = runOn(market, mapped, { scenarioSets: Object.fromEntries(SHOCKED.map((s) => [s, inherit])) });
    const blocks = (r: RunResult) => JSON.stringify({ cashflows: r.cashflows, eve: r.eve, nii: r.nii });
    expect(blocks(inherited)).toBe(blocks(all));
    // Power: the inheriting scenario does not read the kernel schedule.
    const s100 = (r: RunResult) => JSON.stringify(r.cashflows.byScenario.find((s) => s.scenarioId === "S100"));
    expect(s100(inherited)).not.toBe(s100(runOn(market, demo)));
  }, 300_000);
});

describe("key-rate, channels and per-scenario durations read the mapped path (I2)", () => {
  // A mortgage-only slice of the synthetic book: no regime-amplified deposit refuses the
  // key-rate block, and the regenerated legs stay cheap.
  const mortgageBook = (): PortfolioSpec => {
    const b = syntheticBook();
    const keep = (fam: string) => b.positions.filter((p) => p.familyId === fam).slice(0, 60);
    return { ...b, positions: [...keep("mortgages"), ...keep("mbs")] };
  };
  it("each block differs from the unmapped run", () => {
    const context = { keyRate: true, eveChannels: true, durationMode: "per-scenario" as const };
    const a = runOn(market, demo, { book: mortgageBook(), context }), b = runOn(market, mapped, { book: mortgageBook(), context });
    expect(a.eve.keyRate).toBeDefined();
    expect(a.eve.channels).toBeDefined();
    expect(JSON.stringify(b.eve.keyRate)).not.toBe(JSON.stringify(a.eve.keyRate));
    expect(JSON.stringify(b.eve.channels)).not.toBe(JSON.stringify(a.eve.channels));
    // Durations of a shocked scenario: the duration D and the bump-leg numerator D x PV both move,
    // so neither a reused base leg nor a regenerated one can hide kernel bump legs.
    for (const familyId of ["mortgages", "mbs"]) {
      const row = (r: RunResult) => r.eve.byScenario.find((s) => s.scenarioId === "S100")!.byFamily.find((f) => f.familyId === familyId)!;
      const ra = row(a), rb = row(b);
      expect(ra.effectiveDuration, familyId).toBeDefined();
      expect(rb.effectiveDuration, familyId).not.toBe(ra.effectiveDuration);
      const num = (r: typeof ra) => r.effectiveDuration! * r.pv;
      expect(Math.abs(num(rb) - num(ra)), familyId).toBeGreaterThan(1e-9 * Math.abs(num(ra)));
    }
  }, 300_000);
});

describe("A9 stochastic", () => {
  const sto = (set: typeof demo, sigma: number) => {
    const book = syntheticBook();
    // Deviation: StochasticRunOptions carries no seed, so it rides on the request; and
    // MIN_STOCHASTIC_PATHS is 20, so 8 paths would be refused: 20 is the smallest count the entry accepts.
    const req = makeRunRequest(market, { portfolioId: book.id, assumptionSets: [set], grid: { horizonMonths: 360, asOf: book.asOf },
      scenarios: regulatoryScenarios(set.id).slice(0, 1), seed: "7" });
    return runStochastic(req, book, { nPaths: 20, modelParams: { a: 0.05, sigma, reason: "macro A9" } } as never);
  };
  it("same seed: mapped and unmapped envelopes differ", () => {
    expect(sto(mapped, 0.01).eveDistribution.mean).not.toBe(sto(demo, 0.01).eveDistribution.mean);
  });
  it("sigma 0: every path equals the deterministic mapped base to 1e-12 relative, EVE and NII, with power", () => {
    const det = runOn(market, mapped), detDemo = runOn(market, demo);
    const eve = det.eve.byScenario.find((s) => s.scenarioId === "S0")!.eve;
    const nii = det.nii.byScenario.find((s) => s.scenarioId === "S0")!.totalNet12;
    const eveDemo = detDemo.eve.byScenario.find((s) => s.scenarioId === "S0")!.eve;
    const s = sto(mapped, 0);
    for (const v of [s.eveDistribution.min, s.eveDistribution.max]) expect(Math.abs(v - eve)).toBeLessThanOrEqual(1e-12 * Math.abs(eve));
    for (const v of [s.nii12mDistribution.min, s.nii12mDistribution.max]) expect(Math.abs(v - nii)).toBeLessThanOrEqual(1e-12 * Math.abs(nii));
    expect(Math.abs(eve - eveDemo)).toBeGreaterThanOrEqual(1e3 * 1e-12 * Math.abs(eve));
  });
});

