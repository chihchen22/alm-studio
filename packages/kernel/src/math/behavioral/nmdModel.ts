/**
 * NMD (non-maturity deposit) decay model.
 *
 * Per the model audit memo (Sec 9), this is *illustrative only*. The math is
 * preserved for engine demonstration.
 *
 * Mechanics:
 *   1. Baseline closure: age-ramped relationship attrition, %/mo.
 *   2. Rate-driven incentive (Non-IB): the opportunity-cost logistic on the spot
 *      LEVEL r (maxDecay, maxGrowth, K, midpoint), amplified by the regime
 *      excursion 1 + α·max(0, r − r̄_maPeriod) and a Schwartz-Torous burnout B(t).
 *      The amplifier captures surge path-dependency — a rate above its trailing
 *      regime runs off the accumulated low-yield surge faster; at or below the
 *      regime it is dormant (=1). (The IB sibling, nmdBeta, drives the logistic
 *      off the r − D spread instead.)
 *   3. Balance-sensitivity surface (replaces the old binary insured/uninsured
 *      tranche): every dollar is rate-sensitive, but the sensitivity rises with
 *      account size. A logistic-in-log-balance multiplier g(b) ∈ [g_min, g_max]
 *      scales the rate-driven incentive — subtle below the insured threshold,
 *      ramping through ~$1M, plateauing past ~$5M. The book is partitioned into
 *      account-size buckets; each bucket runs the same closure + incentive
 *      with its own g(b̄_i), and the portfolio decay/WAL is the balance-weighted
 *      aggregate. The decay over (balance, spread) is the outer product of the
 *      balance logistic g(b) and the spread logistic — the rate-sensitivity
 *      surface.
 *
 * Path dependency:
 *   - Burnout B(t) = exp(−λ_b · C(t)), C(t) = Σ_{s<t} max(0, base_incentive(s)).
 *     λ_b = 0 disables burnout.
 *   - Age-ramped closure: closure(t) = closure_steady + (closure_initial −
 *     closure_steady)·exp(−t/τ). closure_initial = closure_steady disables the ramp.
 *   - Combined per-bucket decay: 1 − (1 − closure) × (1 − g(b̄)·incentive).
 *
 * Historical SOFR overlay (Jan 2001 – Feb 2026, piecewise-linear FOMC anchors)
 * provides the warmup MA window so the simulation's first months reference
 * actual rate cycles.
 */

/** Logistic-in-log-balance rate-sensitivity multiplier g(b) ∈ [gMin, gMax]. */
export interface BalanceSensitivityParams {
  /** Sensitivity floor for tiny balances (small but non-zero). */
  gMin: number;
  /** Sensitivity ceiling for large balances. */
  gMax: number;
  /** Inflection balance (dollars) — the steepest point of g(b). */
  bStar: number;
  /** Steepness of g(b) in log-balance space. */
  kappaB: number;
}

/** One account-size bucket: a share of the book at a representative balance. */
export interface BalanceBucket {
  /** Display label (e.g. "≤ $250k"). */
  label: string;
  /** Representative account balance for the bucket (dollars). */
  repBalance: number;
  /** Share of total book balance, in [0, 1]; shares sum to 1. */
  share: number;
}

/**
 * Balance-sensitivity multiplier g(b): a logistic in log-balance.
 *   g(b) = gMin + (gMax − gMin) / (1 + exp(−kappaB·(ln b − ln bStar)))
 * Gentle below the insured threshold, ramps through bStar, plateaus above.
 */
export function balanceSensitivity(balance: number, p: BalanceSensitivityParams): number {
  if (balance <= 0 || p.bStar <= 0) return p.gMin;
  const x = p.kappaB * (Math.log(balance) - Math.log(p.bStar));
  return p.gMin + (p.gMax - p.gMin) / (1 + Math.exp(-x));
}

export interface NMDParams {
  /** Steady-state closure rate %/mo. Baseline once the age ramp settles. */
  closureSteady: number;
  /** Initial closure rate %/mo at t=0. Equals closureSteady to disable ramp. */
  closureInitial: number;
  /** Time constant (months) for closure age ramp; ramp settles by ~3·τ. */
  closureTauMonths: number;
  /** Burnout exponential rate. λ_b=0 disables burnout. */
  burnoutLambda: number;
  maxRateDecay: number; // % at high spread (high rates -> outflow)
  maxRateGrowth: number; // % at low spread (low rates -> inflow). Negative => inflow.
  logisticK: number;
  logisticMidpoint: number;
  maPeriod: number; // months — trailing window for the regime moving average r̄
  /**
   * Regime amplification α (excursion amplifier). The rate-incentive limb is
   * scaled by 1 + α·max(0, r − r̄_maPeriod): when the spot rate exceeds its
   * trailing-MA regime (surge of low-yield deposits now repricing out) decay
   * accelerates; when it is at or below the regime the amplifier is 1 (dormant).
   * Excursion is in percentage points; α = 0 disables amplification.
   */
  regimeAlpha: number;
  /** Total book balance in dollars (partitioned across buckets by share). */
  balanceSize: number;
  /** Balance-sensitivity surface params (replaces the binary insured threshold). */
  sens: BalanceSensitivityParams;
  /** Account-size buckets partitioning the book; shares sum to 1. */
  buckets: BalanceBucket[];
}

/** Shared default g(b) shape: gentle ≤$250k, ramp to ~$1.1M, plateau ≥$5M. */
export const BALANCE_SENS_DEFAULTS: BalanceSensitivityParams = {
  gMin: 0.15,
  gMax: 1.0,
  bStar: 1_100_000,
  kappaB: 1.3,
};

/** Non-IB book: retail-skewed account-size distribution (sticky core). */
export const NONIB_BUCKETS: BalanceBucket[] = [
  { label: "≤ $250k", repBalance: 100_000, share: 0.45 },
  { label: "$250k–$1M", repBalance: 500_000, share: 0.25 },
  { label: "$1M–$5M", repBalance: 2_500_000, share: 0.2 },
  { label: "> $5M", repBalance: 10_000_000, share: 0.1 },
];

/** IB book: commercial-skewed (more large, rate-aware balances). */
export const IB_BUCKETS: BalanceBucket[] = [
  { label: "≤ $250k", repBalance: 150_000, share: 0.2 },
  { label: "$250k–$1M", repBalance: 600_000, share: 0.25 },
  { label: "$1M–$5M", repBalance: 2_500_000, share: 0.3 },
  { label: "> $5M", repBalance: 15_000_000, share: 0.25 },
];

export const NMD_DEFAULTS: NMDParams = {
  closureSteady: 0.75,
  closureInitial: 2.0,
  closureTauMonths: 24,
  burnoutLambda: 0.1,
  maxRateDecay: 3.0,
  maxRateGrowth: -1.0,
  logisticK: 2.0,
  logisticMidpoint: 0.0,
  maPeriod: 24,
  regimeAlpha: 2.0,
  balanceSize: 1_000_000,
  sens: BALANCE_SENS_DEFAULTS,
  buckets: NONIB_BUCKETS,
};

/**
 * Regime amplifier (excursion form): 1 + α·max(0, r − r̄), where r is the
 * spot rate (% pa), r̄ is the trailing moving-average regime (% pa), and α is the
 * amplification per percentage point of positive excursion. One-sided: at or
 * below the regime the amplifier is 1. Because it depends on the spread r − r̄,
 * it is invariant to a permanent parallel shift (both r and r̄ move together),
 * so it needs no freeze under a parallel EVE shock — unlike a rate-LEVEL term.
 */
export function regimeAmplifier(ratePct: number, maPct: number, alpha: number): number {
  return 1 + alpha * Math.max(0, ratePct - maPct);
}

/** Normalised bucket shares (defends against shares that do not sum to 1). */
export function normalizedBuckets(buckets: ReadonlyArray<BalanceBucket>): BalanceBucket[] {
  const total = buckets.reduce((s, b) => s + Math.max(0, b.share), 0);
  if (total <= 0) return buckets.map((b) => ({ ...b, share: 1 / buckets.length }));
  return buckets.map((b) => ({ ...b, share: Math.max(0, b.share) / total }));
}

/**
 * An illustrative one-month rate path, percent per annum, by month from Jan 2001
 * to Feb 2026: piecewise-linear between hand-set anchors at policy turning points.
 * Not a published series. Used as the default warmup window for the moving average
 * when a run names no deposit history.
 */
export function buildHistoricalSOFR1M(): number[] {
  const anchors: Array<{ m: number; r: number }> = [
    { m: 0, r: 6.0 },     // Jan 2001
    { m: 11, r: 1.75 },   // Dec 2001
    { m: 35, r: 1.0 },    // Dec 2003
    { m: 41, r: 1.0 },    // Jun 2004
    { m: 65, r: 5.25 },   // Jun 2006
    { m: 79, r: 5.25 },   // Aug 2007
    { m: 95, r: 0.1 },    // Dec 2008
    { m: 179, r: 0.1 },   // Dec 2015
    { m: 215, r: 2.4 },   // Dec 2018
    { m: 227, r: 1.55 },  // Dec 2019
    { m: 230, r: 0.05 },  // Mar 2020
    { m: 253, r: 0.05 },  // Feb 2022
    { m: 263, r: 4.3 },   // Dec 2022
    { m: 271, r: 5.3 },   // Aug 2023
    { m: 284, r: 5.3 },   // Sep 2024
    { m: 299, r: 3.8 },   // Dec 2025
    { m: 301, r: 3.66 },  // Feb 2026
  ];
  const out: number[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const start = anchors[i];
    const end = anchors[i + 1];
    const steps = end.m - start.m;
    for (let j = 0; j < steps; j++) {
      out.push(start.r + (end.r - start.r) * (j / steps));
    }
  }
  out.push(anchors[anchors.length - 1].r);
  return out;
}

/**
 * Month index of Sep 2025 in the historical series (Jan 2001 = month 0),
 * aligned with the bundled market snapshot's 2025-09-30 as-of date.
 */
export const HISTORICAL_ASOF_INDEX_SEP_2025 = 296;

/**
 * Warmup slice of the historical series ending at the snapshot's as-of date.
 * The simulation's t=0 is Oct 2025, so the MA warmup must stop at Sep 2025;
 * splicing the full series (through Feb 2026) ahead of the path would let
 * the MA window read five months after the as-of date as if they were the past.
 */
export function buildWarmupSOFR1M(): number[] {
  return buildHistoricalSOFR1M().slice(0, HISTORICAL_ASOF_INDEX_SEP_2025 + 1);
}

export interface NMDScenarioOutput {
  decayMean: Float64Array; // % per month
  decayP5: Float64Array;
  decayP95: Float64Array;
  balMean: Float64Array; // normalised
  balP5: Float64Array;
  balP95: Float64Array;
  wal: number; // years (path-mean)
  lifeDecay: number; // % (balance-weighted, path-mean)
}

function percentile(arr: ArrayLike<number>, q: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

/**
 * Run the NMD decay model on an array of rate paths.
 *
 * Balance-sensitivity surface form: the book is partitioned into account-size
 * buckets. Each bucket runs the same closure(t) + one-sided rate incentive, but
 * the incentive is scaled by g(b̄_i) — small balances barely rate-shop, large
 * balances respond fully. The portfolio decay/balance/WAL are the
 * balance-weighted aggregate across buckets.
 *
 * @param paths Array of 1M rate paths in DECIMAL terms.
 * @param params Logistic + MA + balance-sensitivity parameters.
 * @param historicalSOFR1M Historical 1M rates (% per annum) used to warm up
 *   the MA window. Must be at least `maPeriod` long.
 * The rate-incentive limb is the opportunity-cost logistic on the spot LEVEL r
 * times the regime amplifier 1 + α·max(0, r − r̄_maPeriod) (α = params.regimeAlpha).
 */
export function runNMDOnPaths(
  paths: ArrayLike<Float64Array>,
  params: NMDParams,
  historicalSOFR1M: ReadonlyArray<number>,
): NMDScenarioOutput {
  const nPaths = paths.length;
  if (nPaths === 0) {
    throw new Error("runNMDOnPaths: paths must be non-empty");
  }
  const nSteps = paths[0].length;
  const S0 = params.balanceSize;
  const buckets = normalizedBuckets(params.buckets);
  const gByBucket = buckets.map((b) => balanceSensitivity(b.repBalance, params.sens));

  const allDecay: Float64Array[] = new Array(nSteps);
  const allBal: Float64Array[] = new Array(nSteps);
  for (let t = 0; t < nSteps; t++) {
    allDecay[t] = new Float64Array(nPaths);
    allBal[t] = new Float64Array(nPaths);
  }

  let sumWal = 0;
  let sumLifeDecay = 0;

  for (let p = 0; p < nPaths; p++) {
    const path = paths[p];
    const pathRatesPct = new Float64Array(nSteps);
    for (let t = 0; t < nSteps; t++) pathRatesPct[t] = path[t] * 100;
    const fullHistory = [...historicalSOFR1M, ...Array.from(pathRatesPct)];
    const offset = historicalSOFR1M.length;

    const bal = buckets.map((b) => S0 * b.share);
    let cumIncentive = 0;
    let walSum = 0;
    let balSum = 0;
    let decayWeightSum = 0;

    for (let t = 1; t <= nSteps; t++) {
      const idx = offset + t - 1;
      const currentRate = fullHistory[idx];

      let maSum = 0;
      for (let j = 1; j <= params.maPeriod; j++) maSum += fullHistory[idx - j];
      const ma = maSum / params.maPeriod;

      // Opportunity-cost incentive: one-sided logistic on the spot LEVEL r.
      const baseIncentive = nmdIncentiveAt(params, currentRate);
      // Regime amplifier: 1 + α·max(0, r − r̄). Dormant when r ≤ r̄.
      const regimeAmp = regimeAmplifier(currentRate, ma, params.regimeAlpha);

      const burnoutB = Math.exp(-params.burnoutLambda * cumIncentive);
      const tau = Math.max(params.closureTauMonths, 1e-6);
      const closureT =
        params.closureSteady +
        (params.closureInitial - params.closureSteady) * Math.exp(-(t - 1) / tau);
      const closureFactor = 1 - closureT / 100;

      let totalBefore = 0;
      let totalDecay = 0;
      for (let i = 0; i < buckets.length; i++) {
        totalBefore += bal[i];
        // Balance-graded rate incentive: g(b̄_i) scales the level logistic.
        const rateIncentiveDecay = Math.max(0, baseIncentive * burnoutB * regimeAmp * gByBucket[i]);
        const decayDecimal = 1 - closureFactor * (1 - rateIncentiveDecay / 100);
        const decayAmt = Math.max(0, bal[i] * decayDecimal);
        bal[i] = Math.max(0, bal[i] - decayAmt);
        totalDecay += decayAmt;
      }
      const newTotal = totalBefore - totalDecay;
      const actualDecay = totalBefore > 0 ? (totalDecay / totalBefore) * 100 : 0;
      const balDisplay = (totalBefore / S0) * 100;

      allDecay[t - 1][p] = actualDecay;
      allBal[t - 1][p] = (newTotal / S0) * 100;

      balSum += balDisplay;
      decayWeightSum += actualDecay * balDisplay;

      if (totalDecay > 0) walSum += (totalDecay / S0) * (t / 12);

      if (baseIncentive > 0) cumIncentive += baseIncentive;
    }

    // Tail piece for any balance still alive at horizon.
    const residual = bal.reduce((s, v) => s + v, 0);
    walSum += (residual / S0) * (nSteps / 12);
    sumWal += walSum;
    sumLifeDecay += balSum > 0 ? decayWeightSum / balSum : 0;
  }

  const decayMean = new Float64Array(nSteps);
  const decayP5 = new Float64Array(nSteps);
  const decayP95 = new Float64Array(nSteps);
  const balMean = new Float64Array(nSteps);
  const balP5 = new Float64Array(nSteps);
  const balP95 = new Float64Array(nSteps);

  for (let t = 0; t < nSteps; t++) {
    if (nPaths === 1) {
      decayMean[t] = allDecay[t][0];
      decayP5[t] = allDecay[t][0];
      decayP95[t] = allDecay[t][0];
      balMean[t] = allBal[t][0];
      balP5[t] = allBal[t][0];
      balP95[t] = allBal[t][0];
    } else {
      const sortedDecay = Array.from(allDecay[t]).sort((a, b) => a - b);
      const sortedBal = Array.from(allBal[t]).sort((a, b) => a - b);
      decayMean[t] = sortedDecay.reduce((s, v) => s + v, 0) / nPaths;
      decayP5[t] = percentile(sortedDecay, 0.05);
      decayP95[t] = percentile(sortedDecay, 0.95);
      balMean[t] = sortedBal.reduce((s, v) => s + v, 0) / nPaths;
      balP5[t] = percentile(sortedBal, 0.05);
      balP95[t] = percentile(sortedBal, 0.95);
    }
  }

  return {
    decayMean,
    decayP5,
    decayP95,
    balMean,
    balP5,
    balP95,
    wal: sumWal / nPaths,
    lifeDecay: sumLifeDecay / nPaths,
  };
}

/**
 * Static logistic decay-curve diagnostic (rate incentive vs the driver, g = gMax).
 * The driver is the rate LEVEL for Non-IB (pass {min:0,max:8}) or the r−MA / r−D
 * spread for the default [-4,4] range; the `spread` key holds the x-grid value
 * either way. Default range is unchanged so the IB tab is unaffected.
 */
export function nmdSCurveData(
  params: NMDParams,
  opts: { min?: number; max?: number; step?: number } = {},
): Array<{ spread: number; incentive: number }> {
  const min = opts.min ?? -4.0;
  const max = opts.max ?? 4.0;
  const step = opts.step ?? 0.1;
  const out: Array<{ spread: number; incentive: number }> = [];
  for (let s = min; s <= max + step / 100; s += step) {
    out.push({ spread: Number(s.toFixed(2)), incentive: nmdIncentiveAt(params, s) * params.sens.gMax });
  }
  return out;
}

/**
 * Balance-sensitivity curve g(b): the rate-sensitivity multiplier vs account
 * balance on a log-balance grid ($10k → $50M). The S-curve is gentle below the
 * insured threshold, ramps through bStar, and plateaus for large accounts.
 */
export function balanceSensitivityCurve(
  params: NMDParams,
): Array<{ balance: number; g: number }> {
  const out: Array<{ balance: number; g: number }> = [];
  const logMin = Math.log(10_000);
  const logMax = Math.log(50_000_000);
  const nSteps = 60;
  for (let i = 0; i <= nSteps; i++) {
    const balance = Math.exp(logMin + (i / nSteps) * (logMax - logMin));
    out.push({ balance, g: balanceSensitivity(balance, params.sens) });
  }
  return out;
}

/**
 * Surface slices: the rate incentive vs spread at three representative account
 * balances (small / mid / large), showing how g(b) scales the spread logistic.
 * Together these three curves are slices of the (balance, spread) surface.
 */
export function nmdSurfaceSlices(
  params: NMDParams,
): Array<{ spread: number; small: number; mid: number; large: number }> {
  const buckets = params.buckets;
  const reps =
    buckets.length >= 3
      ? [buckets[0].repBalance, buckets[Math.floor(buckets.length / 2)].repBalance, buckets[buckets.length - 1].repBalance]
      : [100_000, 1_000_000, 10_000_000];
  const g = reps.map((b) => balanceSensitivity(b, params.sens));
  const baseAt = (s: number): number => {
    const expTerm = Math.exp(-params.logisticK * (s - params.logisticMidpoint));
    return params.maxRateGrowth + (params.maxRateDecay - params.maxRateGrowth) / (1 + expTerm);
  };
  const out: Array<{ spread: number; small: number; mid: number; large: number }> = [];
  for (let s = -4.0; s <= 4.01; s += 0.1) {
    const base = baseAt(s);
    out.push({
      spread: Number(s.toFixed(2)),
      small: base * g[0],
      mid: base * g[1],
      large: base * g[2],
    });
  }
  return out;
}

/**
 * Rate-sensitivity surface z = g(b) · S(spread) over a (balance, spread) grid.
 * z is the outer product of the balance logistic g(b) and the spread logistic —
 * the same object whose two factors drive every bucket's decay. Indexed
 * z[spreadIdx][balanceIdx] to match the VolSurface3D grid contract
 * (z[row=y][col=x] with x = balance, y = spread). Balances are log-spaced.
 */
export function surface3DData(
  params: NMDParams,
  opts: {
    nBal?: number;
    nSpread?: number;
    balMin?: number;
    balMax?: number;
    spreadMin?: number;
    spreadMax?: number;
  } = {},
): { balance: number[]; spread: number[]; z: number[][] } {
  const nBal = opts.nBal ?? 40;
  const nSpread = opts.nSpread ?? 40;
  const balMin = opts.balMin ?? 10_000;
  const balMax = opts.balMax ?? 50_000_000;
  const spreadMin = opts.spreadMin ?? -4;
  const spreadMax = opts.spreadMax ?? 4;
  const logMin = Math.log(balMin);
  const logMax = Math.log(balMax);

  const balance: number[] = [];
  for (let j = 0; j <= nBal; j++) {
    balance.push(Math.exp(logMin + (j / nBal) * (logMax - logMin)));
  }
  const spread: number[] = [];
  for (let i = 0; i <= nSpread; i++) {
    spread.push(spreadMin + (i / nSpread) * (spreadMax - spreadMin));
  }
  const baseAt = (s: number): number =>
    params.maxRateGrowth +
    (params.maxRateDecay - params.maxRateGrowth) /
      (1 + Math.exp(-params.logisticK * (s - params.logisticMidpoint)));

  const z = spread.map((s) => balance.map((b) => balanceSensitivity(b, params.sens) * baseAt(s)));
  return { balance, spread, z };
}

/**
 * Rate-driven decay incentive at a single spread: the one-sided logistic
 *   base_incentive(spread) = maxGrowth + (maxDecay − maxGrowth) / (1 + exp(−K·(spread − midpoint))).
 * This is the spread factor of the (balance, spread) surface; multiplying by
 * g(b) gives the surface z. Exposed so a chosen account's marker and ridge can
 * be placed exactly on the `surface3DData` mesh without re-deriving the logistic.
 */
export function nmdIncentiveAt(params: NMDParams, spread: number): number {
  return (
    params.maxRateGrowth +
    (params.maxRateDecay - params.maxRateGrowth) /
      (1 + Math.exp(-params.logisticK * (spread - params.logisticMidpoint)))
  );
}

/**
 * A single-balance ridge across the spread axis of the rate-sensitivity surface:
 *   z(spread) = g(balance) · nmdIncentiveAt(spread).
 * The spread grid defaults to `surface3DData`'s (−4..4, 41 points) so the ridge
 * lands exactly on the mesh — this is how the highlighted account is drawn on
 * the 3D surface.
 */
export function nmdSurfaceRidge(
  params: NMDParams,
  balance: number,
  opts: { spreadMin?: number; spreadMax?: number; nSpread?: number } = {},
): { spread: number[]; z: number[] } {
  const spreadMin = opts.spreadMin ?? -4;
  const spreadMax = opts.spreadMax ?? 4;
  const nSpread = opts.nSpread ?? 40;
  const g = balanceSensitivity(balance, params.sens);
  const spread: number[] = [];
  const z: number[] = [];
  for (let i = 0; i <= nSpread; i++) {
    const s = spreadMin + (i / nSpread) * (spreadMax - spreadMin);
    spread.push(s);
    z.push(g * nmdIncentiveAt(params, s));
  }
  return { spread, z };
}

/**
 * Closure age-ramp diagnostic: closure(t) decays from `closureInitial` toward
 * `closureSteady` with time constant τ. Returns 0..120 months at monthly
 * resolution.
 */
export function nmdClosureRampData(
  params: NMDParams,
): Array<{ month: number; closure: number; steady: number }> {
  const tau = Math.max(params.closureTauMonths, 1e-6);
  const out: Array<{ month: number; closure: number; steady: number }> = [];
  for (let m = 0; m <= 120; m++) {
    const closure =
      params.closureSteady + (params.closureInitial - params.closureSteady) * Math.exp(-m / tau);
    out.push({ month: m, closure, steady: params.closureSteady });
  }
  return out;
}
