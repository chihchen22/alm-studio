/**
 * The derived curve spread read: linear in tenor
 * months between rows, flat before the first row and after the last, returned
 * as a decimal (spreadBp / 10000). The block is assumed validated: at least one
 * row, tenors strictly ascending.
 */
import type { DerivedCurveBlock } from "../contracts/derivedCurve";

const BP = 10000;

/** The spread at `tenorMonths`, as a decimal (12 bp reads 0.0012). */
export function spreadAt(block: DerivedCurveBlock, tenorMonths: number): number {
  const rows = block.spreads;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (tenorMonths <= first.tenorMonths) return first.spreadBp / BP;
  if (tenorMonths >= last.tenorMonths) return last.spreadBp / BP;
  // At most 60 rows: a linear scan for the bracket t0 <= n < t1.
  let i = 0;
  while (rows[i + 1].tenorMonths <= tenorMonths) i++;
  const { tenorMonths: t0, spreadBp: s0 } = rows[i];
  const { tenorMonths: t1, spreadBp: s1 } = rows[i + 1];
  return (s0 + ((s1 - s0) * (tenorMonths - t0)) / (t1 - t0)) / BP;
}
