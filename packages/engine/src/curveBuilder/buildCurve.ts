/**
 * buildCurveFromSetup: a curveSetup block to a kernel ZeroCurve (ALM Studio
 * Piece B).
 *
 * (1) Legacy delegate. Interpolation linear-zero, every row a cash or ois-swap
 *     par rate, and a (dayCount, compounding) pair the kernel knows
 *     (ACT/360 annual is annual_act360; ACT/365 semi-annual is
 *     semiannual_bond): the rows become a kernel snapshot and
 *     bootstrapZeroCurve's curve is returned UNCHANGED, so a legacy setup is
 *     the kernel's bytes. Rows the kernel cannot start from or lay out (a par
 *     swap first, a swap off the whole-year or half-year grid) skip the
 *     delegate, and so does any futures row. A kernel bracket refusal (a
 *     BrentBracketError: it tries the prior node's zero rate less 5 and
 *     plus 10 percentage points, floored at 1e-5, then 1e-5 to 30 percent,
 *     so negative zeros and very steep jumps refuse) falls through to the
 *     solver, which prices the same rows under
 *     the same linear-zero model; any other kernel throw propagates. The
 *     fall-through is not silent: the built curve carries one warning line
 *     saying the solver built it (FALL_THROUGH_WARNING), ahead of the
 *     solver's own warnings.
 * (2) Everything else runs solveNodes. Linear-zero is the kernel's own lerp,
 *     so the curve is the quote nodes. The other three methods write dense
 *     nodes at k/12, k = 1..last node tenor month (a futures row's node is its
 *     start plus 3 months), from the method's interpolator; the kernel's
 *     linear-in-zero lerp between whole months then reads the method's values
 *     at every whole month, where coupon dates fall.
 *     Every curve on this path is the engine's fast curve (fastCurve.ts):
 *     the kernel's reads bit for bit over the same nodes, found by binary
 *     search, so 360 dense nodes read about as fast as 11. The legacy
 *     delegate above stays the kernel's own object.
 *
 * Cash accrual (rowDiscount.ts): under ACT/360
 * with annual compounding, the three new methods price a cash par row as
 * DF(t) = 1 / (1 + r t 365/360). Linear-zero keeps the kernel's
 * 1 / (1 + r t) on both paths, the delegate and the fall-through, so a legacy
 * setup is still the kernel's bytes. No other row's accrual changes.
 *
 * The platform default: buildBaseCurve builds an unmarked market
 * with no curveSetup through here on the log-linear-df setup
 * defaultSetupFromSnapshot fills, so it takes path (2), never the delegate;
 * curve default version 1 is the kernel bootstrap called by buildBaseCurve
 * itself, not this delegate.
 *
 * The quote tenors are always registered on the returned curve object.
 * CurveBuildError from the solver propagates unchanged; buildBaseCurve's
 * platform default catches it and falls back to version 1.
 */
import { bootstrapZeroCurve, BrentBracketError } from "@alm/kernel";
import type { CurveConvention, CurveInstrumentType, MarketSnapshot, ZeroCurve } from "@alm/kernel";
import type { CurveInput, CurveSetupBlock } from "../contracts/curveSetup";
import { makeFastCurve } from "./fastCurve";
import { makeZeroInterpolator } from "./interpolators";
import { registerQuoteTenors } from "./quoteTenors";
import { nodeTenorMonths } from "./rowDiscount";
import { negativeForwardWarnings, solveNodes } from "./solve";

export interface BuiltCurve {
  curve: ZeroCurve;
  quoteTenors: number[];
  warnings: string[];
}

/** The kernel convention for a (dayCount, compounding) pair, or undefined when the kernel has none. */
function kernelConvention(block: CurveSetupBlock): CurveConvention | undefined {
  if (block.dayCount === "ACT/360" && block.compounding === "annual") return "annual_act360";
  if (block.dayCount === "ACT/365" && block.compounding === "semi-annual") return "semiannual_bond";
  return undefined;
}

/** True for a row the kernel prices directly (no par equation): its first node must be one. */
function kernelDirect(row: CurveInput, convention: CurveConvention): boolean {
  if (convention === "semiannual_bond") return row.tenorMonths < 12;
  return row.instrument === "cash" || row.tenorMonths <= 12;
}

/** Every structural condition bootstrapZeroCurve needs, checked before it is called. */
function kernelAccepts(block: CurveSetupBlock, convention: CurveConvention): boolean {
  const rows = block.inputs;
  if (rows.length === 0 || !kernelDirect(rows[0], convention)) return false;
  return rows.every((row, i) => {
    // Only cash and ois-swap par rows go to the kernel; anything else (futures, or an instrument off the
    // menu on a block that skipped the validator) goes to the solver, which refuses the latter in words.
    if (row.quoteType !== "par-rate" || (row.instrument !== "cash" && row.instrument !== "ois-swap")) return false;
    if (!(Number.isInteger(row.tenorMonths) && row.tenorMonths > 0)) return false;
    if (i > 0 && !(row.tenorMonths > rows[i - 1].tenorMonths)) return false;
    if (kernelDirect(row, convention)) return true;
    return row.tenorMonths % (convention === "semiannual_bond" ? 6 : 12) === 0;
  });
}

function kernelInstrument(row: CurveInput, convention: CurveConvention): CurveInstrumentType {
  // Under semiannual_bond the kernel keys off the tenor and the label is metadata.
  if (convention === "semiannual_bond") return row.tenorMonths < 12 ? "BILL_BEY" : "CMT_PAR";
  return row.instrument === "cash" ? "CASH" : "SWAP";
}

/** The warning line a fall-through from the kernel bootstrap to the solver carries. */
export const FALL_THROUGH_WARNING =
  "the platform bootstrap could not bracket a zero rate for these rows (a negative or very steep zero rate is outside its root search); the engine solver built this curve under the same linear-zero model";
/** The same, for a kernel bootstrap that returned a non-finite zero rate. */
export const NON_FINITE_FALL_THROUGH_WARNING =
  "the platform bootstrap returned a non-finite zero rate for these rows; the engine solver built this curve under the same linear-zero model";

/** The kernel's bootstrap of the rows, or the warning line saying why the solver builds them instead. */
function legacyBootstrap(block: CurveSetupBlock, convention: CurveConvention): { curve: ZeroCurve } | { fallThrough: string } {
  // bootstrapZeroCurve reads only curveQuotes and curveConvention, so the
  // snapshot carries those two fields and is cast to the full type; building a
  // fake full MarketSnapshot would invent calibration dates and vol surfaces.
  const synthetic: Pick<MarketSnapshot, "curveQuotes" | "curveConvention"> = {
    curveConvention: convention,
    curveQuotes: block.inputs.map((row) => ({
      term: `${row.tenorMonths}M`,
      tYears: row.tenorMonths / 12,
      instrumentType: kernelInstrument(row, convention),
      rate: row.value,
    })),
  };
  let curve: ZeroCurve;
  try {
    curve = bootstrapZeroCurve(synthetic as MarketSnapshot);
  } catch (e) {
    if (e instanceof BrentBracketError) return { fallThrough: FALL_THROUGH_WARNING };
    throw e;
  }
  return curve.z.every(Number.isFinite) ? { curve } : { fallThrough: NON_FINITE_FALL_THROUGH_WARNING };
}

export function buildCurveFromSetup(block: CurveSetupBlock): BuiltCurve {
  const mapped = kernelConvention(block);
  const fallThrough: string[] = [];

  if (block.interpolation === "linear-zero" && mapped !== undefined && kernelAccepts(block, mapped)) {
    const legacy = legacyBootstrap(block, mapped);
    if ("curve" in legacy) {
      const kernel = legacy.curve;
      const quoteTenors = [...kernel.t];
      registerQuoteTenors(kernel, quoteTenors);
      return { curve: kernel, quoteTenors, warnings: negativeForwardWarnings(block, kernel.t, kernel.z) };
    }
    fallThrough.push(legacy.fallThrough);
  }

  const solved = solveNodes(block);
  const { t, z } = solved;
  const warnings = [...fallThrough, ...solved.warnings];
  // The convention field does not move discount factors or zero rates (they read the
  // nodes alone), but it is not display only: it sets the par basis forwardSwapRate
  // uses, and forwardSwapRate gives the 10-year benchmark the mortgage refinancing
  // rate, the client-rate benchmark and new-business pricing read (forwardRateBey
  // reads it too). A pair with no kernel convention takes the forward basis of its
  // compounding: a semi-annual pair is handed semiannual_bond, and
  // an annual or continuous pair annual_act360. The nodes are the solver's either way.
  const convention: CurveConvention = mapped ?? (block.compounding === "semi-annual" ? "semiannual_bond" : "annual_act360");

  let curve: ZeroCurve;
  if (block.interpolation === "linear-zero") {
    curve = makeFastCurve([...t], [...z], convention);
  } else {
    const zf = makeZeroInterpolator(block.interpolation, t, z);
    const lastMonth = Math.max(...block.inputs.map(nodeTenorMonths));
    const dt: number[] = [];
    const dz: number[] = [];
    for (let k = 1; k <= lastMonth; k++) {
      dt.push(k / 12);
      dz.push(zf(k / 12));
    }
    curve = makeFastCurve(dt, dz, convention);
  }
  registerQuoteTenors(curve, t);
  return { curve, quoteTenors: [...t], warnings };
}
