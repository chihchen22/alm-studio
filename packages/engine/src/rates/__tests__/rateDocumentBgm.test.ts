/**
 * The rate document 1.2.0.
 *
 *  - One version, stamped on every document: 1.2.0. A Hull-White stochastic document and a deterministic
 *    document built from the HW golden's inputs equal the 1.1.0 builds
 *    (`golden/rates-*.json`) byte for byte once the version string is replaced.
 *  - The BGM fan summarises the 1D saved row of the 360-month simulation over the first horizonMonths
 *    rows: horizonMonths steps, the five pinned quantiles, the Rebonato block. Every expected value is
 *    restated here (the flat rates tensor read, the order-statistic interpolation at (n - 1) p, the mean).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DeterministicRatePath, loadMarketSnapshot, type BGMSimulationResult, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "../../../../../data/src/vanilla";
import { RATE_DOCUMENT_SCHEMA_VERSION, type BgmRateFan } from "../../contracts/rateDocument";
import { BGM_SAVED_TENORS_YEARS, STOCHASTIC_QUANTILES, type BgmModelOverride } from "../../contracts/stochastic";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunRequest } from "../../contracts/run";
import { runStochastic } from "../../run/stochastic";
import { buildBgmEnvironment } from "../../scenario/bgmEnvironment";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { buildBgmRateFan, buildRateDocument, RateDocumentError, type RateDocumentInput } from "../rateDocument";

const PUBLIC_PACK = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const GOLDEN_HW = fileURLToPath(new URL("./golden/rates-hw-vanilla-64.json", import.meta.url));
const GOLDEN_DET = fileURLToPath(new URL("./golden/rates-deterministic-vanilla.json", import.meta.url));
const STAMP = "2026-10-17T00:00:00.000Z";
const ONE_DAY = 1 / 360;

const ZERO_VOL: BgmModelOverride = { a: 0.2, b: 0.5, c: 0.48, d: 0.8, beta: 0, volScalar: 0, reason: "zero-vol degeneracy anchor" };
const VOL: BgmModelOverride = { ...ZERO_VOL, volScalar: 0.031, reason: "illustrative parameters" };

let market: MarketSnapshot;
let curve: ZeroCurve;
beforeAll(async () => {
  market = await loadMarketSnapshot(PUBLIC_PACK);
  curve = buildBaseCurve(market);
});

/** The HW golden's request. */
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

/** The bytes runnerEntry writes for rates.json. */
const bytesOf = (doc: unknown): string => `${JSON.stringify(doc)}\n`;
const V110 = '"schemaVersion":"1.1.0"';
const V120 = '"schemaVersion":"1.2.0"';

/** The quantile at (n - 1) p of a sorted column, linear between order statistics, restated. */
function handQuantile(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The kernel's flat rates tensor read restated: [path][step][tenor], the 1D saved tenor. */
function oneDayRow(sim: BGMSimulationResult, p: number, k: number): number {
  const ti = Array.from(sim.tenors).findIndex((t) => Math.abs(t - ONE_DAY) < 1e-12);
  return sim.rates[(p * sim.times.length + k) * sim.tenors.length + ti];
}

describe("rate document 1.2.0: one version on every document", () => {
  it("the constant is 1.2.0", () => {
    expect(RATE_DOCUMENT_SCHEMA_VERSION).toBe("1.2.0");
  });

  it("an HW stochastic document from the golden's inputs equals the main 1.1.0 build byte for byte after the version string", () => {
    const { request, portfolio } = vanillaRequest();
    let captured: RateDocumentInput["stochastic"];
    runStochastic(request, portfolio, {
      nPaths: 64,
      onEnvironment: (env, base) => {
        captured = { scenarioId: base.id, sim: env.sim };
      },
    });
    const fresh = bytesOf(buildRateDocument(request, { runId: request.runId, mode: "stochastic", stochastic: captured }));
    const golden = readFileSync(GOLDEN_HW, "utf8");
    expect(golden.split(V110).length - 1).toBe(1);
    expect(fresh.split(V120).length - 1).toBe(1);
    expect(fresh.replace(V120, V110)).toBe(golden);
  });

  it("a deterministic document differs from the main build in schemaVersion alone", () => {
    const { request } = vanillaRequest();
    const fresh = bytesOf(buildRateDocument(request, { runId: request.runId, mode: "deterministic" }));
    const golden = readFileSync(GOLDEN_DET, "utf8");
    expect(fresh).not.toBe(golden);
    expect(fresh.replace(V120, V110)).toBe(golden);
  });
});

describe("rate document 1.2.0: the BGM fan", () => {
  const H = 120;
  const N = 8;

  it("has horizonMonths steps, five quantiles and the Rebonato block, restated from the 1D saved row", () => {
    const { request } = vanillaRequest(H);
    const env = buildBgmEnvironment(market, curve, { horizonMonths: H, nPaths: N, seed: 42n, modelParams: VOL });
    expect(env.sim.times.length).toBe(360);
    const doc = buildRateDocument(request, {
      runId: "RUN-RATES-BGM",
      mode: "stochastic",
      stochastic: { scenarioId: "S0", model: "bgm-lmm-2f", sim: env.sim },
    });
    expect(doc.schemaVersion).toBe("1.2.0");
    const fan = doc.stochastic as BgmRateFan;
    expect(Object.keys(fan)).toEqual(["scenarioId", "nPaths", "model", "bgm", "times", "mean", "quantiles"]);
    expect(fan.scenarioId).toBe("S0");
    expect(fan.nPaths).toBe(N);
    expect(fan.model).toBe("bgm-lmm-2f");
    expect(fan.bgm).toEqual({ a: 0.2, b: 0.5, c: 0.48, d: 0.8, beta: 0, volScalar: 0.031, displacement: 0.05, cevBeta: 0.5 });
    expect(Object.keys(fan.bgm)).toEqual(["a", "b", "c", "d", "beta", "volScalar", "displacement", "cevBeta"]);
    expect(fan.times).toEqual(Array.from(env.sim.times.slice(0, H)));
    expect(fan.times[0]).toBeCloseTo(1 / 12, 15);
    expect(fan.mean.length).toBe(H);
    expect(fan.quantiles.map((q) => q.p)).toEqual([...STOCHASTIC_QUANTILES]);
    expect(fan.quantiles.length).toBe(5);
    for (const q of fan.quantiles) expect(q.values.length).toBe(H);

    for (const k of [0, 1, 11, 59, H - 1]) {
      const col = Array.from({ length: N }, (_, p) => oneDayRow(env.sim, p, k)).sort((x, y) => x - y);
      const mean = col.reduce((x, y) => x + y, 0) / N;
      expect(Math.abs(fan.mean[k] - mean)).toBeLessThan(1e-15);
      for (const q of fan.quantiles) expect(Math.abs(q.values[k] - handQuantile(col, q.p))).toBeLessThan(1e-15);
      // A nonzero-vol fan has a spread: p5 below p95.
      expect(fan.quantiles[0].values[k]).toBeLessThan(fan.quantiles[4].values[k]);
    }
    // The deterministic scenario entries are the ones a deterministic build writes.
    const det = buildRateDocument(request, { runId: "RUN-RATES-BGM", mode: "deterministic" });
    expect(doc.scenarios).toEqual(det.scenarios);
    expect(doc.grid).toEqual(det.grid);
  });

  it("the fan reads the row BgmRatePath reads for the 1D tenor (row k is forwardRateAt(k + 1, 1D))", () => {
    const env = buildBgmEnvironment(market, curve, { horizonMonths: H, nPaths: N, seed: 7n, modelParams: VOL });
    const fan = buildBgmRateFan("S0", env.sim, H);
    for (const k of [0, 30, H - 1]) {
      const col = env.paths.map((path) => path.forwardRateAt(k + 1, ONE_DAY)).sort((x, y) => x - y);
      expect(fan.quantiles[2].values[k]).toBe(handQuantile(col, 0.5));
    }
  });

  it("at zero vol the fan collapses onto one line near the curve's 1D forward", () => {
    const env = buildBgmEnvironment(market, curve, { horizonMonths: H, nPaths: N, seed: 42n, modelParams: ZERO_VOL });
    const fan = buildBgmRateFan("S0", env.sim, H);
    const det = new DeterministicRatePath(curve, H, 1 / 12);
    let maxGap = 0;
    for (let k = 0; k < H; k++) {
      for (const q of fan.quantiles) expect(Math.abs(q.values[k] - fan.mean[k])).toBeLessThan(1e-12);
      maxGap = Math.max(maxGap, Math.abs(fan.mean[k] - det.forwardRateAt(k + 1, ONE_DAY)));
    }
    // A 1D value: tolerance 3e-4, not 1e-12. The kernel projects the sub-month 1D stub from the monthly
    // forward while the curve interpolates inside the month; measured 2.58e-4 in Task 2 (bgmRatePath.test.ts).
    // Every tenor of one month or longer meets 1e-12 there; the fan reads only the 1D row.
    expect(maxGap).toBeLessThan(3e-4);
  });

  it("refuses a horizon past the simulation, a path count that disagrees with the tensor, and a sim with no 1D tenor", () => {
    const env = buildBgmEnvironment(market, curve, { horizonMonths: H, nPaths: 2, seed: 1n, modelParams: VOL });
    expect(() => buildBgmRateFan("S0", env.sim, 361)).toThrow(RateDocumentError);
    expect(() => buildBgmRateFan("S0", { ...env.sim, nPaths: 4 }, H)).toThrow(RateDocumentError);
    const noOneDay = { ...env.sim, tenors: Float64Array.from(env.sim.tenors, (t) => (t === env.sim.tenors[0] ? 0.5 : t)) };
    expect(() => buildBgmRateFan("S0", noOneDay, H)).toThrow(/1D/);
    expect(BGM_SAVED_TENORS_YEARS[0]).toBe(ONE_DAY);
  });
});
