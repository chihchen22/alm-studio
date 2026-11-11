/**
 * Vol surface grids for the Data page heatmaps. Every cell value is
 * a stored decimal normal vol times VOL_TO_BP (display scaling to basis
 * points); no helper interpolates, smooths, or computes a statistic beyond
 * the min and max the color bar prints.
 */
import type { CatalogMarketSnapshot } from "./api/catalog";

/** Display scaling: a stored decimal normal vol times this is basis points. */
export const VOL_TO_BP = 10000;
/**
 * Display text for a stored decimal normal vol in basis points:
 * v times VOL_TO_BP, at most 4 fraction digits. The same display scaling the
 * grids apply; it adds no figure.
 */
export function volBpText(v: number): string {
  return (v * VOL_TO_BP).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Number of ramp steps; the CSS tokens are --seq-1 .. --seq-13. */
export const RAMP_STEPS = 13;

export interface VolGrid {
  /** Sorted ascending, years. */
  rows: number[];
  /** Sorted ascending: decimal strikes (cap) or years (swaption). */
  cols: number[];
  /** cells[r][c]: normal vol in bp, or null where no quote exists. */
  cells: Array<Array<number | null>>;
  /** Cap only: per row, the at-the-money vol in bp or null. Swaption: null. */
  atm: Array<number | null> | null;
  /** Over every non-null cell and atm value; both 0 on an empty surface. */
  min: number;
  max: number;
}

type CapQuote = CatalogMarketSnapshot["capVolSurface"][number];
type SwaptionQuote = CatalogMarketSnapshot["swaptionVolSurface"][number];

function sortedDistinct(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function emptyCells(rows: number, cols: number): Array<Array<number | null>> {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, (): number | null => null));
}

function extremes(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function indexOf(map: Map<number, number>, key: number, what: string): number {
  const i = map.get(key);
  if (i === undefined) throw new Error(`${what} ${key} is not on the grid`);
  return i;
}

/** Cap surface: rows are expiries, cols are fixed strikes, ATM quotes fill `atm`. */
export function capGrid(surface: CapQuote[]): VolGrid {
  const rows = sortedDistinct(surface.map((q) => q.expiryYears));
  const fixed: Array<{ expiryYears: number; strike: number; normalVol: number }> = [];
  for (const q of surface) {
    if (q.isAtm) continue;
    if (q.strike === null) {
      throw new Error(`short-rate volatility surface point at expiry ${q.expiryYears} has a null strike and no at-the-money flag`);
    }
    fixed.push({ expiryYears: q.expiryYears, strike: q.strike, normalVol: q.normalVol });
  }
  const cols = sortedDistinct(fixed.map((q) => q.strike));
  const rowIndex = new Map(rows.map((r, i) => [r, i] as const));
  const colIndex = new Map(cols.map((c, i) => [c, i] as const));
  const cells = emptyCells(rows.length, cols.length);
  const atm: Array<number | null> = rows.map((): number | null => null);
  const seen: number[] = [];

  for (const q of surface) {
    if (!q.isAtm) continue;
    const r = indexOf(rowIndex, q.expiryYears, "expiry");
    if (atm[r] !== null) throw new Error(`duplicate at-the-money point on the short-rate volatility surface at expiry ${q.expiryYears}`);
    const bp = q.normalVol * VOL_TO_BP;
    atm[r] = bp;
    seen.push(bp);
  }
  for (const q of fixed) {
    const r = indexOf(rowIndex, q.expiryYears, "expiry");
    const c = indexOf(colIndex, q.strike, "strike");
    if (cells[r][c] !== null) {
      throw new Error(`duplicate point on the short-rate volatility surface at expiry ${q.expiryYears}, strike ${q.strike}`);
    }
    const bp = q.normalVol * VOL_TO_BP;
    cells[r][c] = bp;
    seen.push(bp);
  }
  const { min, max } = extremes(seen);
  return { rows, cols, cells, atm, min, max };
}

/** Swaption ATM surface: rows are expiries, cols are tenors, no ATM column. */
export function swaptionGrid(surface: SwaptionQuote[]): VolGrid {
  const rows = sortedDistinct(surface.map((q) => q.expiryYears));
  const cols = sortedDistinct(surface.map((q) => q.tenorYears));
  const rowIndex = new Map(rows.map((r, i) => [r, i] as const));
  const colIndex = new Map(cols.map((c, i) => [c, i] as const));
  const cells = emptyCells(rows.length, cols.length);
  const seen: number[] = [];
  for (const q of surface) {
    const r = indexOf(rowIndex, q.expiryYears, "expiry");
    const c = indexOf(colIndex, q.tenorYears, "tenor");
    if (cells[r][c] !== null) {
      throw new Error(`duplicate point on the long-yield volatility surface at expiry ${q.expiryYears}, tenor ${q.tenorYears}`);
    }
    const bp = q.normalVol * VOL_TO_BP;
    cells[r][c] = bp;
    seen.push(bp);
  }
  const { min, max } = extremes(seen);
  return { rows, cols, cells, atm: null, min, max };
}

/**
 * 0 .. RAMP_STEPS-1: the ramp step for `bp` on a linear scale from min to max,
 * RAMP_STEPS equal-width bins, clamped; 0 when min === max.
 */
export function rampIndex(bp: number, min: number, max: number): number {
  if (max === min) return 0;
  const raw = Math.floor(((bp - min) / (max - min)) * RAMP_STEPS);
  return Math.min(RAMP_STEPS - 1, Math.max(0, raw));
}
