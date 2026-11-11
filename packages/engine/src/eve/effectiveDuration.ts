/**
 * Effective duration of each product family and of equity, with per-shock
 * cash-flow regeneration and behavioral re-leveling.
 *
 * The measurement bumps ±shockBp around a base path, regenerates each
 * instrument's cash flows on each shifted path, and differences the PVs on the
 * shifted all-in curve. Three things this module does:
 *
 *  - Streaming family accumulation. PV is linear, so a family's PV is the sum of
 *    its positions' PVs. Rather than concatenate every position's regenerated
 *    legs into one array per shock (the OOM: three legs of a 25k-position
 *    mortgage family peak at ~3.8 GB at the 100k target), each position is generated,
 *    priced, and dropped in turn, accumulating a running PV per leg. The result
 *    is numerically identical to the concatenation to summation-reordering
 *    precision (equivalence pinned to 1e-9 in the tests); peak heap for the
 *    duration pass falls ~16x.
 *
 *  - Base-leg PV reuse. The base leg (shockBp 0) regenerates cash flows the
 *    static projection already produced. When every position in a family matures
 *    within the bucket horizon, the duration base-leg PV equals the static
 *    projection's family PV to 1e-13 (proven, both environments;
 *    wave5-perf-rootcause.md), so the caller can hand that PV in and skip the
 *    base-leg regeneration entirely (a 3-leg → 2-leg cut). The static projection
 *    is horizon-truncated while the duration engine prices full life (finding
 *    EVE-OBS-1), so reuse is GUARDED: if any position's maturity exceeds the
 *    horizon the family's base leg is regenerated full-life instead, preserving
 *    the documented full-life pricing.
 *
 *  - Non-IB NMD re-leveling. The Non-IB decay reads a trailing-MA regime
 *    excursion r − MA(r). A parallel level shock shifts the WHOLE rate
 *    environment, so the ±bump must shift the MA warmup history by the same
 *    amount or the excursion fires spuriously and the effective duration flips
 *    sign (the module's headline risk). We shift the warmup by
 *    shockBp/100 (%-pa units) so the excursion stays invariant to the
 *    measurement bump, while the opportunity-cost level incentive still reads
 *    the shocked spot rate and produces the genuine negative convexity. This
 *    reproduces the Lab's `nonIbGenerator` (analytics/__tests__/duration.test.ts)
 *    exactly. Every other instrument reads its moneyness off the already-shocked
 *    path, so the engine's ParallelShockPath is sufficient and no re-leveling is
 *    applied (matching the Lab: IB NMD-B dropped its salience term, mortgages
 *    read the shocked forward, fixed loans are path-independent).
 *
 * Equity effective duration is the signed finite difference of the family PVs:
 *
 *   D_E = (EVE_down − EVE_up) / (2 · EVE_0 · Δr),
 *   EVE_leg = Σ_asset PV_leg − Σ_liab PV_leg,
 *
 * with each family's three legs regenerated and re-discounted as above. This is
 * internally exact (not a duration-gap approximation): the same regenerated legs
 * feed EVE_0, EVE_up, EVE_down.
 */
import {
  buildWarmupSOFR1M,
  DeterministicRatePath,
  NMDeposit,
  ParallelShockPath,
  pvCashflows,
  type Cashflow,
  type NMDTerms,
  type RatePath,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import type { ProductFamilyDef } from "../contracts/chartOfAccounts";
import type { Position } from "../contracts/position";
import { seasoningOffsetOf } from "../portfolio/seasoning";
import type { RateIndexTable } from "../contracts/rateIndex";
import type { RunMacro } from "../macro/runMacro";
import { makeInstrument } from "../runtime/instrumentFactory";
import { isDerivativeFamily } from "../swap/derivatives";
import { discountFunction, spreadDiscountCache, type DiscountBasis } from "./discount";

/** One family paired with the positions that roll into it. */
export interface FamilyPositions {
  family: ProductFamilyDef;
  positions: Position[];
}

/** Per-family duration leg output plus the equity roll-up for one environment. */
export interface EnvironmentDurations {
  /** Families with at least one position, in the order supplied. */
  perFamily: Array<{ familyId: string; pvBase: number; effectiveDuration: number }>;
  /** Σ PV over asset families at the base leg (duration-engine PV). */
  pvAssets: number;
  /** Σ PV over liability families at the base leg. */
  pvLiabilities: number;
  /**
   * Piece 8: Σ PV over derivative families at the base leg, on the risk-free curve.
   * 0 on a book with none. Included in `eve` and in the equity
   * duration; a derivative family gets no `perFamily` row.
   */
  pvDerivatives: number;
  /** pvAssets − pvLiabilities + pvDerivatives at the base leg. */
  eve: number;
  /** Equity effective duration; NaN when EVE_0 is 0 (gate handles it downstream). */
  effectiveDurationEquity: number;
}

/**
 * Generate one position's cash flows on a shifted path, re-leveling the Non-IB
 * NMD warmup by the parallel bump so r − MA stays invariant. `shockBp` is the
 * measurement bump (0 on the base leg); only the Non-IB NMD consumes it. No
 * concatenation: the caller prices this leg and drops it before the next
 * position, so no per-family leg array is ever held.
 *
 * Seasoning re-anchor (D3a lift, W3-A7; spec: wave-2 W2-A3 report NOTE 1).
 * A seasoned fixed-loan (negative `originationOffsetMonths`; the only type the
 * validator admits at nonzero offset) emits its kernel stream in instrument
 * time; this leg re-anchors it to portfolio time so `pvCashflows` discounts at
 * as-of-relative dates: entries with monthOffset + off <= 0 fell before the
 * as-of date (elapsed) and are dropped, the rest shift to monthOffset + off —
 * the same arithmetic the aggregator and both gap ladders apply (bucket
 * m − 1 + off). Exact for fixed-loan streams, which are path-independent, so
 * the shifted stream IS the remaining stream. Offset 0 returns the kernel
 * array untouched (no copy, no reordering: byte-identical to the pre-lift
 * path).
 */
function generatePositionLeg(
  pos: Position,
  path: RatePath,
  shockBp: number,
  warmup: number[],
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
  nmdWarmup?: readonly number[],
  depositShiftPct?: number,
): Cashflow[] {
  if (pos.terms.type === "nmd") {
    const hist = shockBp === 0 ? warmup : warmup.map((h) => h + shockBp / 100);
    return new NMDeposit(pos.terms as NMDTerms, hist).generateCashflows(path);
  }
  const off = seasoningOffsetOf(pos.terms);
  // An nmd-b leg takes the run's warmup unshifted when the run named one; absent, the factory call is unchanged.
  // A full-form deposit reads the scenario's shift plus this leg's bump; absent, no key.
  const cfs = makeInstrument(
    pos.terms,
    depositShiftPct === undefined
      ? nmdWarmup !== undefined ? { rateIndices, macro, nmdWarmup } : { rateIndices, macro }
      : { rateIndices, macro, ...(nmdWarmup !== undefined ? { nmdWarmup } : {}), depositShiftPct: depositShiftPct + shockBp / 100 },
  ).generateCashflows(path);
  if (off === 0) return cfs;
  const shifted: Cashflow[] = [];
  for (const cf of cfs) {
    const m = cf.monthOffset + off;
    if (m <= 0) continue; // elapsed before as-of
    shifted.push({ ...cf, monthOffset: m });
  }
  return shifted;
}

/** Options for the environment-duration pass. */
export interface EnvironmentDurationOptions {
  /**
   * Base-leg PV per family from the static projection, reused in place of
   * regenerating the base leg (shockBp 0). Reuse is applied per family only when
   * every position in that family matures within `horizonMonths` (finding
   * EVE-OBS-1: the static PV is horizon-truncated, the duration engine prices
   * full life; the proven 1e-13 equality holds only under that condition). A
   * family that fails the guard regenerates its base leg full-life regardless.
   */
  reuseBasePv?: ReadonlyMap<string, number>;
  /**
   * The run's rate index table, handed to makeInstrument so an
   * indexed floater is wrapped on every bumped leg (the basis stays static).
   * Absent for a book that names no index.
   */
  rateIndices?: RateIndexTable;
  /**
   * The run's resolved macro value, threaded beside rateIndices to every
   * makeInstrument call. A mortgage carrying a housing group without it throws
   * MacroUnresolvedError. Absent outside a run.
   */
  macro?: RunMacro;
  /**
   * The environment's deposit warmup history (percent per annum,
   * oldest first). Present only on a run that named nmdWarmup: the nmd legs
   * re-level it by the bump exactly as they re-level the kernel series, and the
   * nmd-b legs take it unshifted, as the projection did. Absent, the kernel
   * warmup series, unchanged.
   */
  nmdWarmup?: readonly number[];
  /**
   * The environment's short-rate shift in percent, present only when the run's sets bind
   * a full beta form; each leg hands a full-form deposit this shift plus its own bump.
   */
  depositShiftPct?: number;
}

/**
 * True iff every position in the family matures within the bucket horizon —
 * measured in PORTFOLIO time: a seasoned position's remaining life is
 * maturityMonths + offset (offset negative), which is what the static
 * projection truncates against, so the 1e-13 base-leg equality condition is
 * remaining-maturity-in-horizon, not original-maturity-in-horizon (D3a lift,
 * W3-A7; spec: W2-A3 report NOTE 1). At offset 0 this is the pre-lift test
 * unchanged.
 */
function familyReuseEligible(positions: Position[], horizonMonths: number): boolean {
  for (const pos of positions) {
    if (pos.terms.maturityMonths + seasoningOffsetOf(pos.terms) > horizonMonths) return false;
  }
  return true;
}

/**
 * Per-family effective duration and equity effective duration around one rate
 * environment (a curve and its deterministic monthly path). Families with no
 * positions are skipped (they carry no duration). `shockBp` is the measurement
 * bump (default caller passes 100). PV accumulates position by position (no
 * concatenation), and the base leg is reused from the static projection where
 * `options.reuseBasePv` supplies it and the family is reuse-eligible.
 */
export function computeEnvironmentDurations(
  families: FamilyPositions[],
  curve: ZeroCurve,
  tlp: TLPCurve,
  horizonMonths: number,
  shockBp: number,
  basis: DiscountBasis,
  options: EnvironmentDurationOptions = {},
): EnvironmentDurations {
  const warmup = options.nmdWarmup !== undefined ? [...options.nmdWarmup] : buildWarmupSOFR1M();
  const basePath = new DeterministicRatePath(curve, horizonMonths);
  const upPath = new ParallelShockPath(basePath, +shockBp);
  const downPath = new ParallelShockPath(basePath, -shockBp);
  const df0 = discountFunction(curve, tlp, 0, basis);
  const dfUp = discountFunction(curve, tlp, +shockBp, basis);
  const dfDown = discountFunction(curve, tlp, -shockBp, basis);
  // Swap legs discount on the risk-free curve in every leg of the measurement.
  const df0RiskFree = discountFunction(curve, tlp, 0, "risk-free");
  const dfUpRiskFree = discountFunction(curve, tlp, +shockBp, "risk-free");
  const dfDownRiskFree = discountFunction(curve, tlp, -shockBp, "risk-free");
  const dr = shockBp / 1e4;
  // Spread-consistent basis: each position discounts at its own
  // spread, so the legs look its discount function up per position. On every
  // other basis the three functions above are used as they always were.
  const perPosition = basis === "spread-consistent";
  const df0For = perPosition ? spreadDiscountCache(curve, tlp, 0, basis) : undefined;
  const dfUpFor = perPosition ? spreadDiscountCache(curve, tlp, +shockBp, basis) : undefined;
  const dfDownFor = perPosition ? spreadDiscountCache(curve, tlp, -shockBp, basis) : undefined;

  const perFamily: EnvironmentDurations["perFamily"] = [];
  let pvAssets = 0;
  let pvLiabilities = 0;
  let eveBase = 0;
  let eveUp = 0;
  let eveDown = 0;
  let anyDerivative = false;
  let derivBase = 0;
  let derivUp = 0;
  let derivDown = 0;

  for (const { family, positions } of families) {
    if (positions.length === 0) continue;
    const derivative = isDerivativeFamily(family);
    const d0 = derivative ? df0RiskFree : df0;
    const dU = derivative ? dfUpRiskFree : dfUp;
    const dD = derivative ? dfDownRiskFree : dfDown;

    const reusePv = options.reuseBasePv?.get(family.id);
    const reuse =
      reusePv !== undefined && familyReuseEligible(positions, horizonMonths);

    let pvBase = reuse ? (reusePv as number) : 0;
    let pvUp = 0;
    let pvDown = 0;
    for (const pos of positions) {
      const own = perPosition && !derivative;
      if (!reuse) {
        pvBase += pvCashflows(generatePositionLeg(pos, basePath, 0, warmup, options.rateIndices, options.macro, options.nmdWarmup, options.depositShiftPct), own ? df0For!(pos) : d0);
      }
      pvUp += pvCashflows(generatePositionLeg(pos, upPath, +shockBp, warmup, options.rateIndices, options.macro, options.nmdWarmup, options.depositShiftPct), own ? dfUpFor!(pos) : dU);
      pvDown += pvCashflows(generatePositionLeg(pos, downPath, -shockBp, warmup, options.rateIndices, options.macro, options.nmdWarmup, options.depositShiftPct), own ? dfDownFor!(pos) : dD);
    }

    if (derivative) {
      // Into the equity legs, apart, added once below. No family
      // duration: a swap near par has a PV near zero to divide by.
      anyDerivative = true;
      derivBase += pvBase;
      derivUp += pvUp;
      derivDown += pvDown;
      continue;
    }

    const effectiveDuration = pvBase > 0 ? (pvDown - pvUp) / (2 * pvBase * dr) : 0;
    const sign = family.side === "liability" ? -1 : 1;
    eveBase += sign * pvBase;
    eveUp += sign * pvUp;
    eveDown += sign * pvDown;
    if (family.side === "liability") pvLiabilities += pvBase;
    else pvAssets += pvBase;
    perFamily.push({ familyId: family.id, pvBase, effectiveDuration });
  }

  if (anyDerivative) {
    eveBase += derivBase;
    eveUp += derivUp;
    eveDown += derivDown;
  }

  const effectiveDurationEquity =
    eveBase !== 0 ? (eveDown - eveUp) / (2 * eveBase * dr) : NaN;

  return {
    perFamily,
    pvAssets,
    pvLiabilities,
    pvDerivatives: derivBase,
    eve: eveBase,
    effectiveDurationEquity,
  };
}
