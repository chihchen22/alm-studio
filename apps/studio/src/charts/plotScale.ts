/**
 * The numbers behind LinePlot (Polish 10 T1): nice y ticks, the y range, the square-root and linear x scales and their inverse, x tick thinning,
 * the nearest stored x, path segments over nulls, the gap to a base series in bp, the zoom band and the tooltip's
 * place. Polish 11 adds the label-width tick thinning, the runs between nulls, the half-bp rounding away from zero, the
 * drag-zoom state, the legend toggle and a tooltip placement that never covers the crosshair. Chart geometry and display only: every plotted value is a stored one; the gap in bp is the one computed
 * figure the piece adds (ruling 3).
 */

export interface Ticks { lo: number; hi: number; step: number; ticks: number[] }
export type XScaleKind = "sqrt" | "linear";
export interface XScale { toPx: (x: number) => number; fromPx: (px: number) => number }
export interface XTick { value: number; label: string }
export type Point = [number, number | null];

/** Twelve significant digits: 0.1 + 0.2 prints as 0.3 on an axis. */
const clean = (v: number) => Number(v.toPrecision(12));

/** About n ticks on a 1, 2 or 5 times a power of ten step, from a tick at or under lo to a tick at or over hi. */
export function niceTicks(lo: number, hi: number, n: number): Ticks {
  let a = lo;
  let b = hi;
  if (!(b > a)) {
    const pad = Math.abs(a) * 0.01 || 1;
    a -= pad;
    b += pad;
  }
  const raw = (b - a) / Math.max(1, n);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const e = raw / mag;
  const step = clean((e >= 7 ? 10 : e >= 3 ? 5 : e >= 1.5 ? 2 : 1) * mag);
  const first = Math.floor(a / step + 1e-9);
  const last = Math.ceil(b / step - 1e-9);
  const ticks: number[] = [];
  for (let k = first; k <= last; k++) ticks.push(clean(k * step));
  return { lo: ticks[0]!, hi: ticks[ticks.length - 1]!, step, ticks };
}

/**
 * The y range of the plotted values: 5% padding each side, then nice ticks, about one per 45 px of plot height (four at
 * least). A set whose minimum is at or above zero floors at zero rather than padding below it. With zero (Polish 13)
 * the range always holds 0: an all-positive set floors at 0 however far above it it sits, an all-negative set tops at
 * 0, and a set that crosses 0 is unchanged.
 */
export function yDomain(values: number[], plotPx: number, zero = false): Ticks {
  const n = Math.max(4, Math.round(plotPx / 45));
  if (values.length === 0) return niceTicks(0, 1, n);
  let lo = values[0]!;
  let hi = values[0]!;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (zero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const pad = (hi - lo) * 0.05 || Math.abs(hi) * 0.05 || 0.001;
  const floor = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
  const top = zero && hi === 0 && lo < 0 ? 0 : hi + pad;
  return niceTicks(floor, top, n);
}

/** Maps the domain d0..d1 onto the pixels r0..r1, linearly or on a square-root axis (tenors to scale), and back. */
export function xScale(kind: XScaleKind, d0: number, d1: number, r0: number, r1: number): XScale {
  const f = kind === "sqrt" ? (v: number) => Math.sqrt(Math.max(0, v)) : (v: number) => v;
  const g = kind === "sqrt" ? (u: number) => u * u : (u: number) => u;
  const u0 = f(d0);
  const span = f(d1) - u0 || 1;
  const width = r1 - r0 || 1;
  return {
    toPx: (x) => r0 + ((f(x) - u0) / span) * (r1 - r0),
    fromPx: (px) => g(u0 + ((px - r0) / width) * span),
  };
}

/** The average glyph width of an 11 px axis label, in px (the mono face's 0.6 em; the sans digits are narrower). */
export const GLYPH_PX = 6.6;

/**
 * The plot's left margin in px for these y tick labels (Polish 13 fix round 1): min while the widest label fits it,
 * else the widest label's width (its characters times glyph px, rounded up) plus the gap to the plot and pad px of room
 * at the SVG's left edge. Short labels keep min, so a percent axis does not move.
 */
export function leftMargin(labels: string[], glyph = GLYPH_PX, gap = 8, min = 50, pad = 4): number {
  let longest = 0;
  for (const l of labels) longest = Math.max(longest, [...l].length);
  return Math.max(min, Math.ceil(longest * glyph) + gap + pad);
}

/**
 * A left margin that holds still (Polish 14): the larger of the margin for the y labels shown now and the margin for the
 * y labels of the full unzoomed range over every series, hidden ones included. Hiding a series or zooming cannot narrow
 * it and slide the plot sideways; a wider label shown now still widens it.
 */
export function steadyLeftMargin(shown: string[], full: string[], glyph = GLYPH_PX, gap = 8, min = 50, pad = 4): number {
  return Math.max(leftMargin(shown, glyph, gap, min, pad), leftMargin(full, glyph, gap, min, pad));
}

/**
 * Drops an x tick whose centred label box (its characters times glyph px) would come within gap px of the last label
 * kept, first tick first (Polish 11: by label width, not a fixed spacing).
 */
export function thinTicks(ticks: XTick[], toPx: (x: number) => number, glyph = GLYPH_PX, gap = 10): XTick[] {
  const out: XTick[] = [];
  let lastRight = -Infinity;
  for (const t of ticks) {
    const px = toPx(t.value);
    const half = (t.label.length * glyph) / 2;
    if (px - half - gap >= lastRight - 1e-9) {
      out.push(t);
      lastRight = px + half;
    }
  }
  return out;
}

/** The distinct stored x of the given series with a value, inside lo..hi, ascending. */
export function storedXs(series: Array<{ points: Point[] }>, lo: number, hi: number): number[] {
  const set = new Set<number>();
  for (const s of series) for (const [x, y] of s.points) if (y !== null && x >= lo - 1e-9 && x <= hi + 1e-9) set.add(x);
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * How far the line clip reaches past the plot in x (Polish 14): pad px when every stored x drawn (the visible series
 * and the context lines) lies inside x0..x1, within 1e-9, so a marker on the first or last x draws whole; else 0, as a
 * line that runs on past the window (a zoom, or a context line past a slice whose end cell is null) must stop at the edge.
 */
export function xClipPad(drawn: Array<{ points: Point[] }>, x0: number, x1: number, pad = 6): number {
  return storedXs(drawn, -Infinity, Infinity).every((x) => x >= x0 - 1e-9 && x <= x1 + 1e-9) ? pad : 0;
}

/** The stored x whose place is nearest px; the lower one on a tie; null when there is none. */
export function nearestX(xs: number[], toPx: (x: number) => number, px: number): number | null {
  let best: number | null = null;
  let bd = Infinity;
  for (const x of xs) {
    const d = Math.abs(toPx(x) - px);
    if (d < bd) {
      bd = d;
      best = x;
    }
  }
  return best;
}

/** An SVG path through the points in order; a null lifts the pen, so a missing value breaks the line. */
export function pathD(points: Point[], toPx: (x: number) => number, toPy: (y: number) => number): string {
  let d = "";
  let pen = false;
  for (const [x, y] of points) {
    if (y === null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${toPx(x).toFixed(2)},${toPy(y).toFixed(2)}`;
    pen = true;
  }
  return d;
}

/** The runs of stored points between nulls, in order: the pieces pathD draws, so an area can break where the line does. */
export function segments(points: Point[]): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  for (const [x, y] of points) {
    if (y === null) {
      if (run.length > 0) out.push(run);
      run = [];
      continue;
    }
    run.push([x, y]);
  }
  if (run.length > 0) out.push(run);
  return out;
}

/**
 * The gap of y to the base value in whole bp, on percent-unit values: (y - base) * 100 taken to 6 decimals first (so
 * float noise cannot move an exact half), then rounded half away from zero, so +0.5 and -0.5 bp give +1 and -1.
 */
export function deltaBp(y: number, base: number): number {
  const raw = Number(((y - base) * 100).toFixed(6));
  const bp = Math.sign(raw) * Math.round(Math.abs(raw));
  return bp === 0 ? 0 : bp;
}

/** A whole bp gap signed: +25, -10, 0. */
export function signedBp(bp: number): string {
  return bp > 0 ? `+${bp}` : `${bp}`;
}

/** Decimals a tick label needs at this step: 0.2 needs 1, 0.05 needs 2, 1 and over need none. */
export function stepDecimals(step: number): number {
  return Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
}

/** The zoomed domain of a drag from a to b px, clamped to the plot r0..r1 first; null when the clamped band is 8 px or less. */
export function zoomTo(a: number, b: number, scale: XScale, r0: number, r1: number): [number, number] | null {
  const band = zoomBand(a, b, r0, r1);
  return band === null ? null : [scale.fromPx(band[0]), scale.fromPx(band[1])];
}

/** A drag from a to b px clamped to the plot r0..r1, ascending; null when the clamped band is 8 px wide or less. */
export function zoomBand(a: number, b: number, r0: number, r1: number): [number, number] | null {
  const lo = Math.max(r0, Math.min(a, b));
  const hi = Math.min(r1, Math.max(a, b));
  return hi - lo <= 8 ? null : [lo, hi];
}

/** A drag zoom in progress: where the press was and where the pointer is, in px; null when there is none. */
export type ZoomDrag = { from: number; to: number } | null;
export type ZoomEvent = { type: "down"; px: number; button: number } | { type: "move" | "up"; px: number } | { type: "cancel" };

/**
 * The drag zoom's state after a pointer event. A primary-button press starts a band (another button leaves the state
 * as it was), a move stretches it, a release ends it and hands the band over to zoom to; a cancel or a lost pointer
 * capture ends it with nothing to zoom, so the band clears.
 */
export function zoomDrag(drag: ZoomDrag, e: ZoomEvent): { drag: ZoomDrag; release: [number, number] | null } {
  if (e.type === "cancel") return { drag: null, release: null };
  if (e.type === "down") return { drag: e.button === 0 ? { from: e.px, to: e.px } : drag, release: null };
  if (drag === null) return { drag: null, release: null };
  if (e.type === "move") return { drag: { from: drag.from, to: e.px }, release: null };
  return { drag: null, release: [drag.from, e.px] };
}

/** The hidden series after a legend click on id: a hidden one shows; a shown one hides unless it is the last one shown. */
export function toggleHidden(hidden: ReadonlySet<string>, ids: readonly string[], id: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else if (ids.some((s) => s !== id && !next.has(s))) next.add(id);
  return next;
}

/** The tooltip's left edge: gap px right of the crosshair, or gap px left of it when it would pass the right edge. */
export function tipLeft(px: number, tipW: number, width: number, gap = 16): number {
  const right = px + gap;
  return right + tipW > width - 4 ? Math.max(0, px - gap - tipW) : right;
}

/**
 * Where a tooltip tipW px wide goes beside a crosshair at px on a chart width px wide, never over the crosshair: gap px
 * to its right when it fits there (4 px short of the right edge), else gap px to its left when it fits there; when
 * neither side fits, on the side with more room with its width capped to that room (its rows wrap).
 */
export function tipPlace(px: number, tipW: number, width: number, gap = 16): { left: number; maxWidth: number | null } {
  const roomRight = Math.max(0, width - 4 - px - gap);
  const roomLeft = Math.max(0, px - gap);
  if (tipW <= roomRight) return { left: px + gap, maxWidth: null };
  if (tipW <= roomLeft) return { left: px - gap - tipW, maxWidth: null };
  if (roomRight >= roomLeft) return { left: px + gap, maxWidth: roomRight };
  return { left: px - gap - roomLeft, maxWidth: roomLeft };
}

/** The tooltip's top edge: centred on the pointer inside the plot's height; fallback when there is no pointer. */
export function tipTop(py: number | null, tipH: number, height: number, fallback: number): number {
  if (py === null) return fallback;
  return Math.max(0, Math.min(height - tipH, py - tipH / 2));
}

/**
 * The tooltip's rows at one x: each shown series with a value there, highest first (ties keep the shown order). A twin
 * of the delta series (a series with the base's own points, as a base scenario beside the base curve on Rates) is left
 * out where the delta series is shown with the same value, so the base prints once (Polish 15 item 4); where the two
 * differ, or the base is hidden or has no value, the twin's row stays.
 */
export function tipRows<S extends { id: string }>(shown: S[], valueOf: (s: S) => number | null, delta?: string, twin?: string): Array<{ s: S; v: number }> {
  const rows = shown
    .map((s) => ({ s, v: valueOf(s) }))
    .filter((r): r is { s: S; v: number } => r.v !== null)
    .sort((a, b) => b.v - a.v);
  const base = twin === undefined || twin === delta ? undefined : rows.find((r) => r.s.id === delta);
  return base === undefined ? rows : rows.filter((r) => !(r.s.id === twin && r.v === base.v));
}

/** Month ticks for a path chart over months lo..hi: every 3, 6, 12, 24 or 60 months by span, whole years in years with an uppercase Y (Polish 16). */
export function monthTicks(lo: number, hi: number): XTick[] {
  const years = (hi - lo) / 12;
  const step = years > 12 ? 60 : years > 5 ? 24 : years > 2 ? 12 : years > 1 ? 6 : 3;
  const out: XTick[] = [];
  for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) out.push({ value: m, label: m !== 0 && m % 12 === 0 ? `${m / 12}Y` : `M${m}` });
  return out;
}
