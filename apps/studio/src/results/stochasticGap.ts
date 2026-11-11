// apps/studio/src/results/stochasticGap.ts
/**
 * The Gap distributions card's view model. The summary reply carries the envelope's `gap` block
 * verbatim; this file lays it out as rows and as CSV text. Each figure is a statistic of the run's Monte Carlo path
 * set, never a gap, and nothing here does arithmetic on one: every value is read as stored.
 */
import type { StochasticDistribution, StochasticGapBlock, StochasticSideDistributions } from "@alm/engine";
import { signedMM, usdMM } from "@alm/reader";

/**
 * A card figure in millions, signed as signedMM signs it, except that a value which rounds to $0.0M prints with no
 * sign: a path-set statistic at roundoff (a point mass read as -4e-9) is zero to the card, not "-$0.0M". The title
 * and the CSV keep the stored value at full precision.
 */
export function gapMM(v: number): string {
  const zero = usdMM(0);
  return usdMM(Math.abs(v)) === zero ? zero : signedMM(v);
}

/** The card's two views on the `stogap` hash key; Repricing by default (the key is then not written). */
export const GAP_VIEW_KEY = "stogap";
export const GAP_VIEWS = [
  { id: "repricing", label: "Repricing (SEG)" },
  { id: "liquidity", label: "Liquidity (EBP)" },
] as const;
export type GapView = (typeof GAP_VIEWS)[number]["id"];
export const gapViewOf = (query: Record<string, string> | undefined): GapView =>
  GAP_VIEWS.find((v) => v.id === query?.[GAP_VIEW_KEY])?.id ?? "repricing";

/** The pinned quantile set, the same as EVE and NII-12m. */
export const GAP_PS = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
export const GAP_P_LABELS = ["p5", "p25", "p50", "p75", "p95"] as const;

/** A stored quantile at p, or null when the distribution does not carry it (never interpolated here). */
export function quantileAt(d: StochasticDistribution, p: number): number | null {
  return d.quantiles.find((q) => q.p === p)?.value ?? null;
}

export const BEYOND_LABEL = "Beyond 10 years (not banded)";
export const MONTH1_LABEL = "Month-1 balance";

export type GapSide = "assets" | "liabilities" | "net";
export const SIDE_LABEL: Record<GapSide, string> = { assets: "Assets", liabilities: "Liabilities", net: "Net" };
const SIDES: readonly GapSide[] = ["assets", "liabilities", "net"];

/** One row of a card table, or one CSV line: what it is, where it sits, and its stored distribution. */
export interface GapStatRow {
  measure: "repricing" | "liquidity";
  table: "band" | "beyondHorizon" | "cumulative" | "runOff" | "month1Balance";
  label: string;
  startMonth: number | null;
  endMonth: number | null;
  side: GapSide;
  d: StochasticDistribution;
}

const bySide = (
  base: Omit<GapStatRow, "side" | "d">,
  s: StochasticSideDistributions,
): GapStatRow[] => SIDES.map((side) => ({ ...base, side, d: s[side] }));

/** Repricing (SEG, signed net): the eight bands, then the beyond-horizon line. */
export function repricingRows(g: StochasticGapBlock): GapStatRow[] {
  return [
    ...g.repricing.bands.map((b): GapStatRow => ({ measure: "repricing", table: "band", label: b.label, startMonth: b.startMonth, endMonth: b.endMonth, side: "net", d: b.net })),
    { measure: "repricing", table: "beyondHorizon", label: BEYOND_LABEL, startMonth: g.horizonMonths, endMonth: null, side: "net", d: g.repricing.beyondHorizon.net },
  ];
}

/** Repricing cumulative: each path's running sum of its bands, as stored. */
export function repricingCumulativeRows(g: StochasticGapBlock): GapStatRow[] {
  return g.repricing.bands.map((b) => ({ measure: "repricing", table: "cumulative", label: b.label, startMonth: b.startMonth, endMonth: b.endMonth, side: "net", d: b.cumulative }));
}

/** Liquidity (EBP balance, by side): the eight bands' run-off, then the beyond-horizon line and the month-1 balance. */
export function liquidityRows(g: StochasticGapBlock): GapStatRow[] {
  return [
    ...g.liquidity.bands.flatMap((b) => bySide({ measure: "liquidity", table: "runOff", label: b.label, startMonth: b.startMonth, endMonth: b.endMonth }, b.runOff)),
    ...bySide({ measure: "liquidity", table: "beyondHorizon", label: BEYOND_LABEL, startMonth: g.horizonMonths, endMonth: null }, g.liquidity.beyondHorizon),
    ...bySide({ measure: "liquidity", table: "month1Balance", label: MONTH1_LABEL, startMonth: 0, endMonth: 1 }, g.liquidity.month1Balance),
  ];
}

/** Liquidity cumulative run-off, by side, as stored. */
export function liquidityCumulativeRows(g: StochasticGapBlock): GapStatRow[] {
  return g.liquidity.bands.flatMap((b) => bySide({ measure: "liquidity", table: "cumulative", label: b.label, startMonth: b.startMonth, endMonth: b.endMonth }, b.cumulative));
}

/** RFC 4180 cell; String() keeps full float precision, no rounding; null is an empty cell. */
const csvCell = (v: string | number | null): string => {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Both views as one CSV, every figure as stored at full precision: repricing (bands, beyond-horizon, cumulative),
 * then liquidity by side (run-off bands, beyond-horizon, month-1 balance, cumulative). A pinned quantile the block
 * does not carry is an empty cell.
 */
export function gapDistributionsCsv(g: StochasticGapBlock): string {
  const lines = ["measure,table,band,startMonth,endMonth,side,nPaths,mean,standardError,stdev,min,max,p5,p25,p50,p75,p95"];
  for (const r of [...repricingRows(g), ...repricingCumulativeRows(g), ...liquidityRows(g), ...liquidityCumulativeRows(g)]) {
    lines.push(
      [r.measure, r.table, r.label, r.startMonth, r.endMonth, r.side, r.d.nPaths, r.d.mean, r.d.standardError, r.d.stdev, r.d.min, r.d.max, ...GAP_PS.map((p) => quantileAt(r.d, p))]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
