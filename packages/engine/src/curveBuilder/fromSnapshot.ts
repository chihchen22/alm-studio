/**
 * defaultSetupFromSnapshot: the curveSetup block the engine fills from a
 * market snapshot that carries none (spec v7
 * decisions 57 and 70). buildBaseCurve builds an unmarked market with no
 * curveSetup on it; an ok:false here is that build's fallback to
 * the kernel bootstrap, and its reason is the stamp's.
 *
 * Mapping (lifted from the test helpers setupFromSnapshot and
 * monthExactSnapshot): every quote becomes a par-rate row at
 * tenorMonths = round(tYears * 12); a CASH quote is a cash row, every other
 * instrument type an ois-swap row (under semi-annual compounding the tenor
 * alone picks the treatment, so the label does not matter there). A quote that
 * rounds to 0 months (an overnight or 1D rate) is dropped and returned by its
 * term in `dropped`; the setup contract carries whole months, so the short end
 * reads flat at the first month. Interpolation is log-linear on discount
 * factor. The convention follows the snapshot: annual_act360 is ACT/360 with
 * annual compounding, semiannual_bond is ACT/365 with semi-annual.
 *
 * A snapshot the default cannot represent is ok:false with a reason in words,
 * never a throw, so the caller can fall back to the version 1 route
 * (decision 70): no curveQuotes list, or an entry in it that is not a quote,
 * more than MAX_CURVE_INPUTS usable quotes (one month or
 * longer; the dropped sub-month quotes do not count), a quote past
 * MAX_TENOR_MONTHS, a quote more than 1e-4 years from a whole month, a quote
 * with no finite tenor, no quote of one month or longer, or any refusal of
 * validateCurveSetup on the filled block (a rounding duplicate, a rate above
 * 1.0, a par row off the coupon grid), with the validator's row numbers
 * replaced by the quote terms. On ok:true the block is validateCurveSetup's
 * own output, rows sorted by tenor. The snapshot is not changed.
 */
import type { MarketSnapshot } from "@alm/kernel";
import type { CurveInput, CurveSetupBlock } from "../contracts/curveSetup";
import { PLATFORM_DEFAULT_CURVE } from "../contracts/derivedCurve";
import { MAX_CURVE_INPUTS, MAX_TENOR_MONTHS, validateCurveSetup } from "./validate";

/** Largest distance, in years, from a whole month that a quote is snapped across. */
export const MONTH_SNAP_TOLERANCE_YEARS = 1e-4;

export type DefaultSetupResult =
  | { ok: true; block: CurveSetupBlock; dropped: string[] }
  | { ok: false; reason: string };

const PREFIX = "the default curve cannot take this snapshot: ";

export function defaultSetupFromSnapshot(snap: MarketSnapshot): DefaultSetupResult {
  const semi = snap.curveConvention === "semiannual_bond";
  if (!semi && snap.curveConvention !== "annual_act360") {
    return { ok: false, reason: `the snapshot's curve convention ${String(snap.curveConvention)} is not one the default curve maps` };
  }

  // A stored or hand-built snapshot is untyped data: a missing list or an entry that is not a quote is a
  // reason, never a TypeError (curveDefaultOf reads markets that carry only a curveSetup block).
  const quotes: unknown = (snap as { curveQuotes?: unknown }).curveQuotes;
  if (!Array.isArray(quotes)) return { ok: false, reason: "the snapshot carries no curveQuotes list" };

  const reasons: string[] = [];
  const dropped: string[] = [];
  const terms: string[] = [];
  const inputs: CurveInput[] = [];
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i] as MarketSnapshot["curveQuotes"][number] | null;
    if (q === null || typeof q !== "object") {
      reasons.push(`curve quote ${i + 1} is not a quote`);
      continue;
    }
    if (!Number.isFinite(q.tYears)) {
      reasons.push(`quote ${q.term} has no finite tenor in years`);
      continue;
    }
    const months = Math.round(q.tYears * 12);
    if (months < 1) {
      dropped.push(q.term);
      continue;
    }
    if (Math.abs(q.tYears - months / 12) > MONTH_SNAP_TOLERANCE_YEARS) {
      reasons.push(`quote ${q.term} at ${q.tYears} years is not within ${MONTH_SNAP_TOLERANCE_YEARS} years of a whole month`);
      continue;
    }
    if (months > MAX_TENOR_MONTHS) {
      reasons.push(`quote ${q.term} falls at ${months} months; the default curve runs to ${MAX_TENOR_MONTHS} months`);
      continue;
    }
    terms.push(q.term);
    inputs.push({
      instrument: q.instrumentType === "CASH" ? "cash" : "ois-swap",
      tenorMonths: months,
      quoteType: "par-rate",
      value: q.rate,
    });
  }
  // The limit counts usable rows: a dropped sub-month quote does not count against it.
  if (inputs.length > MAX_CURVE_INPUTS) {
    reasons.push(`the snapshot holds ${inputs.length} curve quotes of one month or longer; the default curve takes at most ${MAX_CURVE_INPUTS}`);
  }
  if (reasons.length > 0) return { ok: false, reason: reasons.join("; ") };
  if (inputs.length === 0) {
    const named = dropped.length > 0 ? ` (dropped: ${dropped.join(", ")})` : "";
    return { ok: false, reason: `the snapshot holds no curve quote of one month or longer${named}` };
  }

  const checked = validateCurveSetup({
    id: PLATFORM_DEFAULT_CURVE,
    label: "platform default curve",
    baseCurve: semi ? "UST" : "SOFR",
    interpolation: "log-linear-df",
    dayCount: semi ? "ACT/365" : "ACT/360",
    compounding: semi ? "semi-annual" : "annual",
    inputs,
  });
  if (!checked.ok) {
    // The validator names rows 1-based in the order sent, which is the order of `terms`.
    const named = checked.refusals.map((line) =>
      line.replace(/^row (\d+)\b/, (whole, n: string) => {
        const term = terms[Number(n) - 1];
        return term === undefined ? whole : `quote ${term}`;
      }),
    );
    return { ok: false, reason: PREFIX + named.join("; ") };
  }
  return { ok: true, block: checked.block, dropped };
}
