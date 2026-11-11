/**
 * Shared fan statistics helpers. Generic path-fan math with no model content;
 * split out so surfaces that only need a percentile do not import a model
 * engine to get one.
 */

/** Linear-interpolated percentile of an ascending-sorted array (matches the classroom MBS fan). */
export function fanPercentile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const rest = pos - lo;
  return sorted[lo + 1] !== undefined ? sorted[lo] + rest * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}
