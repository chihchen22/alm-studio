/**
 * 2026-09-01 fix-wave gates for the rate engines.
 *
 * Three defects the pre-existing suite could not see, each with the test that
 * would have caught it:
 *
 *   H3  The CMT convention rebase never reached model pricing or projection:
 *       bgmPricing.buildSwap, simulateHw.projectHWToTenor and
 *       simulateBgm.projectRowToTenors all quoted an annual ACT/360 par leg on
 *       a semi-annual-bond curve. Curve-NODE parity is blind to this, because
 *       the nodes round-trip under either convention. The gate below is
 *       therefore PATHWISE, at 1M / 6M / 1Y / 10Y projections, against the
 *       Python sibling (which already carried the branch), on fixed model
 *       parameters so the optimizer cannot launder a disagreement.
 *
 *   H2  BGM output rows were timestamped one step ahead of the state, so the
 *       t = 1M row held the t = 0 curve and had exactly zero cross-path
 *       variance. The pre-existing first-step test passed ON that zero-variance
 *       row. The gate below requires a nonzero first-step spread.
 *
 *   H1  The CEV predictor-corrector averaged the state-dependent diffusion
 *       coefficient and applied the average to the same Brownian increment,
 *       adding a spurious Ito drift of order 0.5(beta_cev - 1) b^2 dt. That
 *       error does NOT vanish as dt shrinks — it is an O(dt) drift per step,
 *       i.e. O(1) over a fixed horizon — so the gate below is a convergence
 *       test on the first two moments under halving dt.
 *
 * Fixture: fixtures/cmtProjectionParity.json, written by
 * the Lab's Python reference.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { bootstrapZeroCurve } from "../bootstrap";
import { loadMarketSnapshot } from "../marketData";
import { simulateBGM, bgmTenorIndex, getRate } from "../simulateBgm";
import { projectHWToTenor, simulateHW } from "../simulateHw";

const LAB = resolve(__dirname, "../../../..");
const MARKET_PATH = resolve(LAB, "public/market_public.json");
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/cmtProjectionParity.json"), "utf-8"),
) as {
  tenorLabels: string[];
  tenors: number[];
  samplePaths: number[];
  sampleSteps: number[];
  seed: number;
  nPairs: number;
  horizonYears: number;
  dtYears: number;
  hwParams: { a: number; sigma: number };
  bgmParams: {
    a: number; b: number; c: number; d: number; beta: number;
    vol_scalar: number; displacement: number; cev_beta: number;
  };
  hw: Record<string, number[][]>;
  bgm: Record<string, number[][]>;
  bgmFirstStepSd: Record<string, number>;
};

/** Sample standard deviation across paths of one (step, tenor) cell. */
function crossPathSd(rates: Float64Array, nPaths: number, nSteps: number, nTenors: number, step: number, ti: number): number {
  let mean = 0;
  for (let p = 0; p < nPaths; p++) mean += rates[(p * nSteps + step) * nTenors + ti];
  mean /= nPaths;
  let v = 0;
  for (let p = 0; p < nPaths; p++) {
    const d = rates[(p * nSteps + step) * nTenors + ti] - mean;
    v += d * d;
  }
  return Math.sqrt(v / nPaths);
}

describe("H3: pathwise TS-vs-Python projection parity on the CMT convention", () => {
  it("HW projections agree with the Python reference at 1M / 6M / 1Y / 10Y, path by path", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    expect(curve.convention).toBe("semiannual_bond");

    const sim = simulateHW(curve, FIXTURE.hwParams.a, FIXTURE.hwParams.sigma, {
      horizonYears: FIXTURE.horizonYears,
      dtYears: FIXTURE.dtYears,
      nPairs: FIXTURE.nPairs,
      seed: BigInt(FIXTURE.seed),
    });

    for (let ti = 0; ti < FIXTURE.tenorLabels.length; ti++) {
      const label = FIXTURE.tenorLabels[ti];
      const proj = projectHWToTenor(sim, curve, FIXTURE.tenors[ti]);
      FIXTURE.samplePaths.forEach((p, pi) => {
        FIXTURE.sampleSteps.forEach((s, si) => {
          expect(
            proj[p][s],
            `HW ${label} path ${p} step ${s}`,
          ).toBeCloseTo(FIXTURE.hw[label][pi][si], 12);
        });
      });
    }
  });

  it("BGM projections agree with the Python reference at 1M / 6M / 1Y / 10Y, path by path", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const b = FIXTURE.bgmParams;
    const sim = simulateBGM(
      curve,
      { a: b.a, b: b.b, c: b.c, d: b.d, beta: b.beta, volScalar: b.vol_scalar, displacement: b.displacement, cevBeta: b.cev_beta },
      {
        horizonYears: FIXTURE.horizonYears,
        dtYears: FIXTURE.dtYears,
        nPairs: FIXTURE.nPairs,
        seed: BigInt(FIXTURE.seed),
        savedTenors: FIXTURE.tenors,
      },
    );

    FIXTURE.tenorLabels.forEach((label, ti) => {
      const idx = bgmTenorIndex(sim, FIXTURE.tenors[ti]);
      FIXTURE.samplePaths.forEach((p, pi) => {
        FIXTURE.sampleSteps.forEach((s, si) => {
          expect(
            getRate(sim, p, s, idx),
            `BGM ${label} path ${p} step ${s}`,
          ).toBeCloseTo(FIXTURE.bgm[label][pi][si], 12);
        });
      });
    });
  });

  it("the 1Y projection actually differs from its annual ACT/360 quote, so the gate has teeth", async () => {
    // If the semi-annual branch were a no-op the parity test above would pass
    // for the wrong reason. The 1Y point is where the two conventions diverge
    // most visibly among the sampled tenors: annual ACT/360 quotes it as a
    // simple-compounded forward, the Treasury basis as a single semi-annual
    // coupon at maturity.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const simple = curve.forwardRate(0, 1);
    const cmt = curve.forwardSwapRate(0, 1);
    expect(Math.abs(simple - cmt) * 1e4).toBeGreaterThan(0.1);
  });
});

describe("H2: BGM output rows are timestamped on the state they hold", () => {
  it("the first stored post-t0 row carries real cross-path dispersion", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const b = FIXTURE.bgmParams;
    const sim = simulateBGM(
      curve,
      { a: b.a, b: b.b, c: b.c, d: b.d, beta: b.beta, volScalar: b.vol_scalar, displacement: b.displacement, cevBeta: b.cev_beta },
      {
        horizonYears: FIXTURE.horizonYears,
        dtYears: FIXTURE.dtYears,
        nPairs: FIXTURE.nPairs,
        seed: BigInt(FIXTURE.seed),
        savedTenors: FIXTURE.tenors,
      },
    );
    const nSteps = sim.times.length;
    const nT = sim.tenors.length;

    // times[0] is one dt after t0, so the row must hold ONE evolution.
    expect(sim.times[0]).toBeCloseTo(FIXTURE.dtYears, 12);
    FIXTURE.tenorLabels.forEach((label, ti) => {
      const sd = crossPathSd(sim.rates, sim.nPaths, nSteps, nT, 0, ti);
      // The retired build returned exactly 0 here.
      expect(sd, `BGM ${label} first-row cross-path SD`).toBeGreaterThan(1e-4);
      expect(sd).toBeCloseTo(FIXTURE.bgmFirstStepSd[label], 12);
    });
  });
});

describe("H1: CEV predictor-corrector carries no spurious Ito drift", () => {
  /*
   * The retired corrector averaged the state-dependent local-vol prefactor
   * across predictor and corrector, prefBar = (prefP + prefC)/2, and applied
   * prefBar to the SAME Brownian increment the predictor had already used to
   * produce prefC. prefBar is therefore correlated with its own shock, and
   *   E[prefBar . (v.Z) sqrt(dt)] = 0.5 (beta_cev - 1) prefP^2 |v|^2 dt + O(dt^2)
   * per step. Note what that means: the bias is O(dt) PER STEP over O(1/dt)
   * steps, so it is O(1) over a fixed horizon and does NOT shrink as dt
   * shrinks. A dt-convergence test alone cannot see it. Both tests below are
   * therefore kept, and they do different jobs:
   *
   *   (a) the martingale test IS the H1 detector. The spurious drift feeds the
   *       numeraire accrual, so the UNCORRECTED per-step discount expectation
   *       drifts off the market curve. Measured on the shipped pack, 2y
   *       horizon, 1500 paths: retired scheme max |E[D_uncorr] - P^M| =
   *       0.526 bp at dt = 1/12 and 1.020 / 0.269 / 0.135 bp at dt =
   *       1/6, 1/24, 1/48; fixed scheme 0.010 bp at dt = 1/12, the same order
   *       as the lognormal branch's own discretisation error. Roughly a
   *       fiftyfold reduction, with the gate set well inside the gap.
   *
   *   (b) the convergence test is the general regression guard the fix wave
   *       asked for: it holds the scheme's first two moments to a settling
   *       sequence as dt halves, which catches a future discretisation error
   *       that IS dt-dependent.
   *
   * For the record, the H1 fix moves the terminal 1M forward mean at the 2y
   * horizon from 379.30 bp to 386.56 bp, +1.9%, i.e. it removes a downward
   * bias, which is the fan suppression the adversarial review measured at
   * about -9% displacement over 30y.
   */
  async function run(dtYears: number, cevBeta: number, nPairs: number) {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const b = FIXTURE.bgmParams;
    return simulateBGM(
      curve,
      { a: b.a, b: b.b, c: b.c, d: b.d, beta: b.beta, volScalar: b.vol_scalar, displacement: b.displacement, cevBeta },
      { horizonYears: 2.0, dtYears, nPairs, seed: 20250930n, savedTenors: [1 / 12] },
    );
  }

  function moments(sim: Awaited<ReturnType<typeof run>>) {
    const last = sim.times.length - 1;
    let mean = 0;
    for (let p = 0; p < sim.nPaths; p++) mean += getRate(sim, p, last, 0);
    mean /= sim.nPaths;
    let v = 0;
    for (let p = 0; p < sim.nPaths; p++) {
      const d = getRate(sim, p, last, 0) - mean;
      v += d * d;
    }
    return { mean, sd: Math.sqrt(v / sim.nPaths) };
  }

  const maxRawErrBp = (sim: Awaited<ReturnType<typeof run>>) =>
    Array.from(sim.rawErrorBps).reduce((m, e) => Math.max(m, Math.abs(e)), 0);

  it("the uncorrected numeraire stays on the market curve under CEV (the H1 detector)", async () => {
    const cev = await run(1 / 12, 0.5, 750);
    const logn = await run(1 / 12, 1.0, 750);
    // Retired scheme: 0.526 bp. Fixed scheme: 0.014 bp at this path count.
    expect(maxRawErrBp(cev)).toBeLessThan(0.05);
    // And the CEV branch must not be an order of magnitude worse than the
    // lognormal branch, which never carried the bug.
    expect(maxRawErrBp(cev)).toBeLessThan(10 * maxRawErrBp(logn) + 0.01);
  }, 180_000);

  it("terminal mean and SD settle as dt halves (CEV beta = 0.5)", async () => {
    const coarse = moments(await run(1 / 6, 0.5, 750));
    const mid = moments(await run(1 / 12, 0.5, 750));
    const fine = moments(await run(1 / 24, 0.5, 750));

    const dMeanCoarse = Math.abs(mid.mean - coarse.mean);
    const dMeanFine = Math.abs(fine.mean - mid.mean);
    const dSdCoarse = Math.abs(mid.sd - coarse.sd);
    const dSdFine = Math.abs(fine.sd - mid.sd);

    expect(dMeanFine).toBeLessThan(dMeanCoarse);
    expect(dSdFine).toBeLessThan(dSdCoarse);
    // Observed 0.06 bp and 0.97 bp between the two finest grids.
    expect(dMeanFine * 1e4).toBeLessThan(0.5);
    expect(dSdFine * 1e4).toBeLessThan(2.0);
  }, 180_000);

  it("terminal mean and SD settle as dt halves (lognormal limit, beta = 1)", async () => {
    // beta_cev = 1 short-circuits both prefactors to 1, so the drift-only
    // averaging is bit-identical to the retired scheme there. This pins that
    // the fix is confined to the CEV branch.
    const coarse = moments(await run(1 / 6, 1.0, 750));
    const mid = moments(await run(1 / 12, 1.0, 750));
    const fine = moments(await run(1 / 24, 1.0, 750));
    expect(Math.abs(fine.mean - mid.mean)).toBeLessThan(Math.abs(mid.mean - coarse.mean));
    expect(Math.abs(fine.sd - mid.sd)).toBeLessThan(Math.abs(mid.sd - coarse.sd));
  }, 180_000);
});

describe("M4: the caller's forward ceiling is honoured", () => {
  /*
   * The Settings drawer has always exposed an F_CEILING control (default 2.0,
   * i.e. a 200% forward), Run Info has always reported it, and the BGM tab has
   * always claimed that long-horizon tenor projections "inherit the F_CEILING
   * bound". None of that was true: simulateBGM accepted the option and threw
   * it away, clamping at the e^100 sentinel instead. Either the control had to
   * go or the cap had to be wired; the cap is wired, because a censoring
   * control the user can see and whose fires are reported is more useful in a
   * teaching lab than a silently unbounded tail.
   */
  async function capped(fCeiling?: number) {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    // Deliberately violent parameters so the cap has something to bite on.
    return simulateBGM(
      curve,
      { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403, displacement: 0, cevBeta: 1 },
      { horizonYears: 30.0, dtYears: 1 / 12, nPairs: 50, seed: 20250930n, ...(fCeiling === undefined ? {} : { fCeiling }) },
    );
  }

  it("a finite fCeiling censors the tail and the fires are reported", async () => {
    const capped2 = await capped(2.0);
    const uncapped = await capped();
    expect(capped2.fCeiling).toBe(2.0);
    // Censored evolutions are counted and surfaced (BgmSimTab reads nCapFires).
    expect(capped2.nCapFires).toBeGreaterThan(0);
    expect(uncapped.nCapFires).toBeLessThan(capped2.nCapFires);
    // The cap bounds the STATE F_hat, not the requoted yield: a 1D projection
    // quoted bond-equivalent amplifies a capped forward, so the assertion is
    // that the capped run's tail is materially below the uncapped run's.
    const maxOf = (r: Float64Array) => {
      let m = 0;
      for (let i = 0; i < r.length; i++) m = Math.max(m, r[i]);
      return m;
    };
    expect(maxOf(capped2.rates)).toBeLessThan(maxOf(uncapped.rates));
  }, 120_000);

  it("omitting it keeps the effectively unbounded sentinel", async () => {
    const sim = await capped();
    expect(sim.fCeiling).toBeGreaterThan(1e40);
  }, 120_000);

  it("the app's default ceiling does not censor the engine of record", async () => {
    // AppContext ships fCeiling = 2.0. Under the default engine (delta 0.05,
    // CEV 0.5) the 30y fan peaks far below 200%, so wiring the cap through
    // must not quietly start clipping the default run.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const b = FIXTURE.bgmParams;
    const sim = simulateBGM(
      curve,
      { a: b.a, b: b.b, c: b.c, d: b.d, beta: b.beta, volScalar: b.vol_scalar },
      { horizonYears: 30.0, dtYears: 1 / 12, nPairs: 250, seed: 20250930n, fCeiling: 2.0 },
    );
    expect(sim.nCapFires).toBe(0);
    expect(sim.nFloorFires).toBe(0);
  }, 120_000);
});
