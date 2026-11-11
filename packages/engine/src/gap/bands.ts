/**
 * Standard gap time bands.
 *
 * The monthly bucket grid is the substrate; a gap ladder is a
 * presentation roll-up of those buckets into the standard bands 0-1M, 1-3M,
 * 3-6M, 6-12M, 1-2Y, 2-3Y, 3-5Y, 5-10Y, 10Y+. Band edges are expressed in
 * "months from asOf", the same units as a bucket index: a cashflow at
 * monthOffset m sits in bucket k = m - 1 (aggregate.ts), and bucket k falls in
 * the band whose [startMonth, endMonth) contains k.
 *
 * The last band (10Y+) runs to the horizon. When a caller uses a horizon
 * shorter than 120 months (small test grids), the edge list is truncated and
 * the final present band ends at the horizon, so the bands always partition
 * [0, horizon) with no gap and no overlap.
 */
import type { GapBand } from "../contracts/results";
import type { GapBucketsOption } from "../contracts/run";

/** Band edges in months from asOf; the final open band runs to the horizon. */
const BAND_EDGES: readonly number[] = [0, 1, 3, 6, 12, 24, 36, 60, 120];
/**
 * The band labels, in band order. Exported since piece 3a: a lens constraint
 * names a band by this label, and rule V4 must check it against the SAME list
 * buildBands labels its rows with rather than a second copy of it.
 */
export const GAP_BAND_LABELS: readonly string[] = [
  "0-1M",
  "1-3M",
  "3-6M",
  "6-12M",
  "1-2Y",
  "2-3Y",
  "3-5Y",
  "5-10Y",
  "10Y+",
];

/**
 * Build the band list for a horizon. Bands partition [0, horizon): each covers
 * [startMonth, endMonth), endMonth exclusive. The final band (10Y+, or the last
 * one that fits a short horizon) ends at the horizon.
 */
export function buildBands(horizonMonths: number): GapBand[] {
  if (!Number.isInteger(horizonMonths) || horizonMonths <= 0) {
    throw new Error("buildBands: horizonMonths must be a positive integer");
  }
  const bands: GapBand[] = [];
  for (let i = 0; i < BAND_EDGES.length; i++) {
    const start = BAND_EDGES[i];
    if (start >= horizonMonths) break;
    const end =
      i + 1 < BAND_EDGES.length ? Math.min(BAND_EDGES[i + 1], horizonMonths) : horizonMonths;
    bands.push({ label: GAP_BAND_LABELS[i], startMonth: start, endMonth: end });
  }
  return bands;
}

/**
 * The bands of a user bucket setting (spec decision 110), on the same convention as
 * the standard bands: each covers [startMonth, endMonth) in bucket units, bucket k being month k + 1.
 *
 * - monthly: one band per bucket, [k, k + 1), labelled `M1` to `M<horizon>`.
 * - custom: the first band is [0, e1), then [e1, e2) and so on; when the last edge falls short of the horizon a
 *   final band runs from it to the horizon, and when it equals the horizon there is no empty trailing band. A band
 *   is labelled by the months it holds, `M<start + 1>-M<end>`, or `M<end>` when it holds one month, so `[0, 1)`
 *   reads `M1`, as the monthly setting labels it, and `[3, 6)` reads `M4-M6`.
 *
 * The pipeline refuses an edge past the grid before the walk (gapBucketsConfigError); a direct caller handing one
 * here meets a throw rather than a silently truncated ladder.
 */
export function buildUserBands(option: GapBucketsOption, horizonMonths: number): GapBand[] {
  if (!Number.isInteger(horizonMonths) || horizonMonths <= 0) {
    throw new Error("buildUserBands: horizonMonths must be a positive integer");
  }
  const label = (start: number, end: number): string => (end - start === 1 ? `M${end}` : `M${start + 1}-M${end}`);
  if (option.kind === "monthly") {
    const bands: GapBand[] = [];
    for (let k = 0; k < horizonMonths; k++) bands.push({ label: `M${k + 1}`, startMonth: k, endMonth: k + 1 });
    return bands;
  }
  const bands: GapBand[] = [];
  let start = 0;
  for (const edge of option.edgesMonths) {
    if (!Number.isInteger(edge) || edge <= start || edge > horizonMonths) {
      throw new RangeError(
        `buildUserBands: edge ${edge} must be a whole month above ${start} and at most the horizon (${horizonMonths})`,
      );
    }
    bands.push({ label: label(start, edge), startMonth: start, endMonth: edge });
    start = edge;
  }
  if (start < horizonMonths) bands.push({ label: label(start, horizonMonths), startMonth: start, endMonth: horizonMonths });
  return bands;
}

/**
 * Index of the band containing bucket `k`. The bands partition [0, horizon), so
 * a bucket in range always maps; an out-of-range bucket throws rather than
 * silently landing in the wrong band.
 */
export function bandForBucket(bucket: number, bands: readonly GapBand[]): number {
  for (let b = 0; b < bands.length; b++) {
    if (bucket >= bands[b].startMonth && bucket < bands[b].endMonth) return b;
  }
  throw new RangeError(`bandForBucket: bucket ${bucket} falls outside every band`);
}
