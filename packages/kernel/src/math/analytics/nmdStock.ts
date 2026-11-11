/**
 * NMD seasoned-stock construction (vintage superposition).
 *
 * The instrument model (NMDeposit / NMDBeta) is a single age-0 cohort: a fresh
 * block of money laid down today and run off. A bank's *standing book* is not
 * one cohort — it is the renewal-theory superposition of many vintages of
 * differing age, each at a different point on the same survival kernel. This
 * module builds that seasoned stock from the cohort kernel:
 *
 *   1. `cohortForwardSurvival` runs ONE size bucket forward from a given start
 *      age. The only thing the start age changes is the closure age-ramp index
 *      closure(startAge + m); the rate-driven incentive is a CALENDAR series
 *      shared across vintages (all vintages face the same future rates), built
 *      once by `buildNonIbIncentiveSeries` / `buildIbIncentiveSeries`.
 *   2. `simulateStock` superposes vintages over a (size bucket × age bucket)
 *      grid, weighting each by sizeShare · ageShare, and reports the stock
 *      balance trajectory and its WAL.
 *   3. The default age distribution is the steady-state renewal density
 *      w(a) ∝ S(a) (`steadyStateAgeWeights` / `defaultAgeBuckets`), so the book
 *      is always internally consistent with the kernel; the UI lets the user
 *      override the age shares.
 *
 * Because closure declines with age (closureInitial → closureSteady), the
 * survivor-weighted stock is stickier than a fresh cohort, so the stock WAL
 * exceeds the cohort WAL. The stock WAL is the behavioral anchor the replicating
 * portfolio and FTP consume; the liquidity WAL cap stays a separate overlay.
 *
 * IB note: there is no per-vintage historical client deposit rate, so every IB
 * vintage shares the single modeled deposit-rate path D(t) = β(r(t))·r(t) from
 * the beta model. Vintages then differ only by the closure
 * age-ramp.
 */

import {
  balanceSensitivity,
  buildWarmupSOFR1M,
  nmdIncentiveAt,
  regimeAmplifier,
  type BalanceBucket,
  type BalanceSensitivityParams,
  type NMDParams,
} from "../behavioral/nmdModel";
import type { RatePath } from "../instruments/types";
import { betaAtRate, type BetaSCurveParams } from "../instruments/nmdBeta";

const MONTHS_PER_YEAR = 12;

/** One age (vintage) bucket: a share of the book at a representative age. */
export interface AgeBucket {
  /** Representative vintage age at the as-of date, in months. */
  ageMonths: number;
  /** Share of total book balance, in [0, 1]; shares sum to 1. */
  share: number;
}

/** Inputs for a single-size-bucket forward survival run from a start age. */
export interface CohortForwardInput {
  /** Vintage age (months) at the as-of date; 0 = a fresh cohort. */
  startAgeMonths: number;
  closureSteady: number;
  closureInitial: number;
  closureTauMonths: number;
  burnoutLambda: number;
  /** Balance-sensitivity multiplier g(b̄) for this size bucket. */
  g: number;
  /** Incentive-logistic value per forward step (pre g/multiplier/burnout), %/mo. */
  baseIncentive: ArrayLike<number>;
  /** Multiplicative rate-incentive factor per forward step: the regime amplifier
   *  1 + α·max(0, r − MA) for Non-IB, the cash-sorting r/ref for IB. */
  rateMultiplier: ArrayLike<number>;
  /** Lived burnout accumulation seeded from history (default 0; moot when
   *  burnoutLambda = 0, the current parameter set). */
  cumIncentiveStart?: number;
}

/**
 * Forward survival of one size bucket from `startAgeMonths`. surv[m-1] is the
 * fraction of the vintage remaining after forward month m (survival before
 * month 1 is 1). Mirrors the per-bucket decay step of NMDeposit.simulateBook
 * with the closure ramp offset by the vintage's age.
 */
export function cohortForwardSurvival(inp: CohortForwardInput): Float64Array {
  const n = inp.baseIncentive.length;
  const surv = new Float64Array(n);
  const tau = Math.max(inp.closureTauMonths, 1e-6);
  let s = 1;
  let cumIncentive = inp.cumIncentiveStart ?? 0;
  for (let m = 1; m <= n; m++) {
    const age = inp.startAgeMonths + m - 1;
    const closureT =
      inp.closureSteady + (inp.closureInitial - inp.closureSteady) * Math.exp(-age / tau);
    const closureFactor = 1 - closureT / 100;
    const base = inp.baseIncentive[m - 1];
    const burnoutB = Math.exp(-inp.burnoutLambda * cumIncentive);
    const rateIncentiveDecay = Math.max(0, base * burnoutB * inp.rateMultiplier[m - 1] * inp.g);
    const decayDecimal = 1 - closureFactor * (1 - rateIncentiveDecay / 100);
    s *= 1 - decayDecimal;
    if (s < 0) s = 0;
    surv[m - 1] = s;
    if (base > 0) cumIncentive += base;
  }
  return surv;
}

/**
 * Non-IB calendar incentive series: the opportunity-cost logistic on the spot
 * LEVEL r_1M, paired with the regime amplifier 1 + α·max(0, r − MA_P(r_1M)).
 * Matches NMDeposit.simulateBook exactly so the age-0 survival reconciles with
 * the instrument. Requires history.length ≥ params.maPeriod.
 */
export function buildNonIbIncentiveSeries(
  path: RatePath,
  history: ReadonlyArray<number>,
  params: NMDParams,
  nSteps: number,
): { baseIncentive: Float64Array; rateMultiplier: Float64Array } {
  const histLen = history.length;
  const full = new Array<number>(histLen + nSteps);
  for (let i = 0; i < histLen; i++) full[i] = history[i];
  for (let t = 0; t < nSteps; t++) full[histLen + t] = path.rateAt(t) * 100;
  const offset = histLen;

  const baseIncentive = new Float64Array(nSteps);
  const rateMultiplier = new Float64Array(nSteps);
  for (let m = 1; m <= nSteps; m++) {
    const idx = offset + m - 1;
    const cur = full[idx];
    let maSum = 0;
    for (let j = 1; j <= params.maPeriod; j++) maSum += full[idx - j];
    const ma = maSum / params.maPeriod;
    baseIncentive[m - 1] = nmdIncentiveAt(params, cur);
    rateMultiplier[m - 1] = regimeAmplifier(cur, ma, params.regimeAlpha);
  }
  return { baseIncentive, rateMultiplier };
}

/**
 * IB calendar incentive series: spread = r − D, where D(t) = β(r(t))·r(t) with
 * Nerlove partial adjustment (single modeled deposit-rate path shared by all
 * vintages). Matches runNMDBetaOnPaths. Returns the deposit-rate path too so
 * the FTP/margin layer can reuse it.
 */
export function buildIbIncentiveSeries(
  path: RatePath,
  sCurve: BetaSCurveParams,
  params: NMDParams,
  nSteps: number,
  historical?: ReadonlyArray<number>,
): { baseIncentive: Float64Array; rateMultiplier: Float64Array; depositRatePct: Float64Array } {
  const warmup = historical ?? buildWarmupSOFR1M();
  const warmupLen = warmup.length;
  const full = new Array<number>(warmupLen + nSteps);
  for (let i = 0; i < warmupLen; i++) full[i] = warmup[i];
  for (let t = 0; t < nSteps; t++) full[warmupLen + t] = path.rateAt(t) * 100;

  const baseIncentive = new Float64Array(nSteps);
  const rateMultiplier = new Float64Array(nSteps);
  const depositRatePct = new Float64Array(nSteps);
  let dPrev = 0;
  for (let m = 1; m <= nSteps; m++) {
    const idx = warmupLen + m - 1;
    const cur = full[idx];
    let maSum = 0;
    for (let j = 1; j <= params.maPeriod; j++) maSum += full[idx - j];
    const ma = maSum / params.maPeriod;
    const beta = betaAtRate(cur, sCurve);
    const target = beta * cur;
    const d = m === 1 ? target : Math.max(0, dPrev + sCurve.lambda * (target - dPrev));
    const spread = cur - d;
    const expTerm = Math.exp(-params.logisticK * (spread - params.logisticMidpoint));
    baseIncentive[m - 1] =
      params.maxRateGrowth + (params.maxRateDecay - params.maxRateGrowth) / (1 + expTerm);
    // Phase 3: regime amplifier — same functional form as Non-IB (1 + α·max(0, r − MA)),
    // parallel-invariant. α = 0 by default (NMD_B_TERMS_DEFAULTS) so rateMultiplier ≡ 1
    // and the stock WAL/duration results are identical to Phase 2.
    rateMultiplier[m - 1] = regimeAmplifier(cur, ma, params.regimeAlpha);
    depositRatePct[m - 1] = d;
    dPrev = d;
  }
  return { baseIncentive, rateMultiplier, depositRatePct };
}

/** Normalised non-negative shares (defends against shares that do not sum to 1). */
function normalizeShares(shares: ReadonlyArray<number>): number[] {
  const total = shares.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return shares.map(() => 1 / shares.length);
  return shares.map((v) => Math.max(0, v) / total);
}

/** Survival at integer age j (months): A[0] = 1, A[j] = survival[j-1]. */
function survivalAtAge(survival: ArrayLike<number>, j: number): number {
  if (j <= 0) return 1;
  const idx = Math.min(Math.round(j), survival.length) - 1;
  return survival[idx] ?? survival[survival.length - 1] ?? 0;
}

/**
 * Steady-state renewal weights at the given age nodes: w(a) ∝ S(a), normalised
 * to sum 1. The standing book's age density under constant origination is
 * proportional to survival, so old (sticky) vintages carry more weight.
 */
export function steadyStateAgeWeights(
  survival: ArrayLike<number>,
  ageNodesMonths: ReadonlyArray<number>,
): number[] {
  const raw = ageNodesMonths.map((a) => survivalAtAge(survival, a));
  return normalizeShares(raw);
}

/**
 * Default age buckets: ~nNodes representative vintages spanning [0, maxAge],
 * where maxAge is where survival first falls below a small floor. Shares are the
 * survival-weighted mass over each node's neighbourhood (trapezoidal width), so
 * the discrete book approximates the continuous steady-state density.
 */
export function defaultAgeBuckets(survival: ArrayLike<number>, nNodes: number): AgeBucket[] {
  const N = survival.length;
  let maxAge = N;
  for (let j = 0; j < N; j++) {
    if (survival[j] < 0.02) {
      maxAge = j + 1;
      break;
    }
  }
  maxAge = Math.max(maxAge, nNodes);

  const ages: number[] = [];
  for (let i = 0; i < nNodes; i++) {
    ages.push(Math.round((i * maxAge) / (nNodes - 1)));
  }
  const shares = ages.map((a, i) => {
    const lo = i === 0 ? a : (ages[i - 1] + a) / 2;
    const hi = i === ages.length - 1 ? a : (a + ages[i + 1]) / 2;
    const width = Math.max(1, hi - lo);
    return survivalAtAge(survival, a) * width;
  });
  const norm = normalizeShares(shares);
  return ages.map((a, i) => ({ ageMonths: a, share: norm[i] }));
}

/**
 * Analytic steady-state stock runoff R(t) = Σ_{j≥t} S(j) / Σ_{j≥0} S(j), the
 * fraction of the standing book remaining at forward time t if originations
 * stopped. Equal to the vintage superposition on a flat path; a cheap diagnostic
 * baseline. R[t-1] is the remaining fraction at forward month t.
 */
export function stockRunoffFromSurvival(survival: ArrayLike<number>): Float64Array {
  const N = survival.length;
  let total = 0;
  for (let j = 0; j <= N; j++) total += survivalAtAge(survival, j);
  const R = new Float64Array(N);
  let suffix = 0;
  for (let t = N; t >= 1; t--) {
    suffix += survivalAtAge(survival, t);
    R[t - 1] = total > 0 ? suffix / total : 0;
  }
  return R;
}

/** Runoff-weighted WAL (years) of a normalised balance trajectory (start = 1),
 *  with a horizon-tail piece for balance surviving past the last step. */
export function walFromBalance(balance: ArrayLike<number>, dtYears = 1 / MONTHS_PER_YEAR): number {
  const N = balance.length;
  if (N === 0) return 0;
  let prev = 1;
  let walNum = 0;
  for (let m = 1; m <= N; m++) {
    const b = balance[m - 1];
    const runoff = prev - b;
    if (runoff > 0) walNum += runoff * (m * dtYears);
    prev = b;
  }
  const residual = balance[N - 1];
  walNum += residual * (N * dtYears);
  return walNum;
}

export interface SimulateStockInput {
  nSteps: number;
  sizeBuckets: ReadonlyArray<BalanceBucket>;
  ageBuckets: ReadonlyArray<AgeBucket>;
  sens: BalanceSensitivityParams;
  closureSteady: number;
  closureInitial: number;
  closureTauMonths: number;
  burnoutLambda: number;
  baseIncentive: ArrayLike<number>;
  rateMultiplier: ArrayLike<number>;
}

export interface StockResult {
  /** Stock balance (normalised, start = 1) after each forward month. */
  balance: Float64Array;
  /** Seasoned-stock WAL in years. */
  wal: number;
}

/**
 * Seasoned-stock balance by superposing (size bucket × age bucket) vintages,
 * each running the cohort kernel forward from its vintage age on the shared
 * calendar incentive series. Initial stock normalises to 1.
 */
export function simulateStock(inp: SimulateStockInput): StockResult {
  const { nSteps, sizeBuckets, ageBuckets, sens } = inp;
  const sizeShares = normalizeShares(sizeBuckets.map((b) => b.share));
  const ageShares = normalizeShares(ageBuckets.map((b) => b.share));
  const balance = new Float64Array(nSteps);

  for (let si = 0; si < sizeBuckets.length; si++) {
    const g = balanceSensitivity(sizeBuckets[si].repBalance, sens);
    for (let ai = 0; ai < ageBuckets.length; ai++) {
      const w = sizeShares[si] * ageShares[ai];
      if (w <= 0) continue;
      const surv = cohortForwardSurvival({
        startAgeMonths: ageBuckets[ai].ageMonths,
        closureSteady: inp.closureSteady,
        closureInitial: inp.closureInitial,
        closureTauMonths: inp.closureTauMonths,
        burnoutLambda: inp.burnoutLambda,
        g,
        baseIncentive: inp.baseIncentive,
        rateMultiplier: inp.rateMultiplier,
      });
      for (let m = 0; m < nSteps; m++) balance[m] += w * surv[m];
    }
  }
  return { balance, wal: walFromBalance(balance) };
}

export interface SeasonedStockInput {
  nSteps: number;
  /** Closure / logistic / sens / size-bucket parameter set for the book. */
  params: NMDParams;
  /** Calendar incentive series (shared by all vintages), %/mo pre g/multiplier. */
  baseIncentive: ArrayLike<number>;
  /** Multiplicative rate-incentive factor per forward step (regime amplifier for
   *  Non-IB, cash-sorting for IB), shared by all vintages. */
  rateMultiplier: ArrayLike<number>;
  /** Age-node count for the steady-state grid when no `ageBuckets` given (default 6). */
  nAgeNodes?: number;
  /** Explicit age distribution; when omitted, the steady-state w(a) ∝ S(a) grid. */
  ageBuckets?: ReadonlyArray<AgeBucket>;
  /** Representative balance for the age-density reference survival (default 500k). */
  ageRefBalance?: number;
}

export interface SeasonedStockSummary {
  /** Seasoned (survival-weighted vintage) stock balance + WAL (years). */
  stock: StockResult;
  /** Age-0 fresh-cohort stock balance + WAL (years), same size buckets. */
  cohort: StockResult;
  /** Age grid actually used (the steady-state default or the supplied override). */
  ageBuckets: AgeBucket[];
  /** stock.wal × 12. */
  stockWalMonths: number;
  /** cohort.wal × 12. */
  cohortWalMonths: number;
}

/**
 * One-call seasoned-stock summary: build the steady-state vintage grid (unless
 * overridden), superpose it into the seasoned stock, and pair it with the
 * age-0 fresh cohort on the same size buckets. The stock WAL is the behavioral
 * anchor the replicating portfolio consumes; the cohort WAL is the marginal
 * (new-money) life. Composes the already-tested primitives so the UI, the WAL
 * solver, and the tests share one assembly path.
 */
export function seasonedStockSummary(inp: SeasonedStockInput): SeasonedStockSummary {
  const { nSteps, params, baseIncentive, rateMultiplier } = inp;
  const kernel = {
    closureSteady: params.closureSteady,
    closureInitial: params.closureInitial,
    closureTauMonths: params.closureTauMonths,
    burnoutLambda: params.burnoutLambda,
    baseIncentive,
    rateMultiplier,
  };
  const sim = (ageBuckets: ReadonlyArray<AgeBucket>): StockResult =>
    simulateStock({ nSteps, sizeBuckets: params.buckets, ageBuckets, sens: params.sens, ...kernel });

  const ageBuckets =
    inp.ageBuckets ??
    defaultAgeBuckets(
      cohortForwardSurvival({
        startAgeMonths: 0,
        g: balanceSensitivity(inp.ageRefBalance ?? 500_000, params.sens),
        ...kernel,
      }),
      inp.nAgeNodes ?? 6,
    );

  const stock = sim(ageBuckets);
  const cohort = sim([{ ageMonths: 0, share: 1 }]);
  return {
    stock,
    cohort,
    ageBuckets: [...ageBuckets],
    stockWalMonths: stock.wal * 12,
    cohortWalMonths: cohort.wal * 12,
  };
}

/**
 * Solve for the `maxRateDecay` that lands the seasoned-stock WAL on a target
 * (years). The stock WAL is monotonically decreasing in maxRateDecay, so a
 * bisection on [lo, hi] converges. `walFor` maps a candidate maxRateDecay to
 * the resulting stock WAL.
 */
export function solveMaxRateDecayForStockWal(
  targetYears: number,
  walFor: (maxRateDecay: number) => number,
  opts: { lo: number; hi: number; tol?: number; maxIter?: number },
): number {
  let lo = opts.lo;
  let hi = opts.hi;
  const tol = opts.tol ?? 0.02;
  const maxIter = opts.maxIter ?? 60;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const wal = walFor(mid);
    if (Math.abs(wal - targetYears) < tol) return mid;
    // WAL decreases as maxRateDecay rises: too-long WAL → need more decay.
    if (wal > targetYears) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
