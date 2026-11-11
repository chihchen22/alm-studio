// apps/studio/src/format/tenor.ts
/**
 * A served tenor as its label (Studio Polish 1 S5). The market snapshot stores
 * the one-month tenor as 0.083333 years, which the reader's sig() prints as is.
 * A tenor under a year that is a whole number of months, to within a thousandth
 * of a month, prints as that many months ("1M"); any other prints in years
 * through sig() with an uppercase Y, the market convention the stored curve
 * terms already use (1Y, 10Y), so Market and Rates spell a tenor alike (Polish
 * 15 item 3). A label only: the value on the chart and in the table is the
 * served one.
 */
import { sig } from "@alm/reader";

/** How far, in months, a stored tenor may sit from a whole month and still read as one: the snapshot rounds 1/12 to 0.083333. */
const MONTH_TOLERANCE = 1e-3;

export function tenorLabel(t: number): string {
  const months = 12 * t;
  const whole = Math.round(months);
  return t < 1 && whole >= 1 && Math.abs(months - whole) < MONTH_TOLERANCE ? `${whole}M` : `${sig(t)}Y`;
}
