/**
 * Market rows. curveLines copies each stored curve's quoted points and orders
 * them by tYears (an ordering, not a computation); a curve with no points is
 * left out. curveAxis lines several
 * point lists up on one tenor axis by matching tYears exactly; a curve with no
 * point at a tenor gets null there, never a filled value. seqStep picks the
 * --seq-N colour bucket for a heatmap cell (display only).
 */
import type { CurveNodes } from "@alm/engine";
import { CATALOG_CURVES, type CatalogCurveName, type CatalogMarketSnapshot } from "@alm/reader";
import { tenorLabel } from "../format/tenor";

export interface CurvePoint { tYears: number; term: string | null; value: number }
export interface CurveLine { curve: CatalogCurveName; points: CurvePoint[] }

/**
 * One line per stored curve that holds a point, in CATALOG_CURVES order; points copied and sorted by tYears. A curve
 * with no points (a derived market stores no term-funding quotes) draws no line.
 */
export function curveLines(snap: CatalogMarketSnapshot): CurveLine[] {
  return CATALOG_CURVES.filter((c) => snap.curves[c] !== undefined && snap.curves[c].length > 0).map((curve) => ({
    curve,
    points: snap.curves[curve].map((p) => ({ tYears: p.tYears, term: p.term, value: p.value })).sort((a, b) => a.tYears - b.tYears),
  }));
}

/**
 * A shared tenor axis: the distinct tYears ascending (tenors, in years, so a chart can place them to scale), a label
 * per tenor (the first stored term, else the tenor label: 1M, 6M, 10Y), and each list's value or null.
 */
export function curveAxis(lists: CurvePoint[][]): { tenors: number[]; labels: string[]; values: Array<Array<number | null>> } {
  const tenors = Array.from(new Set(lists.flatMap((l) => l.map((p) => p.tYears)))).sort((a, b) => a - b);
  const labels = tenors.map((t) => {
    for (const l of lists) {
      const term = l.find((p) => p.tYears === t)?.term;
      if (term) return term;
    }
    return tenorLabel(t);
  });
  const values = lists.map((l) => tenors.map((t) => l.find((p) => p.tYears === t)?.value ?? null));
  return { tenors, labels, values };
}

/** 1..steps: the ramp bucket for bp on `steps` equal-width bins from min to max, clamped; the middle step when min equals max. */
export function seqStep(bp: number, min: number, max: number, steps: 7): number {
  if (max === min) return Math.ceil(steps / 2);
  const raw = Math.floor(((bp - min) / (max - min)) * steps);
  return Math.min(steps, Math.max(1, raw + 1));
}

/** One tenor of the curves table. Every rate is a decimal; a cell the snapshot does not quote is null, never filled. */
export interface CurveTableRow {
  tYears: number;
  term: string;
  /** Continuously compounded zero rate at the tenor, off the engine's bootstrapped base curve. */
  zero: number;
  /** The stored par quote at the tenor; null when the snapshot quotes none there. */
  par: number | null;
  /** Simply compounded forward over [t, t + 1/12], off the discount factors. */
  forward1m: number;
  df: number;
  /** The stored term liquidity premium (continuously compounded zero spread) at the tenor; null when none is stored there. */
  tlp: number | null;
  /** Zero plus the TLP, the same continuous spread the engine's all-in discount adds; null when the TLP is. */
  allIn: number | null;
}

/** A stored tenor is matched to a curve node by value; the pack writes 1M as 0.083333 on every curve. */
const SAME_TENOR = 1e-9;
const ONE_MONTH = 1 / 12;

/** Zero rate at x: linear in z between nodes and flat outside, the engine's interpolation (bootstrap.ts, _curveLerp). */
function zeroAt(base: CurveNodes, x: number): number {
  const n = base.t.length;
  if (x <= base.t[0]!) return base.z[0]!;
  if (x >= base.t[n - 1]!) return base.z[n - 1]!;
  let i = 1;
  while (base.t[i]! < x) i++;
  const t0 = base.t[i - 1]!;
  const w = (x - t0) / (base.t[i]! - t0);
  return base.z[i - 1]! + w * (base.z[i]! - base.z[i - 1]!);
}

/**
 * The curves table: one row per node of the base zero curve (the eleven quoted tenors of the Lab pack). Zero and
 * discount factor are the nodes the preview route returned; par and TLP are the snapshot's stored points at that
 * tenor; the forward and the all-in are the two computed columns, both stated in the card's source line.
 */
export function curveTable(snap: CatalogMarketSnapshot, base: CurveNodes): CurveTableRow[] {
  const at = (curve: CatalogCurveName, t: number) => snap.curves[curve]?.find((p) => Math.abs(p.tYears - t) < SAME_TENOR);
  return base.t.map((t, i) => {
    const zero = base.z[i]!;
    const df = base.df[i]!;
    const par = at("risk-free", t);
    const tlp = at("tlp", t);
    const dfLater = Math.exp(-zeroAt(base, t + ONE_MONTH) * (t + ONE_MONTH));
    return {
      tYears: t,
      term: par?.term ?? tenorLabel(t),
      zero,
      par: par?.value ?? null,
      forward1m: (df / dfLater - 1) / ONE_MONTH,
      df,
      tlp: tlp?.value ?? null,
      allIn: tlp === undefined ? null : zero + tlp.value,
    };
  });
}
