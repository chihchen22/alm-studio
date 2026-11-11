/**
 * Stochastic 1M accrual path (fix A on the stochastic lane).
 *
 * The 1M reset accrues on the SIMPLE forward the discount factors imply, not
 * on the curve's quoted basis. Under the Treasury CMT pack (semiannual_bond)
 * the quoted 1M forward is bond-equivalent and sits a few bp above the simple
 * forward; under annual_act360 the quoted sub-1Y basis IS simple, so the two
 * constructions must agree there to floating-point precision.
 *
 * The expected values below restate the Hull-White bond price in full rather
 * than importing the kernel function that builds the path.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  bootstrapZeroCurve,
  loadMarketSnapshot,
  projectHWToTenor,
  type MarketSnapshot,
  type ZeroCurve,
} from "@alm/kernel";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { buildStochasticEnvironment, StochasticVolShockOverrideError, type StochasticEnvironment } from "../stochasticEnvironment";

const PUBLIC_PACK = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);
const ACT360_FIXTURE = fileURLToPath(
  new URL(
    "../../../../kernel/src/math/rates/__tests__/fixtures/market_constructed.json",
    import.meta.url,
  ),
);

const DT = 1 / 12;
const A = 0.05;
const SIGMA = 0.01;
const OPTIONS = {
  horizonMonths: 120,
  nPaths: 8,
  seed: 20250930n,
  modelParams: { a: A, sigma: SIGMA, reason: "test" },
};

/**
 * Simple 1M forward on one HW path, restated from the shifted-Gaussian bond
 * price (Brigo-Mercurio 3.39-3.40, phi-corrected):
 *   B(u)   = (1 - exp(-a u)) / a
 *   phi(t) = (sigma^2 / 2) B(t)^2   (what the kernel hwPhi computes)
 *   V      = (sigma^2 / (4 a)) (1 - exp(-2 a t)) B(tau)^2 + B(tau) phi(t)
 *   P      = (DF(t + tau) / DF(t)) exp(-B(tau) X - V)
 *   rate   = (1 / P - 1) / tau
 */
function simpleForwardRestated(curve: ZeroCurve, t: number, x: number): number {
  const tau = DT;
  const bTau = (1 - Math.exp(-A * tau)) / A;
  const bT = (1 - Math.exp(-A * t)) / A;
  const phi = 0.5 * SIGMA * SIGMA * bT * bT;
  const v =
    ((SIGMA * SIGMA) / (4 * A)) * (1 - Math.exp(-2 * A * t)) * bTau * bTau + bTau * phi;
  const p = (curve.discountFactor(t + tau) / curve.discountFactor(t)) * Math.exp(-bTau * x - v);
  return (1 / p - 1) / tau;
}

describe("stochastic 1M accrual path on the public Treasury CMT pack", () => {
  let curve: ZeroCurve;
  let env: StochasticEnvironment;
  beforeAll(async () => {
    const snapshot: MarketSnapshot = await loadMarketSnapshot(PUBLIC_PACK);
    curve = bootstrapZeroCurve(snapshot);
    env = buildStochasticEnvironment(snapshot, curve, OPTIONS);
  });

  it("carries the simple forward from the HW bond price at every step", () => {
    expect(curve.convention).toBe("semiannual_bond");
    for (const p of [0, 7]) {
      expect(env.paths[p].rateAt(0)).toBe(curve.forwardRate(0, DT));
      for (const s of [1, 12, 60, 119]) {
        const t = s * DT;
        const expected = simpleForwardRestated(curve, t, env.sim.XPaths[p][s - 1]);
        expect(Math.abs(env.paths[p].rateAt(s) - expected)).toBeLessThan(1e-12);
      }
    }
  });

  it("sits below the quoted (bond-equivalent) projection", () => {
    const quoted = projectHWToTenor(env.sim, curve, DT);
    // The uplift is about r^2 (1/4 - 1/24), so it scales with the rate level:
    // above 1 bp on paths 0 and 7 (the paths test 1 pins), and strictly
    // positive on every path at every step (path 2 at month 60 sits near 2.1%,
    // where the uplift is just under 1 bp).
    for (const p of [0, 7]) {
      for (const s of [1, 60]) {
        expect(quoted[p][s - 1] - env.paths[p].rateAt(s)).toBeGreaterThan(1e-4);
      }
    }
    for (let p = 0; p < env.paths.length; p++) {
      for (let s = 1; s < OPTIONS.horizonMonths; s++) {
        expect(quoted[p][s - 1] - env.paths[p].rateAt(s)).toBeGreaterThan(0);
      }
    }
  });
});

describe("stochastic 1M accrual path is invariant under annual_act360", () => {
  it("agrees with the quoted projection, whose sub-1Y basis is already simple", async () => {
    const snapshot = await loadMarketSnapshot(ACT360_FIXTURE);
    const curve = bootstrapZeroCurve(snapshot);
    expect(curve.convention).toBe("annual_act360");
    const env = buildStochasticEnvironment(snapshot, curve, OPTIONS);
    const quoted = projectHWToTenor(env.sim, curve, DT);
    for (let p = 0; p < env.paths.length; p++) {
      expect(env.paths[p].rateAt(0)).toBe(curve.forwardSwapRate(0, DT));
      for (let s = 1; s < OPTIONS.horizonMonths; s++) {
        expect(Math.abs(env.paths[p].rateAt(s) - quoted[p][s - 1])).toBeLessThan(1e-12);
      }
    }
  });
});

describe("a modelParams override on a volatility-shocked market (Piece 6d)", () => {
  const OV = { horizonMonths: 12, nPaths: 20, seed: 1n, modelParams: { a: 0.03, sigma: 0.01, reason: "probe" } };
  it("is refused when the snapshot's own derivedFrom names a short-rate volatility op", async () => {
    const base: MarketSnapshot = await loadMarketSnapshot(PUBLIC_PACK);
    const curve = bootstrapZeroCurve(base);
    const shocked = deriveMarketSnapshot(base, [{ op: "scale-short-rate-vol", value: 1.5 }], { baseId: "market-public-2026-03-31" }).snapshot;
    let err: unknown;
    try {
      buildStochasticEnvironment(shocked, curve, OV);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StochasticVolShockOverrideError);
    expect((err as StochasticVolShockOverrideError).layer).toBe("stochastic.calibration");
    expect((err as Error).message).toContain('derivedFrom names 1 short-rate volatility op(s) on base "market-public-2026-03-31"');
  });
  it("calibrates on the shocked volatilities when no override is given", async () => {
    const base: MarketSnapshot = await loadMarketSnapshot(PUBLIC_PACK);
    const curve = bootstrapZeroCurve(base);
    const shocked = deriveMarketSnapshot(base, [{ op: "scale-short-rate-vol", value: 1.5 }], { baseId: "market-public-2026-03-31" }).snapshot;
    const env = buildStochasticEnvironment(shocked, curve, { horizonMonths: 12, nPaths: 20, seed: 1n });
    expect(env.calibration.source).toBe("cap-atm-calibration");
    if (env.calibration.source !== "cap-atm-calibration") throw new Error("unreachable");
    expect(Math.abs(env.calibration.sigma - 0.009177677)).toBeLessThan(1e-8);
  });
  it("still accepts an override on the unshocked base and on a TLP-only derived market", async () => {
    const base: MarketSnapshot = await loadMarketSnapshot(PUBLIC_PACK);
    const curve = bootstrapZeroCurve(base);
    expect(buildStochasticEnvironment(base, curve, OV).calibration.source).toBe("override");
    const tlp = deriveMarketSnapshot(base, [{ op: "add", value: 10 }], { baseId: "market-public-2026-03-31" }).snapshot;
    expect(buildStochasticEnvironment(tlp, curve, OV).calibration.source).toBe("override");
  });
});
