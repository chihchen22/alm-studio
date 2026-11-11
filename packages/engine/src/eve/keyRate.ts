/**
 * Key-rate durations of equity (contract: contracts/results.ts, the
 * KeyRateResult block; the catalog's alm-eve component: a key-rate
 * decomposition with an additivity-plus-convergence gate).
 *
 * Construction. Each curve node j gets a "tent" shock in zero-rate space:
 * `bumpBp` at t_j, zero at the adjacent nodes t_{j-1} and t_{j+1}, linearly
 * interpolated between, and FLAT beyond the first / last node (so the first
 * tent covers the whole sub-front and the last tent stands in for the entire
 * flat-extrapolated long end — disclosed on the contract, not resolved here).
 * Because the shocks are applied at the curve's own nodes and the curve
 * interpolates linearly in zero rate, the tents sum pointwise to the constant
 * parallel shift at EVERY tenor — that linear partition is what makes the
 * decomposition additive to first order, with a second-order residual from PV
 * convexity.
 *
 * Quote tenors. The key-rate nodes are the
 * curve's quote tenors (quoteTenorsOf): its own nodes for a kernel bootstrap
 * (curve default version 1), the setup's quotes for a curve built on dense
 * monthly nodes from a curveSetup block or by the platform default (curve
 * default version 2, whose first quote tenor is 1/12). The tents are still
 * applied through customCurve at every dense node; each quote tenor is a
 * whole month and so a dense node, which
 * keeps the tents piecewise linear between dense nodes and their sum equal to
 * the parallel shift at every tenor.
 *
 * Both legs move together per bump (forward-consistent, the alm-eve rule): the
 * node-bumped curve feeds BOTH the projection path (a DeterministicRatePath
 * rebuilt from the bumped curve, exactly how the run builds a scenario path
 * from a shocked curve) and the discount function. The Non-IB NMD warmup
 * history is re-leveled by the bump's value at tenor 0 — the whole-environment
 * rule the parallel duration engine applies, generalized: only the
 * front tent (and the parallel reference) touches the short end, so the
 * re-levels also sum to the parallel re-level.
 *
 * The gate (alm-eve, cross-model #104): the node durations must SUM to a
 * parallel effective duration measured with the SAME machinery at the SAME
 * bump, and the residual must fall roughly four-fold when the bump halves.
 * Closeness alone is not the gate — a construction error that happens to be
 * small at one bump size does not converge. The result carries both residuals,
 * the ratio, and a `converged` verdict; a failed gate is reported false, never
 * patched.
 *
 * Cost: 2·(nodes + 1) full-book regenerations per bump size, at two bump
 * sizes. This is why the capability is an opt-in on the run pipeline context,
 * off by default.
 *
 * Determinism: no clock, no RNG. Positions accumulate in COA declared family
 * order then position array order; nodes in the curve's ascending node order.
 */
import {
  buildWarmupSOFR1M,
  DeterministicRatePath,
  NMDeposit,
  pvCashflows,
  type Cashflow,
  type NMDTerms,
  type RatePath,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import { isCommitmentFamily } from "../commitment/offBalanceSheet";
import { isNonRateFamily } from "../nonRate";
import type { PortfolioSpec, Position } from "../contracts/position";
import type { RateIndexTable } from "../contracts/rateIndex";
import type { RunMacro } from "../macro/runMacro";
import type {
  KeyRateConvergence,
  KeyRateNodeDuration,
  KeyRateResult,
} from "../contracts/results";
import type { CustomTenorShock } from "../contracts/scenario";
import type { ScenarioId } from "../contracts/ids";
import { seasoningOffsetOf } from "../portfolio/seasoning";
import { makeInstrument } from "../runtime/instrumentFactory";
import { NotImplementedError } from "../runtime/notImplemented";
import { customCurve, customShiftBp } from "../scenario/rateEnvironment";
import { quoteTenorsOf } from "../curveBuilder/quoteTenors";
import { isDerivativeFamily } from "../swap/derivatives";
import { discountFunction, spreadDiscountCache, type DiscountBasis } from "./discount";

/** Default working node bump, bp (the alm-eve reference exhibit's 25bp). */
export const DEFAULT_KEY_RATE_BUMP_BP = 25;
/** The convergence re-measure halves the working bump. */
export const KEY_RATE_BUMP_HALVING = 2;
/**
 * Convergence band for |residual(h)| / |residual(h/2)|. A clean second-order
 * central-difference construction gives exactly 4 in the smooth limit
 * (measured 4.00002 on the 5Y-zero hand case, 4.24/4.04 on the amplifier-free
 * Non-IB NMD). The lower edge admits behavioral kink contamination — the
 * mortgage book's ITM/burnout kinks measured order ~1.5-1.8 (ratios 2.77-3.44
 * across 5-50bp bumps) with the residual FALLING and small (0.4-1.9% of the
 * duration) — while still rejecting the construction-error signature (a
 * residual that does not fall: ratio ≈ 1) and the structurally non-additive
 * regime-amplifier case (measured ratios 0.64-2.03 with a NON-vanishing
 * residual), which is refused typed upstream before the gate is ever read.
 */
export const KEY_RATE_CONVERGENCE_RATIO_MIN = 2.5;
export const KEY_RATE_CONVERGENCE_RATIO_MAX = 6.0;
/**
 * Residuals below this magnitude (years of duration) are negligible: the
 * decomposition is additive to noise and a ratio of two such residuals is not
 * a measurement.
 */
export const KEY_RATE_RESIDUAL_FLOOR_YEARS = 1e-9;

/** bp per unit rate (1.0 = 10,000 bp). */
const BP_PER_RATE_UNIT = 1e4;
/** bp per percentage point (the NMD warmup series is in %-pa units). */
const BP_PER_PERCENT = 100;

/** Inputs for the standalone key-rate measurement. */
export interface KeyRateInputs {
  /** The book (COA supplies sides; positions supply terms). */
  portfolio: PortfolioSpec;
  /** The base scenario id stamped into the result. */
  scenarioId: ScenarioId;
  /**
   * Base risk-free zero curve. Its quote tenors (quoteTenorsOf) ARE the
   * key-rate nodes: for a kernel bootstrap those are its own nodes; for a
   * dense curve built from a curveSetup block or by the platform default
   * (curve default version 2) they are the setup's quotes, and
   * the tents are still applied through customCurve on every dense node.
   */
  curve: ZeroCurve;
  tlp: TLPCurve;
  /** Projection path length, months (the run's grid horizon). */
  horizonMonths: number;
  /** Discount basis; "all-in" (default), "risk-free" or "spread-consistent" (per-position spread). */
  discountBasis?: DiscountBasis;
  /** Working node bump, bp. Default DEFAULT_KEY_RATE_BUMP_BP. */
  bumpBp?: number;
  /**
   * The run's rate index table, forwarded to every regenerated leg so
   * an indexed floater is wrapped on each bumped path. Absent when no position
   * names an index; an indexed floater without it throws RateIndexUnresolvedError.
   */
  rateIndices?: RateIndexTable;
  /**
   * The run's resolved macro value, threaded beside rateIndices to every
   * makeInstrument call. A mortgage carrying a housing group without it throws
   * MacroUnresolvedError. Absent outside a run.
   */
  macro?: RunMacro;
}

/**
 * A position paired with its side sign (+1 asset, −1 liability) and whether
 * it is a derivative: a derivative position's rows are already
 * signed by leg, carry sign +1, and discount on the risk-free curve.
 */
interface SidedPosition {
  sign: 1 | -1;
  pos: Position;
  derivative: boolean;
}

/**
 * Flatten the book to side-signed positions in COA declared family order,
 * position array order within a family, the same accumulation order the
 * duration engine uses, so the base-leg EVE here equals its `eve` output.
 */
function collectSidedPositions(portfolio: PortfolioSpec): SidedPosition[] {
  const byFamily = new Map<string, Position[]>();
  for (const f of portfolio.coa.families) byFamily.set(f.id, []);
  for (const pos of portfolio.positions) byFamily.get(pos.familyId)?.push(pos);
  const out: SidedPosition[] = [];
  for (const f of portfolio.coa.families) {
    if (isDerivativeFamily(f)) {
      for (const pos of byFamily.get(f.id) ?? []) out.push({ sign: 1, pos, derivative: true });
      continue;
    }
    if (f.side !== "asset" && f.side !== "liability") continue;
    // Off balance sheet: a commitment family is declared asset-side,
    // so it would otherwise contribute its drawdown stream to the key-rate PV
    // with a +1 sign. An undrawn line has no PV and no key-rate exposure.
    if (isCommitmentFamily(f)) continue;
    // S3a-1 follow-up: a non-rate-sensitive balance is valued at book and has no key-rate exposure.
    if (isNonRateFamily(f)) continue;
    const sign = f.side === "liability" ? -1 : 1;
    for (const pos of byFamily.get(f.id) ?? []) out.push({ sign, pos, derivative: false });
  }
  return out;
}

/**
 * Generate one position's cash flows on a path, mirroring the duration
 * engine's leg generator (effectiveDuration.ts): the Non-IB NMD warmup is
 * shifted by `warmupShiftPct` (%-pa; the bump's value at tenor 0), a seasoned
 * fixed-loan stream is re-anchored to portfolio time (drop elapsed, shift the
 * rest; the D3a lift), everything else regenerates directly on the path.
 */
function generateLeg(
  pos: Position,
  path: RatePath,
  warmupShiftPct: number,
  warmup: number[],
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): Cashflow[] {
  if (pos.terms.type === "nmd") {
    const hist =
      warmupShiftPct === 0 ? warmup : warmup.map((h) => h + warmupShiftPct);
    return new NMDeposit(pos.terms as NMDTerms, hist).generateCashflows(path);
  }
  const off = seasoningOffsetOf(pos.terms);
  const cfs = makeInstrument(pos.terms, { rateIndices, macro }).generateCashflows(path);
  if (off === 0) return cfs;
  const shifted: Cashflow[] = [];
  for (const cf of cfs) {
    const m = cf.monthOffset + off;
    if (m <= 0) continue; // elapsed before as-of
    shifted.push({ ...cf, monthOffset: m });
  }
  return shifted;
}

/** The book's discount function and the risk-free one swap legs use. */
export interface DiscountPair {
  book: (tYears: number) => number;
  riskFree: (tYears: number) => number;
  /**
   * Spread-consistent basis only: the book discount function of one
   * position, at its own discountSpreadBp. Absent on every other basis, where
   * `book` serves every position.
   */
  bookFor?: (pos: Position) => (tYears: number) => number;
}

/** Both discount functions for `curve` at zero shift. */
export function discountPair(curve: ZeroCurve, tlp: TLPCurve, basis: DiscountBasis): DiscountPair {
  return {
    book: discountFunction(curve, tlp, 0, basis),
    riskFree: discountFunction(curve, tlp, 0, "risk-free"),
    ...(basis === "spread-consistent" ? { bookFor: spreadDiscountCache(curve, tlp, 0, basis) } : {}),
  };
}

/**
 * Full-life regenerated EVE (Σ asset PV − Σ liability PV, plus Σ derivative
 * PV on the risk-free curve) with the projection path and the discount pair supplied
 * SEPARATELY, so the channel decomposition (channels.ts) can mix a shocked
 * path with a base discount pair and vice versa. Exported so both analytics
 * share one regeneration convention. The book loop skips derivatives; their
 * PV comes from `derivativeEveOnLegs` and is added once, last, so a book with
 * none sums exactly the terms it summed before piece 8.
 */
export function eveOnLegs(
  sided: SidedPosition[],
  path: RatePath,
  df: DiscountPair,
  warmup: number[],
  warmupShiftPct: number,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): number {
  let eve = 0;
  for (const { sign, pos, derivative } of sided) {
    if (derivative) continue;
    eve += sign * pvCashflows(
      generateLeg(pos, path, warmupShiftPct, warmup, rateIndices, macro),
      df.bookFor !== undefined ? df.bookFor(pos) : df.book,
    );
  }
  const derivatives = derivativeEveOnLegs(sided, path, df, warmup, warmupShiftPct, rateIndices, macro);
  return derivatives === undefined ? eve : eve + derivatives;
}

/**
 * Σ derivative PV on the risk-free curve alone (rows arrive signed by leg), or undefined
 * when the book holds no derivative position: absent, never 0.
 */
export function derivativeEveOnLegs(
  sided: SidedPosition[],
  path: RatePath,
  df: DiscountPair,
  warmup: number[],
  warmupShiftPct: number,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): number | undefined {
  let derivatives = 0;
  let anyDerivative = false;
  for (const { pos, derivative } of sided) {
    if (!derivative) continue;
    anyDerivative = true;
    derivatives += pvCashflows(generateLeg(pos, path, warmupShiftPct, warmup, rateIndices, macro), df.riskFree);
  }
  return anyDerivative ? derivatives : undefined;
}

/**
 * Full-life regenerated EVE on one coherent environment: path and discount
 * pair both derived from `curve` (the forward-consistent case).
 */
export function regeneratedEve(
  sided: SidedPosition[],
  curve: ZeroCurve,
  tlp: TLPCurve,
  basis: DiscountBasis,
  horizonMonths: number,
  warmup: number[],
  warmupShiftPct: number,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): number {
  return eveOnLegs(
    sided,
    new DeterministicRatePath(curve, horizonMonths),
    discountPair(curve, tlp, basis),
    warmup,
    warmupShiftPct,
    rateIndices,
    macro,
  );
}

export type { SidedPosition };
export { collectSidedPositions };

/**
 * Ids of positions whose decay model carries a nonzero one-sided regime
 * amplifier 1 + α·max(0, r − MA(r)). The key-rate decomposition is UNDEFINED
 * for these positions: the parallel effective duration deliberately EXCLUDES
 * the excursion channel (the warmup re-level pins r − MA under a
 * parallel bump), but no constant warmup shift can pin a shaped node bump's
 * excursion, and because the amplifier is one-sided at a kink the base path
 * sits on wherever forwards flatten (r → MA), the per-node responses do not
 * cancel in the sum. Measured on the default Non-IB book: the additivity
 * residual holds at −0.69..−1.18y across 5-50bp bumps (it does NOT vanish
 * with the bump), versus clean 4x convergence the moment regimeAlpha is 0.
 * Refusing is the answer; the cure is a kernel seam that exposes an
 * excursion-pinned decay leg (next re-vendor), not a band wide enough to
 * swallow a non-convergent residual.
 */
export function regimeAmplifiedPositionIds(portfolio: PortfolioSpec): string[] {
  const ids: string[] = [];
  for (const pos of portfolio.positions) {
    if (pos.terms.type !== "nmd" && pos.terms.type !== "nmd-b") continue;
    const alpha = (pos.terms as { nmdParams?: { regimeAlpha?: number } }).nmdParams
      ?.regimeAlpha;
    if (alpha !== undefined && alpha !== 0) ids.push(pos.id);
  }
  return ids;
}

/** Tent knots for node j at the given bump: peak at t_j, zero at neighbors. */
function nodeKnots(t: ReadonlyArray<number>, j: number, bumpBp: number): CustomTenorShock[] {
  const knots: CustomTenorShock[] = [];
  if (j > 0) knots.push({ tenorYears: t[j - 1], shockBp: 0 });
  knots.push({ tenorYears: t[j], shockBp: bumpBp });
  if (j < t.length - 1) knots.push({ tenorYears: t[j + 1], shockBp: 0 });
  return knots;
}

/** The knots' sign-flipped copy (the down leg of the central difference). */
function negateKnots(knots: CustomTenorShock[]): CustomTenorShock[] {
  return knots.map((k) => ({ tenorYears: k.tenorYears, shockBp: -k.shockBp }));
}

/**
 * Central-difference equity duration in the direction defined by `knots`:
 * (EVE_down − EVE_up) / (2 · EVE_0 · Δr), both legs fully regenerated on the
 * knot-shifted curve, with the warmup re-level read off the shift at tenor 0.
 */
function directionalDuration(
  sided: SidedPosition[],
  curve: ZeroCurve,
  tlp: TLPCurve,
  basis: DiscountBasis,
  horizonMonths: number,
  warmup: number[],
  knots: CustomTenorShock[],
  bumpBp: number,
  eveBase: number,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): number {
  const downKnots = negateKnots(knots);
  const shiftAtZeroPct = customShiftBp(0, knots) / BP_PER_PERCENT;
  const eveUp = regeneratedEve(
    sided, customCurve(curve, knots), tlp, basis, horizonMonths, warmup, shiftAtZeroPct,
    rateIndices,
    macro,
  );
  const eveDown = regeneratedEve(
    sided, customCurve(curve, downKnots), tlp, basis, horizonMonths, warmup, -shiftAtZeroPct,
    rateIndices,
    macro,
  );
  const dr = bumpBp / BP_PER_RATE_UNIT;
  return (eveDown - eveUp) / (2 * eveBase * dr);
}

/** One full measurement pass at a bump size: node durations, sum, parallel. `t` holds the knot tenors. */
function measureAtBump(
  sided: SidedPosition[],
  curve: ZeroCurve,
  t: ReadonlyArray<number>,
  tlp: TLPCurve,
  basis: DiscountBasis,
  horizonMonths: number,
  warmup: number[],
  bumpBp: number,
  eveBase: number,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): { nodes: number[]; sum: number; parallel: number } {
  const nodes: number[] = [];
  let sum = 0;
  for (let j = 0; j < t.length; j++) {
    const d = directionalDuration(
      sided, curve, tlp, basis, horizonMonths, warmup,
      nodeKnots(t, j, bumpBp), bumpBp, eveBase, rateIndices, macro,
    );
    nodes.push(d);
    sum += d;
  }
  // Parallel reference with the SAME machinery: one knot, flat bump at every
  // tenor (a single knot extends flat both ways — the "custom generalizes
  // parallel" degeneracy the scenario layer proves).
  const parallel = directionalDuration(
    sided, curve, tlp, basis, horizonMonths, warmup,
    [{ tenorYears: t[0], shockBp: bumpBp }], bumpBp, eveBase, rateIndices, macro,
  );
  return { nodes, sum, parallel };
}

/**
 * Compute the key-rate decomposition of equity effective duration at the base
 * environment, gated by additivity plus convergence. Throws typed where the
 * measurement is undefined rather than emitting a plausible number:
 * fewer than two curve nodes (no non-parallel direction exists) or zero base
 * EVE (duration is undefined at zero equity).
 */
export function computeKeyRateDurations(inputs: KeyRateInputs): KeyRateResult {
  const basis: DiscountBasis = inputs.discountBasis ?? "all-in";
  const bumpBp = inputs.bumpBp ?? DEFAULT_KEY_RATE_BUMP_BP;
  if (!Number.isFinite(bumpBp) || bumpBp <= 0) {
    throw new Error(
      `keyRate: bumpBp must be a finite positive number of basis points, got ${String(bumpBp)}`,
    );
  }
  const { curve, tlp, horizonMonths } = inputs;
  // The knot tenors: the curve's quote tenors (its own nodes when none are registered).
  const knots = quoteTenorsOf(curve);
  if (knots.length < 2) {
    throw new NotImplementedError(
      "eve.key-rate",
      `the curve carries ${knots.length} node(s); a key-rate decomposition needs at ` +
        `least two nodes — on a single-node curve every shock is parallel and the ` +
        `parallel effective duration is the whole answer`,
    );
  }
  const amplified = regimeAmplifiedPositionIds(inputs.portfolio);
  if (amplified.length > 0) {
    const named = amplified.slice(0, 5).join(", ");
    const more = amplified.length > 5 ? ` (and ${amplified.length - 5} more)` : "";
    throw new NotImplementedError(
      "eve.key-rate",
      `the book carries ${amplified.length} position(s) with a nonzero one-sided regime ` +
        `amplifier (${named}${more}); the parallel duration pins the r − MA excursion ` +
        `by re-leveling the warmup, but a shaped node bump's excursion cannot be pinned ` +
        `by any constant history shift, and the one-sided max(0,·) responses do not ` +
        `cancel — the additivity residual does not vanish with the bump (measured ` +
        `−0.69..−1.18y across 5-50bp on the default Non-IB book). Refused ` +
        `rather than emitting a decomposition whose gate cannot pass; the cure is a ` +
        `kernel seam exposing an excursion-pinned decay leg (next re-vendor).`,
    );
  }

  const sided = collectSidedPositions(inputs.portfolio);
  const warmup = buildWarmupSOFR1M();
  const eveBase = regeneratedEve(
    sided, curve, tlp, basis, horizonMonths, warmup, 0, inputs.rateIndices, inputs.macro,
  );
  if (eveBase === 0) {
    throw new NotImplementedError(
      "eve.key-rate",
      "base EVE is 0; a duration per unit of equity value is undefined at zero equity",
    );
  }

  const full = measureAtBump(
    sided, curve, knots, tlp, basis, horizonMonths, warmup, bumpBp, eveBase, inputs.rateIndices, inputs.macro,
  );
  const halvedBumpBp = bumpBp / KEY_RATE_BUMP_HALVING;
  const half = measureAtBump(
    sided, curve, knots, tlp, basis, horizonMonths, warmup, halvedBumpBp, eveBase, inputs.rateIndices, inputs.macro,
  );

  const residualYears = full.sum - full.parallel;
  const residualYearsAtHalvedBump = half.sum - half.parallel;
  const bothNegligible =
    Math.abs(residualYears) < KEY_RATE_RESIDUAL_FLOOR_YEARS &&
    Math.abs(residualYearsAtHalvedBump) < KEY_RATE_RESIDUAL_FLOOR_YEARS;
  let ratio: number | undefined;
  let converged: boolean;
  if (Math.abs(residualYearsAtHalvedBump) < KEY_RATE_RESIDUAL_FLOOR_YEARS) {
    // Ratio against ~0 is noise; converged iff the working residual is also
    // negligible (an exactly-additive book), else the gate fails honestly.
    ratio = undefined;
    converged = bothNegligible;
  } else {
    ratio = Math.abs(residualYears) / Math.abs(residualYearsAtHalvedBump);
    converged =
      ratio >= KEY_RATE_CONVERGENCE_RATIO_MIN && ratio <= KEY_RATE_CONVERGENCE_RATIO_MAX;
  }

  const nodes: KeyRateNodeDuration[] = knots.map((tenorYears, j) => ({
    tenorYears,
    duration: full.nodes[j],
  }));
  const convergence: KeyRateConvergence = {
    halvedBumpBp,
    residualYears,
    residualYearsAtHalvedBump,
    converged,
  };
  if (ratio !== undefined) convergence.ratio = ratio;

  return {
    scenarioId: inputs.scenarioId,
    discountBasis: basis,
    bumpBp,
    nodes,
    sum: full.sum,
    parallelReference: full.parallel,
    convergence,
  };
}
