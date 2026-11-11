/**
 * BGM/LMM Monte Carlo with Glasserman-Zhao log-coordinate state, optional
 * displaced-diffusion (shifted), and optional CEV exponent.
 *
 * State variable: ŷ_k = F_k + δ, evolved in log space. (β_cev, δ) = (1, 0)
 * recovers the pure lognormal LMM; β_cev=1 with δ>0 = shifted lognormal
 * (DD); β_cev<1 with any δ = shifted-CEV LMM.
 *
 * Under CEV the local lognormal vol on F̂ is F̂^(β_cev−1) · σ — i.e., the
 * lognormal LMM's σ_LN at F̂_0 stays the same, but as F̂ rises the
 * effective local F-vol decays as F̂^(β_cev−1) → 0. This dampens the upper
 * tail at long horizon and is what most fixed-income desks actually run.
 *
 * State equation (shifted-CEV LMM, spot-LIBOR measure):
 *   d ŷ_k = ŷ_k^β · σ_k · dW̃ + drift_k dt
 *   drift_k = ŷ_k^β · Σ_{j=m+1..k} G_j^CEV (σ_j · σ_k)
 *   G_j^CEV = dt · ŷ_j^β / (1 + dt · F_j)
 *
 * In log coordinates (Itô, with σ_loc = ŷ^(β−1) σ):
 *   d log ŷ_k = (μ_k_log − 0.5 σ_loc² ) dt + σ_loc · dW̃
 *   μ_k_log = ŷ_k^(β−1) · Σ_j G_j^CEV (σ_j · σ_k)
 *
 * β=1 collapses σ_loc ≡ σ and μ_k_log ≡ Σ G_j σ_j σ_k. The implementation
 * preserves bit-for-bit equivalence at β=1 by short-circuiting the
 * F̂^(β−1) prefactor and the F̂^β power inside G^CEV.
 *
 * The per-step numéraire ratio uses the *unshifted* simply-compounded
 * accrual 1/(1 + dt·F_m); same for the tenor projection that builds yields
 * from the alive-row of forwards. CEV and DD only enter the dynamics.
 *
 * References:
 *   - Glasserman, P. & Zhao, X. (2000). Arbitrage-free discretization of
 *     lognormal forward LIBOR and swap rate models.
 *   - Andersen, L. & Andreasen, J. (2002). Volatile volatilities (CEV LMM).
 *   - Joshi, M.S. & Rebonato, R. (2003). A displaced-diffusion stochastic
 *     volatility LIBOR market model.
 */

import type { ZeroCurve } from "./bootstrap";
import type { CurveConvention } from "./marketData";
import { BGM_CEV_BETA_OF_RECORD, BGM_DISPLACEMENT_OF_RECORD } from "./bgmPricing";
import { PCG32 } from "./random";
import type { PathDFResult } from "./simulateHw";

// Defensive numerical guards — only fire on truly degenerate paths.
// Set wide enough that the calibrated lognormal LMM doesn't saturate in
// its extreme upper tail; we want the model to evolve freely and rely on
// log-domain arithmetic for stability. F = e^100 ≈ 2.7e43 is far beyond
// any plausible computation.
const LOG_F_FLOOR = -100;
const LOG_F_CEILING = 100;

// Backward-compatible names retained for callers that still pass them as
// options or read them off the result. The DEFAULT is the sentinel value
// (effectively disabled) since the GZ scheme doesn't need a finite cap, but
// a caller-supplied `fCeiling` is now honoured: it becomes the log-state
// ceiling, and any path that touches it is counted in `nCapFires` and
// reported as a censored evolution (M4 fix, 2026-09-01). The retired build
// accepted the option and silently ignored it, so the Settings drawer's
// forward-ceiling control had no effect on the simulation.
export const F_FLOOR = Math.exp(LOG_F_FLOOR);
export const F_CEILING_DEFAULT = Math.exp(LOG_F_CEILING);

export interface BGMSimulationResult {
  seed: bigint;
  a: number;
  b: number;
  c: number;
  d: number;
  beta: number;
  volScalar: number;
  displacement: number;
  cevBeta: number;
  nPaths: number;
  horizonYears: number;
  dtYears: number;
  nGrid: number;
  times: Float64Array;
  tenors: Float64Array;
  rates: Float64Array;
  dfMarket: Float64Array;
  dfSimulated: Float64Array;
  rawErrorBps: Float64Array;
  corrected: boolean;
  /** Number of evolutions where logF excursions hit the safety guard. Should be 0 in normal operation. */
  nCapFires: number;
  nFloorFires: number;
  nTotalEvolutions: number;
  fCeiling: number;
}

export interface BGMSimulationOptions {
  horizonYears?: number;
  dtYears?: number;
  nPairs?: number;
  seed?: bigint | number;
  savedTenors?: ReadonlyArray<number>;
  applyCorrection?: boolean;
  /**
   * Optional finite ceiling on the forward level F̂ = F + δ. Honoured since
   * 2026-09-01 (M4): the log state is clamped at log(fCeiling) and every
   * clamped evolution is counted in `nCapFires`. Omit for the effectively
   * unbounded default (e^100).
   */
  fCeiling?: number;
}

const DEFAULT_SAVED_TENORS = [
  1 / 360, // 1D SOFR — overnight rate (simple-compounded forward, ≈ short rate)
  1 / 12,
  3 / 12,
  6 / 12,
  1.0,
  2.0,
  5.0,
  7.0,
  10.0,
  20.0,
  30.0,
];

/**
 * Shifted-CEV drift weight G_j^CEV = dt · F̂_j^β / (1 + dt · F_j) for the
 * shifted-CEV LMM drift. β=1 reduces to the DD form; β=1, δ=0 reduces to
 * the standard LMM form.
 *
 *   logFhat >> -log(dt):  numerator dominates; for β=1 G→1, for β<1 the
 *                         result decays as F̂^(β−1)
 *   logFhat moderate:      direct arithmetic
 *   logFhat very small:    F → −δ, 1+dt·F → 1−dt·δ, G ≈ dt·F̂^β / (1−dt·δ)
 */
function computeG(logFhat: number, delta: number, dt: number, cevBeta: number): number {
  if (logFhat > 30) {
    // 1 + dt·F ≈ dt·F. For β=1: G ≈ F̂/F = 1 + δ/F. For β<1: G ≈ F̂^β/F.
    const F = Math.exp(logFhat) - delta;
    if (cevBeta === 1.0) {
      return Math.exp(logFhat) / F;
    }
    return Math.exp(cevBeta * logFhat) / F;
  }
  const Fhat = Math.exp(logFhat);
  const F = Fhat - delta;
  const FhatPow = cevBeta === 1.0 ? Fhat : Math.pow(Fhat, cevBeta);
  return (dt * FhatPow) / (1.0 + dt * F);
}

/**
 * Local-vol prefactor F̂^(β−1) for shifted-CEV. β=1 returns 1 (short-circuit
 * preserves bit-for-bit DD behavior). For β<1 we floor logFhat at a moderate
 * value so the prefactor doesn't explode if a path's F̂ momentarily underflows
 * — the calibrated DD shift δ keeps F̂ ≥ ~δ in practice, but this guard makes
 * the simulator robust to extreme tails.
 */
const LOG_FHAT_FLOOR_FOR_VOL = -10; // F̂ ≈ 4.5e-5
function localVolPrefactor(logFhat: number, cevBeta: number): number {
  if (cevBeta === 1.0) return 1.0;
  const lf = Math.max(logFhat, LOG_FHAT_FLOOR_FOR_VOL);
  return Math.exp((cevBeta - 1.0) * lf);
}

/**
 * Numerically stable log(1 + dt·F) from log(F+δ).
 * For the per-step numéraire DF and the tenor projection we need *unshifted*
 * F, so this returns log(1 + dt·F) (not log(1 + dt·(F+δ))).
 */
function logOnePlusDtF(logFhat: number, delta: number, dt: number): number {
  if (logFhat > 30) {
    // 1 + dt·F ≈ dt·F = dt·(exp(logFhat) − δ) ≈ dt·exp(logFhat)
    // log(...) ≈ logFhat + log(dt) + log(1 − δ·exp(−logFhat))
    return logFhat + Math.log(dt) + Math.log1p(-delta * Math.exp(-logFhat));
  }
  const F = Math.exp(logFhat) - delta;
  return Math.log1p(dt * F);
}

export function getRate(
  res: BGMSimulationResult,
  path: number,
  step: number,
  tenorIdx: number,
): number {
  const nSteps = res.times.length;
  const nTenors = res.tenors.length;
  return res.rates[(path * nSteps + step) * nTenors + tenorIdx];
}

export function simulateBGM(
  curve: ZeroCurve,
  params: { a: number; b: number; c: number; d: number; beta: number; volScalar: number; displacement?: number; cevBeta?: number },
  options: BGMSimulationOptions = {},
): BGMSimulationResult {
  const { a, b, c, d, beta, volScalar } = params;
  const displacement = params.displacement ?? BGM_DISPLACEMENT_OF_RECORD;
  const cevBeta = params.cevBeta ?? BGM_CEV_BETA_OF_RECORD;
  const horizonYears = options.horizonYears ?? 30.0;
  const dtYears = options.dtYears ?? 1 / 12;
  const nPairs = options.nPairs ?? 250;
  const seed = options.seed ?? 20250930n;
  const applyCorrection = options.applyCorrection ?? true;
  const savedTenors = options.savedTenors ?? DEFAULT_SAVED_TENORS;

  // M4 (2026-09-01): the caller's forward ceiling is honoured. Clamped
  // evolutions are censored paths and are counted in nCapFires.
  const fCeiling = options.fCeiling ?? F_CEILING_DEFAULT;
  const logFCeiling = Math.min(Math.log(fCeiling), LOG_F_CEILING);
  const clampLogF = (lf: number): number =>
    lf > logFCeiling ? logFCeiling : lf < LOG_F_FLOOR ? LOG_F_FLOOR : lf;

  const rng = new PCG32(typeof seed === "bigint" ? seed : BigInt(seed));
  const nSteps = Math.round(horizonYears / dtYears);
  // H2 (2026-09-01): the forward grid carries one extra tenor so that after
  // the step-m evolution there is still a full alive row to project. The
  // retired build set nGrid = nSteps and projected the PRE-evolution state
  // into the row labelled t_{m+1}, so the t=1M row held the t=0 curve and had
  // exactly zero cross-path variance. Every stored row now reflects one more
  // evolution than the row before it, mirroring HW.
  const nGrid = nSteps + 1;
  const nPaths = 2 * nPairs;
  const nTenors = savedTenors.length;

  const times = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) times[k] = (k + 1) * dtYears;
  const tenorsArr = new Float64Array(savedTenors);

  // Vol loadings (v1, v2) by time-to-maturity bucket.
  const V1 = new Float64Array(nGrid);
  const V2 = new Float64Array(nGrid);
  for (let idx = 0; idx < nGrid; idx++) {
    const tau = idx * dtYears;
    const sigma = volScalar * ((a + b * tau) * Math.exp(-c * tau) + d);
    V1[idx] = sigma * Math.cos(beta * tau);
    V2[idx] = sigma * Math.sin(beta * tau);
  }

  // Initial forward curve in LOG coordinates.
  const F_init = new Float64Array(nGrid);
  for (let k = 0; k < nGrid; k++) {
    const P1 = curve.discountFactor(k * dtYears);
    const P2 = curve.discountFactor((k + 1) * dtYears);
    F_init[k] = (P1 / P2 - 1.0) / dtYears;
  }
  // Log-state holds log(F + δ).
  const logF_init = new Float64Array(nGrid);
  for (let k = 0; k < nGrid; k++) logF_init[k] = Math.log(Math.max(F_init[k] + displacement, 1e-12));

  // Per-path state in log coordinates: logF[path * nGrid + k] = log F_k(t_m).
  const logF = new Float64Array(nPaths * nGrid);
  for (let p = 0; p < nPaths; p++) {
    for (let k = 0; k < nGrid; k++) logF[p * nGrid + k] = logF_init[k];
  }

  // Output tensor: flat [nPaths][nSteps][nTenors] in decimal yield.
  const rates = new Float64Array(nPaths * nSteps * nTenors);

  const dfMarket = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) dfMarket[k] = curve.discountFactor(times[k]);
  const dfSimulated = new Float64Array(nSteps);
  const rawErrorBps = new Float64Array(nSteps);
  const dPath = new Float64Array(nPaths);
  for (let p = 0; p < nPaths; p++) dPath[p] = 1.0;

  const sqrtDt = Math.sqrt(dtYears);
  let nCapFires = 0;
  let nFloorFires = 0;
  let nTotalEvolutions = 0;

  const tmpZ1 = new Float64Array(nPairs);
  const tmpZ2 = new Float64Array(nPairs);

  for (let m = 0; m < nSteps; m++) {
    // Per-step uncorrected discount factor 1 / (1 + dt · F_m). Numerically:
    // 1 / (1 + dt·F_m) = exp(-log(1 + dt·F_m)) = exp(-logOnePlusDtF(logFhat_m, δ, dt))
    let sumDUncorr = 0;
    const dStep = new Float64Array(nPaths);
    for (let p = 0; p < nPaths; p++) {
      const lf = logF[p * nGrid + m];
      dStep[p] = Math.exp(-logOnePlusDtF(lf, displacement, dtYears));
      sumDUncorr += dPath[p] * dStep[p];
    }
    const eDUncorr = sumDUncorr / nPaths;
    rawErrorBps[m] = (eDUncorr - dfMarket[m]) * 1e4;
    const correction = applyCorrection ? dfMarket[m] / eDUncorr : 1.0;
    let sumDCorr = 0;
    for (let p = 0; p < nPaths; p++) {
      dPath[p] = dPath[p] * dStep[p] * correction;
      sumDCorr += dPath[p];
    }
    dfSimulated[m] = sumDCorr / nPaths;

    // Evolve t_m -> t_{m+1}. With nGrid = nSteps + 1 the alive row is never
    // empty, so the last stored row is a real evolution rather than a copy.
    const nAlive = nGrid - (m + 1);

    for (let i = 0; i < nPairs; i++) {
      tmpZ1[i] = rng.nextNormal();
      tmpZ2[i] = rng.nextNormal();
    }

    for (let p = 0; p < nPaths; p++) {
      const pair = p >>> 1;
      const sign = p & 1 ? -1 : 1;
      const Z1 = sign * tmpZ1[pair];
      const Z2 = sign * tmpZ2[pair];

      // Predictor: log-Euler advance with drift evaluated at F(t_m).
      // Under shifted-CEV the σ in log-space is F̂^(β−1) σ; the drift is
      // F̂^(β−1) Σ G^CEV σ_j σ_k. β=1 short-circuits both prefactors to 1
      // for bit-for-bit DD equivalence.
      let s1 = 0;
      let s2 = 0;
      const logF_pred = new Float64Array(nAlive);
      for (let kIdx = 0; kIdx < nAlive; kIdx++) {
        const k = m + 1 + kIdx;
        const v1k = V1[kIdx + 1];
        const v2k = V2[kIdx + 1];
        const volSq = v1k * v1k + v2k * v2k;

        const lfk = logF[p * nGrid + k];
        const Gk = computeG(lfk, displacement, dtYears, cevBeta);
        s1 += Gk * v1k;
        s2 += Gk * v2k;
        const muRaw = s1 * v1k + s2 * v2k; // CEV-weighted drift sum

        const prefactor = localVolPrefactor(lfk, cevBeta);
        const muPred = prefactor * muRaw;
        const sigLocSq = prefactor * prefactor * volSq;

        const diff = sqrtDt * prefactor * (v1k * Z1 + v2k * Z2);
        const dlog = (muPred - 0.5 * sigLocSq) * dtYears + diff;
        logF_pred[kIdx] = clampLogF(lfk + dlog);
      }

      // Corrector: drift averaged across F(t_m) and F̃(t_{m+1}). Same shocks.
      let s1pred = 0;
      let s2pred = 0;
      let s1corr = 0;
      let s2corr = 0;
      for (let kIdx = 0; kIdx < nAlive; kIdx++) {
        const k = m + 1 + kIdx;
        const v1k = V1[kIdx + 1];
        const v2k = V2[kIdx + 1];
        const volSq = v1k * v1k + v2k * v2k;

        const lfk = logF[p * nGrid + k];
        const Gk_pred = computeG(lfk, displacement, dtYears, cevBeta);
        s1pred += Gk_pred * v1k;
        s2pred += Gk_pred * v2k;
        const muRawP = s1pred * v1k + s2pred * v2k;

        const Gk_corr = computeG(logF_pred[kIdx], displacement, dtYears, cevBeta);
        s1corr += Gk_corr * v1k;
        s2corr += Gk_corr * v2k;
        const muRawC = s1corr * v1k + s2corr * v2k;

        // H1 fix (2026-09-01): the DRIFT is averaged across predictor and
        // corrector states; the DIFFUSION keeps the current-state coefficient
        // (log-Euler). The retired build averaged the state-dependent local-vol
        // prefactor and applied that average to the SAME Brownian increment,
        // which is not a valid predictor-corrector: averaging a
        // state-dependent diffusion coefficient against its own driving shock
        // adds a spurious Itô drift of order 0.5·(β_cev − 1)·b²·dt, biasing the
        // CEV fan narrow (~-9% displacement over 30y). Averaging drift only is
        // exact to O(dt) with no such term; a genuine Milstein correction would
        // instead need the (dW² − dt) term, which we deliberately do not take.
        // β_cev = 1 leaves both prefactors at 1, so DD behaviour is unchanged.
        const prefP = localVolPrefactor(lfk, cevBeta);
        const prefC = localVolPrefactor(logF_pred[kIdx], cevBeta);
        const muP = prefP * muRawP;
        const muC = prefC * muRawC;
        const muBar = 0.5 * (muP + muC);
        const sigLocSq = prefP * prefP * volSq;

        const diff = sqrtDt * prefP * (v1k * Z1 + v2k * Z2);
        const dlog = (muBar - 0.5 * sigLocSq) * dtYears + diff;
        const lfFinal = lfk + dlog;
        if (lfFinal > logFCeiling) nCapFires++;
        if (lfFinal < LOG_F_FLOOR) nFloorFires++;
        nTotalEvolutions++;
        logF[p * nGrid + k] = clampLogF(lfFinal);
      }
    }

    // Project the POST-evolution state at t_{m+1} into the row labelled
    // times[m] = (m+1)·dt. Alive row now starts at grid index m+1.
    projectRowToTenors(
      logF, m + 1, nPaths, nGrid, dtYears, displacement, tenorsArr,
      rates, m, nSteps, nTenors, curve.convention,
    );
  }

  return {
    seed: typeof seed === "bigint" ? seed : BigInt(seed),
    a, b, c, d, beta, volScalar, displacement, cevBeta,
    nPaths,
    horizonYears,
    dtYears,
    nGrid,
    times,
    tenors: tenorsArr,
    rates,
    dfMarket,
    dfSimulated,
    rawErrorBps,
    corrected: applyCorrection,
    nCapFires,
    nFloorFires,
    nTotalEvolutions,
    fCeiling,
  };
}

/**
 * Project current alive-row of forwards into saved tenors at simulation time t_m.
 * Operates entirely in log coordinates so any forward magnitude is handled
 * without numerical loss.
 */
const ACT_360_ANNUAL = 365 / 360;

function projectRowToTenors(
  logF: Float64Array,
  m: number,
  nPaths: number,
  nGrid: number,
  dt: number,
  delta: number,
  savedTenors: Float64Array,
  out: Float64Array,
  outStep: number,
  outNSteps: number,
  nTenors: number,
  convention: CurveConvention,
): void {
  const nAlive = nGrid - m;
  const nT = savedTenors.length;
  // Convention switch. QUOTED basis: the saved-tenor series is a reported
  // forecast yield, so it follows the CURVE'S own convention, exactly as the
  // Python sibling does (the Python reference engine). The simulated forwards themselves
  // stay simply-compounded on the dt grid (internal accrual) under both
  // conventions; only the requoting differs. H3 fix, 2026-09-01: the retired
  // build hardcoded the annual ACT/360 branch, so the CMT rebase never reached
  // the projection.
  //   "annual_act360":    τ ≤ 1Y simple-compounded; τ > 1Y annual ACT/360 par swap.
  //   "semiannual_bond":  τ < 0.5Y pure discount quoted bond-equivalent;
  //                       0.5Y ≤ τ < 1Y single semi-annual coupon at maturity;
  //                       τ ≥ 1Y semi-annual par bond on exact half-year dates.
  const semi = convention === "semiannual_bond";
  const stepsPerYear = Math.round(1 / dt); // 12 for dt = 1/12
  if (semi && stepsPerYear % 2 !== 0) {
    throw new Error(
      "semiannual_bond projection needs an even number of steps per year so " +
        `half-year coupon dates land on the grid; got ${stepsPerYear}`,
    );
  }
  const halfStride = stepsPerYear / 2;
  const isSwap = new Array<boolean>(nT);
  const nFull = new Int32Array(nT);
  const residual = new Float64Array(nT);
  const swapYearsN = new Int32Array(nT); // coupon count on the fixed leg
  for (let ti = 0; ti < nT; ti++) {
    const tau = savedTenors[ti];
    const sw = semi ? tau >= 1.0 - 1e-9 : tau > 1.0 + 1e-9;
    if (sw) {
      isSwap[ti] = true;
      swapYearsN[ti] = semi ? Math.round(2 * tau) : Math.round(tau);
      nFull[ti] = 0;
      residual[ti] = 0;
    } else {
      isSwap[ti] = false;
      const nf = Math.floor(tau / dt);
      nFull[ti] = nf;
      residual[ti] = tau - nf * dt;
    }
  }

  for (let p = 0; p < nPaths; p++) {
    // Cumulative log discount: cumLog[j] = Σ_{i=0..j-1} log(1 + dt · F_{m+i}).
    // Uses *unshifted* F (the actual numéraire); the log-state is log(F+δ),
    // so logOnePlusDtF subtracts δ internally.
    const cumLog = new Float64Array(nAlive + 1);
    cumLog[0] = 0;
    for (let j = 0; j < nAlive; j++) {
      const lfk = logF[p * nGrid + m + j];
      cumLog[j + 1] = cumLog[j] + logOnePlusDtF(lfk, delta, dt);
    }
    const lfLast = logF[p * nGrid + nGrid - 1];
    const tailLog = logOnePlusDtF(lfLast, delta, dt); // log(1 + dt·F_last)

    // Log of P(t, t + k*dt). Past grid edge, extrapolate using lfLast.
    const logDiscAt = (j: number): number => {
      if (j <= nAlive) return cumLog[j];
      return cumLog[nAlive] + tailLog * (j - nAlive);
    };

    for (let ti = 0; ti < nT; ti++) {
      if (isSwap[ti]) {
        // Fixed schedule: half-year offsets under semiannual_bond, integer-year
        // offsets under annual_act360.
        const n = swapYearsN[ti];
        const accrual = semi ? 0.5 : ACT_360_ANNUAL;
        const stride = semi ? halfStride : stepsPerYear;
        let annuity = 0;
        let logPlast = 0; // log of P(t, t + tau)
        for (let k = 1; k <= n; k++) {
          const lp = logDiscAt(k * stride);
          const Pk = Math.exp(-lp);
          annuity += accrual * Pk;
          if (k === n) logPlast = lp;
        }
        const Pn = Math.exp(-logPlast);
        out[(p * outNSteps + outStep) * nTenors + ti] = (1.0 - Pn) / annuity;
        continue;
      }

      // Simple-compounded forward branch (sub-1Y).
      const tau = savedTenors[ti];
      const nf = nFull[ti];
      const res = residual[ti];
      let logTotal: number;
      if (nf > nAlive) {
        const baseLog = cumLog[nAlive];
        const extra = tailLog * (nf - nAlive);
        logTotal = baseLog + extra;
        if (res > 1e-9) logTotal += logOnePlusDtF(lfLast, delta, res);
      } else {
        logTotal = cumLog[nf];
        if (res > 1e-9) {
          const lfNext = nf < nAlive ? logF[p * nGrid + m + nf] : lfLast;
          logTotal += logOnePlusDtF(lfNext, delta, res);
        }
      }
      // logTotal = -log P(t, t+tau), so 1/P = exp(logTotal).
      let yld: number;
      if (semi) {
        yld = tau < 0.5 - 1e-9
          ? 2.0 * (Math.exp(logTotal / (2.0 * tau)) - 1.0) // pure discount, BEY
          : 2.0 * Math.expm1(logTotal); // single semi-annual coupon at maturity
      } else {
        yld = Math.expm1(logTotal) / tau;
      }
      out[(p * outNSteps + outStep) * nTenors + ti] = yld;
    }
  }
}

// ---------------------------------------------------------------------------
// Tenor extraction + per-path discount reconstruction (FTP / OAS companions).
// ---------------------------------------------------------------------------

/** Index of `tenorYears` in the sim's saved-tenor grid; throws if absent. */
export function bgmTenorIndex(sim: BGMSimulationResult, tenorYears: number): number {
  for (let i = 0; i < sim.tenors.length; i++) {
    if (Math.abs(sim.tenors[i] - tenorYears) < 1e-9) return i;
  }
  throw new Error(
    `bgmTenorIndex: tenor ${tenorYears}y not in saved grid [${Array.from(sim.tenors).join(", ")}]`,
  );
}

/**
 * Unpack one saved tenor from the flat rates tensor into per-path rows,
 * shape [nPaths][nSteps] — the same layout `projectHWToTenor` produces, so
 * downstream consumers (tractor pillar samples, mortgage benchmark paths)
 * can take either engine's projection through one code path.
 */
export function extractBgmTenorPaths(
  sim: BGMSimulationResult,
  tenorYears: number,
): Float64Array[] {
  const ti = bgmTenorIndex(sim, tenorYears);
  const nSteps = sim.times.length;
  const nT = sim.tenors.length;
  const out: Float64Array[] = new Array(sim.nPaths);
  for (let p = 0; p < sim.nPaths; p++) {
    const row = new Float64Array(nSteps);
    for (let k = 0; k < nSteps; k++) row[k] = sim.rates[(p * nSteps + k) * nT + ti];
    out[p] = row;
  }
  return out;
}

/**
 * Reconstruct per-path money-market discount factors from the BGM 1D
 * (overnight) rate row, with a terminal multiplicative correction so the
 * cross-path mean DF equals the market DF at every horizon
 * (E_p[D_p(t_k)] = P^M(0, t_k)) — the BGM companion of `reconstructPathDF`
 * (rates/simulateHw), same trapezoidal money-market accrual seeded at the
 * instantaneous t=0 forward. Used by stochastic FTP / OAS discounting under
 * the BGM engine.
 */
export function reconstructPathDFBgm(sim: BGMSimulationResult, curve: ZeroCurve): PathDFResult {
  const oneDay = extractBgmTenorPaths(sim, 1 / 360);
  const P = sim.nPaths;
  const nSteps = sim.times.length;
  const dt = sim.dtYears;
  const f0 = -Math.log(curve.discountFactor(dt)) / dt;

  const U: Float64Array[] = new Array(P);
  for (let p = 0; p < P; p++) {
    const u = new Float64Array(nSteps);
    let cum = 1;
    let rPrev = f0;
    for (let k = 0; k < nSteps; k++) {
      const rk = oneDay[p][k];
      cum *= Math.exp(-0.5 * (rPrev + rk) * dt);
      u[k] = cum;
      rPrev = rk;
    }
    U[p] = u;
  }

  const corr = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) {
    let mean = 0;
    for (let p = 0; p < P; p++) mean += U[p][k];
    mean /= P;
    if (mean < 1e-15) {
      throw new Error(`reconstructPathDFBgm: DF mean collapsed to zero at step ${k}`);
    }
    corr[k] = curve.discountFactor(sim.times[k]) / mean;
  }

  const Dcorr: Float64Array[] = new Array(P);
  for (let p = 0; p < P; p++) {
    const d = new Float64Array(nSteps);
    for (let k = 0; k < nSteps; k++) d[k] = U[p][k] * corr[k];
    Dcorr[p] = d;
  }

  let maxErr = 0;
  for (let k = 0; k < nSteps; k++) {
    let mean = 0;
    for (let p = 0; p < P; p++) mean += Dcorr[p][k];
    mean /= P;
    maxErr = Math.max(maxErr, Math.abs(mean - curve.discountFactor(sim.times[k])) * 1e4);
  }
  return { Dcorr, meanErrBp: maxErr };
}
