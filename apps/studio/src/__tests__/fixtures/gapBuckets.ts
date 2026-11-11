// apps/studio/src/__tests__/fixtures/gapBuckets.ts
/**
 * Gap `userBuckets` fixtures (spec decisions 107 and 108): a monthly arm of 40 rows,
 * enough for two pages of the paged table, and a custom arm of 6 rows on the edges [1, 3, 12, 60, 120] over a 360
 * month grid. Labels follow the engine: monthly `M<k+1>`, custom `M<start+1>-M<end>` or `M<end>` for one month.
 * The values are synthetic and chosen to print distinctly; they are not a fold of the demo envelope.
 */
import type { GapLadder } from "@alm/engine";

type Row = GapLadder["rows"][number];

function withCumulative(bands: Array<{ label: string; startMonth: number; endMonth: number; assets: number; liabilities: number }>): Row[] {
  let cum = 0;
  return bands.map((b) => {
    const gap = b.assets - b.liabilities;
    cum += gap;
    return { band: { label: b.label, startMonth: b.startMonth, endMonth: b.endMonth }, assets: b.assets, liabilities: b.liabilities, gap, cumulativeGap: cum };
  });
}

/** Month k (0-based) holds 100M + 1M k of assets and 90M + 3M k of liabilities, so the gap turns negative after month 5. */
export function monthlyRows(n: number): Row[] {
  return withCumulative(Array.from({ length: n }, (_, k) => ({
    label: `M${k + 1}`, startMonth: k, endMonth: k + 1, assets: 100_000_000 + 1_000_000 * k, liabilities: 90_000_000 + 3_000_000 * k,
  })));
}

export const CUSTOM_EDGES = [1, 3, 12, 60, 120];

export function customRows(): Row[] {
  const spans: Array<[string, number, number]> = [["M1", 0, 1], ["M2-M3", 1, 3], ["M4-M12", 3, 12], ["M13-M60", 12, 60], ["M61-M120", 60, 120], ["M121-M360", 120, 360]];
  return withCumulative(spans.map(([label, startMonth, endMonth], i) => ({
    label, startMonth, endMonth, assets: 510_000_000 + 10_000_000 * i, liabilities: 470_000_000 + 30_000_000 * i,
  })));
}

export const MONTHLY_BUCKETS = (n = 40): NonNullable<GapLadder["userBuckets"]> => ({ kind: "monthly", rows: monthlyRows(n) });
export const CUSTOM_BUCKETS = (): NonNullable<GapLadder["userBuckets"]> => ({ kind: "custom", edgesMonths: [...CUSTOM_EDGES], rows: customRows() });
