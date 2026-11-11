// apps/studio/src/format/figures.ts
/**
 * ALM Studio P1 figure formatting for the new pages: USD millions with one
 * decimal and a true minus sign (U+2212). Formatting only: a value is negated
 * to print its sign, never combined with another value. A sign is printed only
 * when the rounded, printed magnitude is non-zero, so no figure reads as a
 * signed zero.
 */
import { pct, usdMM } from "@alm/reader";
import { stepDecimals } from "../charts/plotScale";

const MINUS = "−";

/** Prefix a printed magnitude with a sign unless it prints as the zero figure. */
function signed(sign: string, printed: string, zero: string): string {
  return printed === zero ? zero : `${sign}${printed}`;
}

export function money(v: number): string {
  return v < 0 ? signed(MINUS, usdMM(-v), usdMM(0)) : usdMM(v);
}

export function signedMoney(v: number): string {
  if (v > 0) return signed("+", usdMM(v), usdMM(0));
  if (v < 0) return signed(MINUS, usdMM(-v), usdMM(0));
  return usdMM(0);
}

export function signedRatio(r: number, digits = 1): string {
  if (r > 0) return signed("+", pct(r, digits), pct(0, digits));
  if (r < 0) return signed(MINUS, pct(-r, digits), pct(0, digits));
  return pct(0, digits);
}

/**
 * A chart's y tick in USD millions at the decimals its tick step needs (Polish 13): $800M on a $100M step, $2.5M on a
 * $0.5M step, grouped ($3,500M), a true minus sign, and no sign on a tick that prints as zero. The tooltip and the table
 * print millions too; LinePlot widens its left margin to the widest label (leftMargin). Formatting only.
 */
export function moneyTick(v: number, step: number): string {
  const d = stepDecimals(step / 1_000_000);
  const printed = `$${(Math.abs(v) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}M`;
  const zero = `$${(0).toFixed(d)}M`;
  return v < 0 ? signed(MINUS, printed, zero) : printed;
}
