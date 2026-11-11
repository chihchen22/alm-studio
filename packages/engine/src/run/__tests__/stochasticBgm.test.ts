/**
 * The stochastic dispatch.
 *
 *  - HW identity: a call with no `model` (and one naming hull-white-1f) returns an envelope byte-equal to
 *    the committed golden `golden/stochastic-hw-vanilla-64.json` (schema 0.2.0)
 *    once "0.3.0" is replaced by "0.2.0". Byte equality pins the 0.3.0 HW key order too.
 *  - BGM zero-vol degeneracy at horizons 120 and 360: the vanilla book's per-path EVE equals the
 *    deterministic base EVE within 1e-6 relative; the two-sided test book (mortgage, NMD) adds the rate
 *    path to the proof, EVE and NII-12m.
 *  - Same seed, same envelope byte for byte (the one wall-clock field, simulation.fixedCostMs, is set to
 *    0 on both sides first); a different seed moves the distributions.
 *  - onEnvironment stays HW-only; onBgmEnvironment is called once on the BGM branch only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "../../../../../data/src/vanilla";
import type { BgmModelOverride, StochasticRunResult } from "../../contracts/stochastic";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunRequest } from "../../contracts/run";
import { clearPortfolios } from "../../portfolio/registry";
import { createEngine } from "../index";
import { runStochastic } from "../stochastic";
import { loadMarket, makeRunRequest, regulatoryScenarios, twoSidedBook } from "./fixtures";

const GOLDEN = fileURLToPath(new URL("./golden/stochastic-hw-vanilla-64.json", import.meta.url));
const PUBLIC_PACK = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const STAMP = "2026-10-17T00:00:00.000Z";

const ZERO_VOL: BgmModelOverride = { a: 0.2, b: 0.5, c: 0.48, d: 0.8, beta: 0, volScalar: 0, reason: "zero-vol degeneracy anchor" };
const VOL: BgmModelOverride = { ...ZERO_VOL, volScalar: 0.031, reason: "illustrative parameters" };

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(PUBLIC_PACK);
});

/** The golden's request, restated from its README. */
function vanillaRequest(horizonMonths = 360): { request: RunRequest; portfolio: PortfolioSpec } {
  const portfolio = buildVanillaPortfolio();
  const set = vanillaAssumptionSet();
  const s0 = vanillaScenarios(set.id)[0];
  return {
    portfolio,
    request: {
      runId: "golden-stochastic-hw-vanilla-64",
      portfolioId: portfolio.id,
      marketSnapshot: market,
      scenarios: [s0],
      assumptionSets: [set],
      grid: { horizonMonths, asOf: portfolio.asOf },
      seed: "42",
      timestamps: { startedAt: STAMP, finishedAt: STAMP },
    },
  };
}

function deterministicBase(request: RunRequest, portfolio: PortfolioSpec): { eve: number; nii: number } {
  clearPortfolios();
  const engine = createEngine();
  engine.loadPortfolio(portfolio);
  const det = engine.run(request);
  const id = request.scenarios[0].id;
  return {
    eve: det.eve.byScenario.find((s) => s.scenarioId === id)!.eve,
    nii: det.nii.byScenario.find((s) => s.scenarioId === id)!.totalNet12,
  };
}

/** The envelope's bytes with the one wall-clock field set to 0. */
function bytesWithoutClock(env: StochasticRunResult): string {
  const copy = JSON.parse(JSON.stringify(env)) as StochasticRunResult;
  if (copy.simulation) copy.simulation.fixedCostMs = 0;
  return JSON.stringify(copy, null, 2) + "\n";
}

describe("the HW branch is byte-identical to the golden made on main", () => {
  it("no model option: byte-equal to the golden after replacing 0.3.0 by 0.2.0", () => {
    const golden = readFileSync(GOLDEN, "utf8");
    const { request, portfolio } = vanillaRequest();
    const env = runStochastic(request, portfolio, { nPaths: 64 });
    const text = JSON.stringify(env, null, 2) + "\n";
    expect(text).toContain('"schemaVersion": "0.3.0"');
    expect(text.replace('"schemaVersion": "0.3.0"', '"schemaVersion": "0.2.0"')).toBe(golden);
    expect(Object.prototype.hasOwnProperty.call(env, "simulation")).toBe(false);
  });

  it("model hull-white-1f named explicitly: the same bytes", () => {
    const { request, portfolio } = vanillaRequest();
    const implicit = runStochastic(request, portfolio, { nPaths: 64 });
    const explicit = runStochastic(request, portfolio, { nPaths: 64, model: "hull-white-1f" });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(implicit));
  });
});

describe("BGM zero-vol degeneracy through the full run", () => {
  for (const horizon of [120, 360]) {
    it(`the vanilla book's per-path EVE equals the deterministic base EVE within 1e-6 relative at horizon ${horizon}`, () => {
      const { request, portfolio } = vanillaRequest(horizon);
      const det = deterministicBase(request, portfolio);
      const sto = runStochastic(request, portfolio, { nPaths: 20, model: "bgm-lmm-2f", modelParams: ZERO_VOL });
      expect(sto.model).toBe("bgm-lmm-2f");
      expect(sto.horizonMonths).toBe(horizon);
      for (const v of [sto.eveDistribution.min, sto.eveDistribution.max, sto.eveDistribution.mean]) {
        expect(Math.abs(v - det.eve) / Math.abs(det.eve)).toBeLessThan(1e-6);
      }
      expect(sto.martingale.correctedMaxAbsErrBp).toBeLessThan(1e-8);
    });
  }

  it("the two-sided book (mortgage, NMD) collapses to the deterministic base EVE and NII-12m at horizon 360", async () => {
    const fixtureMarket = await loadMarket();
    const request = makeRunRequest(fixtureMarket, { scenarios: regulatoryScenarios().slice(0, 1) });
    const det = deterministicBase(request, twoSidedBook());
    const sto = runStochastic(request, twoSidedBook(), { nPaths: 20, model: "bgm-lmm-2f", modelParams: ZERO_VOL });
    for (const v of [sto.eveDistribution.min, sto.eveDistribution.max]) {
      expect(Math.abs(v - det.eve) / Math.abs(det.eve)).toBeLessThan(1e-6);
    }
    for (const v of [sto.nii12mDistribution.min, sto.nii12mDistribution.max]) {
      expect(Math.abs(v - det.nii) / Math.abs(det.nii)).toBeLessThan(1e-6);
    }
  });
});

describe("the BGM envelope", () => {
  it("names the model, carries the override arm and the simulation block after martingale", () => {
    const { request, portfolio } = vanillaRequest(120);
    const sto = runStochastic(request, portfolio, { nPaths: 20, model: "bgm-lmm-2f", modelParams: VOL });
    expect(sto.schemaVersion).toBe("0.3.0");
    expect(sto.model).toBe("bgm-lmm-2f");
    expect(sto.calibration).toEqual({ source: "override", model: "bgm-lmm-2f", ...VOL });
    const keys = Object.keys(sto);
    expect(keys.indexOf("simulation")).toBe(keys.indexOf("martingale") + 1);
    expect(sto.simulation?.savedTenors).toHaveLength(10);
    expect(sto.martingale.terminalYears).toBeCloseTo(10, 12);
    expect(sto.eveDistribution.stdev).toBeGreaterThan(0);
  });

  it("same seed: byte-identical envelope; different seed: different distributions", () => {
    const base = makeRunRequest(market, { scenarios: regulatoryScenarios().slice(0, 1) });
    const twoSided: RunRequest = { ...base, grid: { ...base.grid, horizonMonths: 120 } };
    const opts = { nPaths: 20, model: "bgm-lmm-2f" as const, modelParams: VOL };
    const a = runStochastic(twoSided, twoSidedBook(), opts);
    const b = runStochastic(twoSided, twoSidedBook(), opts);
    expect(bytesWithoutClock(b)).toBe(bytesWithoutClock(a));
    const c = runStochastic({ ...twoSided, seed: "43" }, twoSidedBook(), opts);
    expect(c.eveDistribution.mean).not.toBe(a.eveDistribution.mean);
    expect(c.nii12mDistribution.mean).not.toBe(a.nii12mDistribution.mean);
  });
});

describe("the environment hand-outs", () => {
  it("BGM calls onBgmEnvironment once and never onEnvironment; HW the reverse", () => {
    const { request, portfolio } = vanillaRequest(120);
    const bgmSeen: { nPaths: number; nSteps: number; scenarioId: string }[] = [];
    const hwSeen: string[] = [];
    runStochastic(request, portfolio, {
      nPaths: 20,
      model: "bgm-lmm-2f",
      modelParams: VOL,
      onEnvironment: (_env, base) => hwSeen.push(base.id),
      onBgmEnvironment: (env, base) => bgmSeen.push({ nPaths: env.sim.nPaths, nSteps: env.paths[0].nSteps, scenarioId: base.id }),
    });
    expect(bgmSeen).toEqual([{ nPaths: 20, nSteps: 120, scenarioId: "S0" }]);
    expect(hwSeen).toEqual([]);

    const bgmAfterHw: string[] = [];
    runStochastic(request, portfolio, {
      nPaths: 20,
      modelParams: { a: 0.05, sigma: 0.01, reason: "hand-out" },
      onEnvironment: (_env, base) => hwSeen.push(base.id),
      onBgmEnvironment: (_env, base) => bgmAfterHw.push(base.id),
    });
    expect(hwSeen).toEqual(["S0"]);
    expect(bgmAfterHw).toEqual([]);
  });

  it("refuses an override whose shape does not match the model", () => {
    const { request, portfolio } = vanillaRequest(120);
    expect(() =>
      runStochastic(request, portfolio, { nPaths: 20, model: "bgm-lmm-2f", modelParams: { a: 0.05, sigma: 0.01, reason: "hw shape" } }),
    ).toThrow(/override/);
    expect(() => runStochastic(request, portfolio, { nPaths: 20, modelParams: VOL })).toThrow(/override/);
  });

  it("a null override reads as no override, never a TypeError (Task 4 ruling)", () => {
    const { request, portfolio } = vanillaRequest(120);
    const nullOverride = null as unknown as BgmModelOverride;
    const env = runStochastic(request, portfolio, { nPaths: 20, modelParams: nullOverride });
    expect(env.calibration.source).toBe("cap-atm-calibration");
  });
});
