import { describe, expect, it } from "vitest";
import {
  buildNonIbIncentiveSeries,
  cohortForwardSurvival,
  defaultAgeBuckets,
  seasonedStockSummary,
  simulateStock,
  steadyStateAgeWeights,
  stockRunoffFromSurvival,
  walFromBalance,
  solveMaxRateDecayForStockWal,
  type AgeBucket,
} from "../nmdStock";
import {
  balanceSensitivity,
  surface3DData,
  type BalanceBucket,
} from "../../behavioral/nmdModel";
import { NMD_TERMS_DEFAULTS, NMDeposit } from "../../instruments/nmd";
import { DeterministicRatePath } from "../../rates/ratePath";
import type { RatePath } from "../../instruments/types";

/** Flat continuously-compounded curve at `rate` (decimal). The path's 1M reads `rate`. */
function flatPath(rate: number, nSteps: number): RatePath {
  const stub = {
    t: [],
    z: [],
    zeroRate: () => rate,
    discountFactor: (t: number) => Math.exp(-rate * t),
    forwardRate: () => rate,
    forwardRateBey: () => rate,
    forwardSwapRate: () => rate,
  };
  return new DeterministicRatePath(stub as never, nSteps);
}

const flatHistory = (ratePct: number, n: number): number[] => new Array(n).fill(ratePct);

const NONIB = NMD_TERMS_DEFAULTS.nmdParams;

describe("surface3DData", () => {
  it("z is the outer product of g(balance) and the incentive logistic", () => {
    const surf = surface3DData(NONIB, { nBal: 12, nSpread: 10 });
    expect(surf.balance.length).toBe(13);
    expect(surf.spread.length).toBe(11);
    expect(surf.z.length).toBe(11); // z indexed [spread][balance]
    expect(surf.z[0].length).toBe(13);

    const baseAt = (s: number) =>
      NONIB.maxRateGrowth +
      (NONIB.maxRateDecay - NONIB.maxRateGrowth) /
        (1 + Math.exp(-NONIB.logisticK * (s - NONIB.logisticMidpoint)));

    for (const [i, s] of surf.spread.entries()) {
      for (const [j, b] of surf.balance.entries()) {
        expect(surf.z[i][j]).toBeCloseTo(balanceSensitivity(b, NONIB.sens) * baseAt(s), 9);
      }
    }
  });
});

describe("cohortForwardSurvival", () => {
  it("age-0 single bucket reproduces NMDeposit.simulateBook per-bucket survival", () => {
    const nSteps = 120;
    const ratePct = 4.0;
    const hist = flatHistory(ratePct, NONIB.maPeriod + 12);
    const path = flatPath(ratePct / 100, nSteps);

    const inst = new NMDeposit(
      { ...NMD_TERMS_DEFAULTS, notional: 1_000_000, maturityMonths: nSteps },
      hist,
    );
    const book = inst.simulateBook(path);
    const buckets = NONIB.buckets;
    // pick the largest bucket so g is most pronounced
    const bi = buckets.length - 1;
    const g = balanceSensitivity(buckets[bi].repBalance, NONIB.sens);

    const { baseIncentive, rateMultiplier } = buildNonIbIncentiveSeries(
      path,
      hist,
      NONIB,
      nSteps,
    );
    const surv = cohortForwardSurvival({
      startAgeMonths: 0,
      closureSteady: NONIB.closureSteady,
      closureInitial: NONIB.closureInitial,
      closureTauMonths: NONIB.closureTauMonths,
      burnoutLambda: NONIB.burnoutLambda,
      g,
      baseIncentive,
      rateMultiplier,
    });

    // simulateBook byBucket[bi] is the OPENING balance of bucket bi at each month;
    // opening of month m+1 == closing of month m. Compare survival fractions away
    // from the final forced-drain row.
    const open0 = book[0].byBucket[bi];
    for (let m = 5; m < nSteps - 2; m += 10) {
      const openNext = book[m].byBucket[bi]; // opening of month m+1 = survival after m
      expect(surv[m - 1]).toBeCloseTo(openNext / open0, 6);
    }
  });

  it("a seasoned vintage decays slower early than a fresh cohort (declining closure ramp)", () => {
    const nSteps = 60;
    const ratePct = 4.0;
    const hist = flatHistory(ratePct, NONIB.maPeriod + 12);
    const path = flatPath(ratePct / 100, nSteps);
    const g = balanceSensitivity(500_000, NONIB.sens);
    const { baseIncentive, rateMultiplier } = buildNonIbIncentiveSeries(
      path,
      hist,
      NONIB,
      nSteps,
    );
    const common = {
      closureSteady: NONIB.closureSteady,
      closureInitial: NONIB.closureInitial,
      closureTauMonths: NONIB.closureTauMonths,
      burnoutLambda: NONIB.burnoutLambda,
      g,
      baseIncentive,
      rateMultiplier,
    };
    const fresh = cohortForwardSurvival({ ...common, startAgeMonths: 0 });
    const seasoned = cohortForwardSurvival({ ...common, startAgeMonths: 60 });
    // closureInitial (2.0) > closureSteady (0.75): the fresh cohort carries the
    // higher early closure, so the seasoned vintage survives more at every horizon.
    for (let m = 1; m <= 24; m++) {
      expect(seasoned[m - 1]).toBeGreaterThan(fresh[m - 1]);
    }
  });
});

describe("steadyStateAgeWeights / defaultAgeBuckets", () => {
  it("weights are proportional to survival at the nodes and sum to 1", () => {
    const survival = Array.from({ length: 240 }, (_, k) => Math.exp(-0.02 * (k + 1)));
    const nodes = [0, 12, 24, 60, 120];
    const w = steadyStateAgeWeights(survival, nodes);
    expect(w.length).toBe(nodes.length);
    expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    // monotone decreasing for a decreasing survival curve
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeLessThan(w[i - 1]);
  });

  it("defaultAgeBuckets returns nNodes increasing-age buckets whose shares sum to 1", () => {
    const survival = Array.from({ length: 360 }, (_, k) => Math.exp(-0.015 * (k + 1)));
    const buckets = defaultAgeBuckets(survival, 6);
    expect(buckets.length).toBe(6);
    expect(buckets.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 9);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].ageMonths).toBeGreaterThan(buckets[i - 1].ageMonths);
    }
  });
});

describe("stockRunoffFromSurvival", () => {
  it("R(0) normalises to 1 and the schedule is non-increasing", () => {
    const survival = Array.from({ length: 120 }, (_, k) => Math.exp(-0.03 * (k + 1)));
    const R = stockRunoffFromSurvival(survival);
    expect(R[0]).toBeLessThanOrEqual(1);
    for (let i = 1; i < R.length; i++) expect(R[i]).toBeLessThanOrEqual(R[i - 1] + 1e-12);
  });
});

describe("simulateStock (vintage superposition)", () => {
  it("on a flat path with survival-weighted vintages, equals the exact age-offset superposition", () => {
    // Single size bucket so g is constant. On a flat path the forward survival of
    // a vintage of age a equals A[a+t]/A[a] (A = age-0 survival), so the stock at
    // forward time t is exactly (sum_a A[a+t]) / (sum_a A[a]). This verifies that
    // cohortForwardSurvival's age offset matches the tail of the age-0 curve.
    const nSteps = 180;
    const maxAge = 240;
    const ratePct = 4.0;
    const hist = flatHistory(ratePct, NONIB.maPeriod + 12);
    const g = balanceSensitivity(500_000, NONIB.sens);

    // Reference age-0 survival long enough that vintage propagation (age up to
    // maxAge-1, forward up to nSteps) never runs past the array.
    const longPath = flatPath(ratePct / 100, maxAge + nSteps);
    const longSeries = buildNonIbIncentiveSeries(longPath, hist, NONIB, maxAge + nSteps);
    const refSurv = cohortForwardSurvival({
      startAgeMonths: 0,
      closureSteady: NONIB.closureSteady,
      closureInitial: NONIB.closureInitial,
      closureTauMonths: NONIB.closureTauMonths,
      burnoutLambda: NONIB.burnoutLambda,
      g,
      baseIncentive: longSeries.baseIncentive,
      rateMultiplier: longSeries.rateMultiplier,
    });
    const A = (j: number): number => (j === 0 ? 1 : refSurv[j - 1]);

    // Fine age grid (every month) weighted by survival.
    const ageBuckets: AgeBucket[] = [];
    let wsum = 0;
    for (let a = 0; a < maxAge; a++) wsum += A(a);
    for (let a = 0; a < maxAge; a++) ageBuckets.push({ ageMonths: a, share: A(a) / wsum });

    const series = buildNonIbIncentiveSeries(flatPath(ratePct / 100, nSteps), hist, NONIB, nSteps);
    const sizeBuckets: BalanceBucket[] = [{ label: "one", repBalance: 500_000, share: 1 }];
    const stock = simulateStock({
      nSteps,
      sizeBuckets,
      ageBuckets,
      sens: NONIB.sens,
      closureSteady: NONIB.closureSteady,
      closureInitial: NONIB.closureInitial,
      closureTauMonths: NONIB.closureTauMonths,
      burnoutLambda: NONIB.burnoutLambda,
      baseIncentive: series.baseIncentive,
      rateMultiplier: series.rateMultiplier,
    });

    const expectedAt = (t: number): number => {
      let num = 0;
      for (let a = 0; a < maxAge; a++) num += A(a + t);
      return num / wsum;
    };
    for (let m = 1; m <= 120; m += 12) {
      expect(stock.balance[m - 1]).toBeCloseTo(expectedAt(m), 8);
    }
  });

  it("the seasoned stock WAL exceeds the fresh-cohort WAL for the Non-IB calibration", () => {
    const nSteps = 360;
    const ratePct = 4.0;
    const hist = flatHistory(ratePct, NONIB.maPeriod + 12);
    const path = flatPath(ratePct / 100, nSteps);
    const series = buildNonIbIncentiveSeries(path, hist, NONIB, nSteps);

    // Fresh cohort WAL: the size-weighted age-0 book.
    const sizeBuckets = NONIB.buckets;
    const cohortBuckets: AgeBucket[] = [{ ageMonths: 0, share: 1 }];
    const cohort = simulateStock({
      nSteps,
      sizeBuckets,
      ageBuckets: cohortBuckets,
      sens: NONIB.sens,
      closureSteady: NONIB.closureSteady,
      closureInitial: NONIB.closureInitial,
      closureTauMonths: NONIB.closureTauMonths,
      burnoutLambda: NONIB.burnoutLambda,
      baseIncentive: series.baseIncentive,
      rateMultiplier: series.rateMultiplier,
    });

    // Seasoned stock: survival-weighted vintages.
    const refSurv = cohortForwardSurvival({
      startAgeMonths: 0,
      closureSteady: NONIB.closureSteady,
      closureInitial: NONIB.closureInitial,
      closureTauMonths: NONIB.closureTauMonths,
      burnoutLambda: NONIB.burnoutLambda,
      g: balanceSensitivity(500_000, NONIB.sens),
      baseIncentive: series.baseIncentive,
      rateMultiplier: series.rateMultiplier,
    });
    const ageBuckets = defaultAgeBuckets(refSurv, 6);
    const stock = simulateStock({
      nSteps,
      sizeBuckets,
      ageBuckets,
      sens: NONIB.sens,
      closureSteady: NONIB.closureSteady,
      closureInitial: NONIB.closureInitial,
      closureTauMonths: NONIB.closureTauMonths,
      burnoutLambda: NONIB.burnoutLambda,
      baseIncentive: series.baseIncentive,
      rateMultiplier: series.rateMultiplier,
    });

    expect(stock.wal).toBeGreaterThan(cohort.wal);
  });
});

describe("walFromBalance", () => {
  it("a balance that halves linearly to zero over N months has WAL ~ N/2 (+tail)", () => {
    const N = 120;
    const balance = new Float64Array(N);
    for (let m = 1; m <= N; m++) balance[m - 1] = Math.max(0, 1 - m / N);
    // linear runoff 1->0 over N months: WAL = mean runoff time ~ (N/2)/12 years
    expect(walFromBalance(balance)).toBeCloseTo((N / 2) / 12, 1);
  });
});

describe("solveMaxRateDecayForStockWal", () => {
  it("solves maxRateDecay so the seasoned stock WAL hits a 5y target", () => {
    const nSteps = 360;
    const ratePct = 4.0;
    const hist = flatHistory(ratePct, NONIB.maPeriod + 12);
    const path = flatPath(ratePct / 100, nSteps);
    const targetYears = 5;

    const stockWalFor = (maxRateDecay: number): number => {
      const params = { ...NONIB, maxRateDecay };
      const series = buildNonIbIncentiveSeries(path, hist, params, nSteps);
      const refSurv = cohortForwardSurvival({
        startAgeMonths: 0,
        closureSteady: params.closureSteady,
        closureInitial: params.closureInitial,
        closureTauMonths: params.closureTauMonths,
        burnoutLambda: params.burnoutLambda,
        g: balanceSensitivity(500_000, params.sens),
        baseIncentive: series.baseIncentive,
        rateMultiplier: series.rateMultiplier,
      });
      const ageBuckets = defaultAgeBuckets(refSurv, 6);
      const stock = simulateStock({
        nSteps,
        sizeBuckets: params.buckets,
        ageBuckets,
        sens: params.sens,
        closureSteady: params.closureSteady,
        closureInitial: params.closureInitial,
        closureTauMonths: params.closureTauMonths,
        burnoutLambda: params.burnoutLambda,
        baseIncentive: series.baseIncentive,
        rateMultiplier: series.rateMultiplier,
      });
      return stock.wal;
    };

    const solved = solveMaxRateDecayForStockWal(targetYears, stockWalFor, { lo: 0.1, hi: 60 });
    expect(stockWalFor(solved)).toBeCloseTo(targetYears, 1);
  });
});

describe("seasonedStockSummary", () => {
  const nSteps = 360;
  const ratePct = 4.0;
  const hist = flatHistory(ratePct, NONIB.maPeriod + 12);
  const series = () =>
    buildNonIbIncentiveSeries(flatPath(ratePct / 100, nSteps), hist, NONIB, nSteps);

  it("reports stock and cohort WAL in months, with stock stickier than the fresh cohort", () => {
    const { baseIncentive, rateMultiplier } = series();
    const s = seasonedStockSummary({ nSteps, params: NONIB, baseIncentive, rateMultiplier });

    // months readouts are the simulateStock years × 12
    expect(s.stockWalMonths).toBeCloseTo(s.stock.wal * 12, 9);
    expect(s.cohortWalMonths).toBeCloseTo(s.cohort.wal * 12, 9);
    // declining closure ramp ⇒ survivor-weighted stock is stickier than age-0
    expect(s.stockWalMonths).toBeGreaterThan(s.cohortWalMonths);
  });

  it("defaults to a steady-state age grid of nAgeNodes increasing-age buckets summing to 1", () => {
    const { baseIncentive, rateMultiplier } = series();
    const s = seasonedStockSummary({ nSteps, params: NONIB, baseIncentive, rateMultiplier, nAgeNodes: 6 });
    expect(s.ageBuckets.length).toBe(6);
    expect(s.ageBuckets.reduce((acc, b) => acc + b.share, 0)).toBeCloseTo(1, 9);
    for (let i = 1; i < s.ageBuckets.length; i++) {
      expect(s.ageBuckets[i].ageMonths).toBeGreaterThan(s.ageBuckets[i - 1].ageMonths);
    }
  });

  it("an age-0 override collapses the seasoned stock onto the fresh cohort", () => {
    const { baseIncentive, rateMultiplier } = series();
    const s = seasonedStockSummary({
      nSteps,
      params: NONIB,
      baseIncentive,
      rateMultiplier,
      ageBuckets: [{ ageMonths: 0, share: 1 }],
    });
    expect(s.ageBuckets).toEqual([{ ageMonths: 0, share: 1 }]);
    expect(s.stockWalMonths).toBeCloseTo(s.cohortWalMonths, 9);
    for (let m = 0; m < nSteps; m++) {
      expect(s.stock.balance[m]).toBeCloseTo(s.cohort.balance[m], 9);
    }
  });
});
