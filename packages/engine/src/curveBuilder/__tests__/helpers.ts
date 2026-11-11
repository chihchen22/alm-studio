/**
 * Test helpers: a curveSetup block that restates a market snapshot's curve
 * quotes, so a test can set the engine solver beside bootstrapZeroCurve.
 *
 * setupFromSnapshot mapping (Task 4 ruling): tenorMonths = round(tYears * 12);
 * every row is a par rate; instrument cash for a CASH quote, ois-swap for
 * SWAP, CMT_PAR and BILL_BEY (under semi-annual compounding the tenor alone
 * picks the treatment, so the label does not matter there). Conventions:
 * annual_act360 is ACT/360 with annual compounding; semiannual_bond is ACT/365
 * with semi-annual.
 *
 * monthExactSnapshot (Task 4 ruling, option A): the setup contract
 * carries whole months, so a sub-month quote, or a 1M quote stored as 0.083333
 * years, cannot be a setup row. The month-exact copy drops every quote that
 * rounds to 0 months and sets tYears = tenorMonths / 12 on the rest, refusing
 * loudly any quote more than 1e-4 years from a whole month. Kernel and engine
 * then run on the same in-memory copy; the file on disk is untouched.
 */
import type { MarketSnapshot } from "@alm/kernel";
import type { CurveInput, CurveInterpolation, CurveSetupBlock } from "../../contracts/curveSetup";

// The snap tolerance is the engine default's own rule (fromSnapshot.ts), so the two cannot drift.
import { MONTH_SNAP_TOLERANCE_YEARS } from "../fromSnapshot";

export function monthExactSnapshot(snap: MarketSnapshot): { snapshot: MarketSnapshot; dropped: string[] } {
  const dropped: string[] = [];
  const curveQuotes = snap.curveQuotes.flatMap((q) => {
    const months = Math.round(q.tYears * 12);
    if (months < 1) {
      dropped.push(q.term);
      return [];
    }
    if (Math.abs(q.tYears - months / 12) > MONTH_SNAP_TOLERANCE_YEARS) {
      throw new Error(
        `quote ${q.term} at ${q.tYears} years is not within ${MONTH_SNAP_TOLERANCE_YEARS} years of a whole month`,
      );
    }
    return [{ ...q, tYears: months / 12 }];
  });
  return { snapshot: { ...snap, curveQuotes }, dropped };
}

export function setupFromSnapshot(snap: MarketSnapshot, interpolation: CurveInterpolation): CurveSetupBlock {
  const semi = snap.curveConvention === "semiannual_bond";
  const inputs: CurveInput[] = snap.curveQuotes.map((q) => ({
    instrument: q.instrumentType === "CASH" ? "cash" : "ois-swap",
    tenorMonths: Math.round(q.tYears * 12),
    quoteType: "par-rate",
    value: q.rate,
  }));
  return {
    id: "from-snapshot",
    label: "from snapshot",
    baseCurve: semi ? "UST" : "SOFR",
    interpolation,
    dayCount: semi ? "ACT/365" : "ACT/360",
    compounding: semi ? "semi-annual" : "annual",
    inputs,
  };
}
