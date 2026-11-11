/**
 * The numbers behind the 3D vol surface (Polish 10 T3). The grid's stored quotes are the vertices, set in a unit box: x the strike (linear) or the swap tenor
 * (square root), y the expiry (square root), z the vol on a nice-tick range, 0.62 of the box tall. A turn about the
 * vertical axis (azimuth) and a tilt (elevation, clamped between 3 and 86 degrees) project a vertex to the canvas and
 * give its view depth. A face joins four stored quotes and is skipped when a corner is missing; faces paint far to
 * near by mean depth, each filled with the --seq-N step of its mean vol on the grid's own seven equal bins and shaded
 * by a fixed light at up to 50% alpha. Hover snaps to the nearest stored quote within 16 px. The box and its labels
 * are fitted to the canvas on every draw, an axis seen edge-on is not labelled, and a label that would meet one
 * already placed is skipped. Polish 11 places the vol ticks first, breaks the selection trace at a
 * missing quote, falls back to stored strikes for the cap ticks and holds the drag's pointer rules. Geometry and display only: no quote is interpolated or smoothed.
 */
import type { VolGrid } from "@alm/reader";
import { seqStep } from "../rows/marketRows";
import { niceTicks, type Ticks } from "./plotScale";

export interface View { az: number; el: number }
export interface Projected { x: number; y: number; d: number }
export interface Vertex { i: number; j: number; X: number; Y: number; Z: number; v: number }
export interface Face { corners: [Vertex, Vertex, Vertex, Vertex]; pts: Projected[]; depth: number; step: number; shade: number }

/** The four preset views: a three-quarter view, strikes or tenors face on, expiries face on, and from above. */
export const VIEWS: Record<"iso" | "front" | "side" | "top", View> = {
  iso: { az: -0.72, el: 0.52 },
  front: { az: 0, el: 0.12 },
  side: { az: -Math.PI / 2, el: 0.12 },
  top: { az: 0, el: 1.5 },
};
export const EL_MIN = (3 * Math.PI) / 180;
export const EL_MAX = (86 * Math.PI) / 180;
/** The box's height in unit-box lengths: the vol axis runs 0 to Z_TOP. */
export const Z_TOP = 0.62;
/** The fixed light, in the unit box, from the upper left and the front. */
const LIGHT: [number, number, number] = [-0.35, -0.45, 0.82];

export const clampEl = (el: number) => Math.max(EL_MIN, Math.min(EL_MAX, el));

/** Where the unit box sits on the canvas: S px to a unit, its origin at cx, cy. */
export interface Fit { S: number; cx: number; cy: number }

/** The largest scale the box takes on a W by H canvas: the smaller of 64% of the width and 102% of the height. */
export const scaleCap = (W: number, H: number) => Math.min(W * 0.64, H * 1.02);

/** The placement before a fit: the cap scale, centred across, the floor 60% down plus 0.08 S. */
export function baseFit(W: number, H: number): Fit {
  const S = scaleCap(W, H);
  return { S, cx: W / 2, cy: H * 0.6 + S * 0.08 };
}

/** A unit-box point at unit scale about the origin: x right and y down in units, d its depth along the view (larger is farther). */
export function projectUnit(X: number, Y: number, Z: number, view: View): Projected {
  const ca = Math.cos(view.az);
  const sa = Math.sin(view.az);
  const ce = Math.cos(view.el);
  const se = Math.sin(view.el);
  const xr = X * ca - Y * sa;
  const yr = X * sa + Y * ca;
  return { x: xr, y: -(Z * ce + yr * se), d: yr * ce - Z * se };
}

/** A unit-box point on the canvas W by H through a fit (by default the unfitted placement): x and y in px, d its depth. */
export function project(X: number, Y: number, Z: number, view: View, W: number, H: number, fit: Fit = baseFit(W, H)): Projected {
  const u = projectUnit(X, Y, Z, view);
  return { x: fit.cx + fit.S * u.x, y: fit.cy + fit.S * u.y, d: u.d };
}

/** A thing the fit keeps on the canvas: its unit-scale anchor (ux, uy) and the px box it carries about that anchor. */
export interface FitItem { ux: number; uy: number; x0: number; x1: number; y0: number; y1: number }

/**
 * The widest scale, at most cap, at which every item's box fits the canvas less margin px on each side, and the
 * origin that centres their extent there. On one axis two items i and j (j farther along) need
 * S (u_j - u_i) + hi_j - lo_i to be at most the room, so S is the least of those bounds over every such pair.
 */
export function fitFrame(items: FitItem[], W: number, H: number, margin: number, cap: number): Fit {
  type Pick = (t: FitItem) => number;
  const bound = (u: Pick, lo: Pick, hi: Pick, room: number) => {
    let S = cap;
    for (const i of items) for (const j of items) {
      const du = u(j) - u(i);
      if (du > 1e-12) S = Math.min(S, (room - hi(j) + lo(i)) / du);
    }
    return Math.max(0, S);
  };
  const roomX = W - 2 * margin;
  const roomY = H - 2 * margin;
  const ux: Pick = (t) => t.ux;
  const uy: Pick = (t) => t.uy;
  const x0: Pick = (t) => t.x0;
  const x1: Pick = (t) => t.x1;
  const y0: Pick = (t) => t.y0;
  const y1: Pick = (t) => t.y1;
  const S = Math.min(bound(ux, x0, x1, roomX), bound(uy, y0, y1, roomY));
  const mid = (u: Pick, lo: Pick, hi: Pick) => {
    let a = Infinity;
    let b = -Infinity;
    for (const t of items) {
      a = Math.min(a, S * u(t) + lo(t));
      b = Math.max(b, S * u(t) + hi(t));
    }
    return items.length === 0 ? 0 : (a + b) / 2;
  };
  return { S, cx: margin + roomX / 2 - mid(ux, x0, x1), cy: margin + roomY / 2 - mid(uy, y0, y1) };
}

/**
 * An axis reads while the view shows at least 0.3 of its length (projected over true length, both at one scale); an
 * axis seen edge-on (the expiries in Front, the strikes or tenors in Side, the vol axis from above, all near 0.1) would
 * pile its ticks on one spot, so it is not labelled.
 */
export function axisShown(projected: number, full: number): boolean {
  return full <= 0 || projected / full >= 0.3;
}

/** The share of its labels' room an axis keeps in the fit: all of it while shown, none at 0.2 of its length or less, linear between. */
export function axisWeight(projected: number, full: number): number {
  if (axisShown(projected, full)) return 1;
  return Math.max(0, Math.min(1, (projected / full - 0.2) / 0.1));
}

export interface Rect { x0: number; x1: number; y0: number; y1: number }

/** In order, each label is kept unless its box meets a box already kept or leaves the W by H canvas. */
export function keepLabels(rects: Rect[], W: number, H: number): boolean[] {
  const kept: Rect[] = [];
  return rects.map((r) => {
    const off = r.x0 < 0 || r.y0 < 0 || r.x1 > W || r.y1 > H;
    const hit = kept.some((k) => r.x0 < k.x1 && k.x0 < r.x1 && r.y0 < k.y1 && k.y0 < r.y1);
    if (off || hit) return false;
    kept.push(r);
    return true;
  });
}

/** Of values that are whole multiples of unit, those on the smallest step of 1, 2 or 5 (times a power of ten) units that leaves at most n. */
export function evenTicks(vals: number[], unit: number, n: number): number[] {
  const whole = vals.map((v) => ({ v, k: Math.round(v / unit) }));
  for (let mag = 1; mag < 1e12; mag *= 10) {
    for (const m of [1, 2, 5]) {
      const out = whole.filter((t) => t.k % (m * mag) === 0).map((t) => t.v);
      if (out.length <= n) return out;
    }
  }
  return [];
}

/** A strike that is a whole percent (a decimal rate, so 0.03 is 3%). */
const wholePct = (k: number) => Math.abs(k * 100 - Math.round(k * 100)) < 1e-9;

/**
 * The cap's strike ticks: the whole-percent strikes on an even step (at most n); when the grid stores none, or no even
 * step keeps one, n of the stored strikes spread evenly, so the surface and the smile always have x ticks (Polish 11).
 * whole says every tick is a whole percent, so it can print with no decimals.
 */
export function strikeTicks(cols: number[], n: number): { ticks: number[]; whole: boolean } {
  const even = evenTicks(cols.filter(wholePct), 0.01, n);
  const ticks = even.length > 0 ? even : pickTicks(cols, n);
  return { ticks, whole: ticks.every(wholePct) };
}

/** One axis tick to print: where on its axis (a unit-box coordinate), its text and its measured width in px. */
export interface AxisLabel { at: number; text: string; w: number }
export interface SurfaceLabelsIn {
  x: AxisLabel[];
  y: AxisLabel[];
  z: AxisLabel[];
  titles: { x: { text: string; w: number }; y: { text: string; w: number }; z: { text: string; w: number } };
}
/** A label placed on the canvas: its text drawn at x, y (the baseline), centred or right aligned; title marks the axis names. */
export interface PlacedLabel { text: string; x: number; y: number; w: number; align: "center" | "right"; title: boolean }
export interface SurfaceLayout { fit: Fit; farX: number; farY: number; labels: PlacedLabel[] }

/** An 11 px label's box about its baseline: 8 px above, 3 below; 1 px more each side keeps two labels 2 px apart. */
const ASCENT = 8;
const DESCENT = 3;
const LABEL_PAD = 1;
/** The canvas edge the box and its labels keep clear of. */
const MARGIN = 4;
/** How far the expiry ticks sit off the box, sideways, in px. */
const NUDGE = 6;
/** The px an axis name keeps clear of its widest tick. */
const NAME_GAP = 4;

/**
 * The frame and the labels of one view: the back walls (on each axis the wall farther from the eye), the tick labels
 * on the near edges (strikes or tenors 1.08 out and 12 px down, expiries 1.08 out, 10 px down and 6 px outward), the
 * vol axis on the leftmost vertical edge (8 px left) with "bp" over it, each floor axis's name beyond its tick row;
 * a fit that keeps the box and every label on the canvas; an axis seen edge-on drops its ticks and its name; then
 * each label is kept unless it meets one already kept (the vol ticks first, then strikes or tenors, expiries, the
 * names).
 */
export function layoutSurface(view: View, input: SurfaceLabelsIn, W: number, H: number): SurfaceLayout {
  const U = (X: number, Y: number, Z: number) => projectUnit(X, Y, Z, view);
  const farX = U(0.5, 0, Z_TOP / 2).d > U(-0.5, 0, Z_TOP / 2).d ? 0.5 : -0.5;
  const farY = U(0, 0.5, Z_TOP / 2).d > U(0, -0.5, Z_TOP / 2).d ? 0.5 : -0.5;
  const nearX = -farX;
  const nearY = -farY;
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([X, Y]) => ({ X: X!, Y: Y!, q: U(X!, Y!, 0) }));
  const left = corners.reduce((a, b) => (b.q.x < a.q.x ? b : a));
  // The expiry ticks move 6 px the way +nearX runs across the canvas: out from the box.
  const out = U(nearX, 0, 0).x - U(0, 0, 0).x;
  const nudge = Math.abs(out) < 1e-9 ? 0 : Math.sign(out) * NUDGE;
  // An axis name sits beyond the middle of its tick row. Every tick box of the axis is centred on one line across the
  // canvas (the edge's direction), so moving the name along that line's normal, away from the box, by the two boxes'
  // extents projected on the normal (tick half width plus name half width times |nx|, their heights times |ny|) plus
  // NAME_GAP clears every tick at any scale.
  const half = (ASCENT + DESCENT) / 2;
  const name = (edge: { x: number; y: number }, out: { x: number; y: number }, tick: { dx: number; dy: number }, ticks: AxisLabel[], w: number) => {
    const len = Math.hypot(edge.x, edge.y);
    let nx = len < 1e-9 ? 0 : -edge.y / len;
    let ny = len < 1e-9 ? 1 : edge.x / len;
    if (nx * out.x + ny * out.y < 0) { nx = -nx; ny = -ny; }
    const tw = Math.max(0, ...ticks.map((t) => t.w)) / 2;
    const D = (tw + w / 2) * Math.abs(nx) + 2 * half * Math.abs(ny) + NAME_GAP;
    return { dx: tick.dx + nx * D, dy: tick.dy + ny * D };
  };
  const dir = (a: Projected, b: Projected) => ({ x: b.x - a.x, y: b.y - a.y });
  const o = U(0, 0, 0);
  const xName = name(dir(o, U(1, 0, 0)), dir(o, U(0, nearY, 0)), { dx: 0, dy: 12 }, input.x, input.titles.x.w);
  const yName = name(dir(o, U(0, 1, 0)), dir(o, U(nearX, 0, 0)), { dx: nudge, dy: 10 }, input.y, input.titles.y.w);
  type Align = "center" | "right";
  interface Spec { axis: "x" | "y" | "z"; title: boolean; text: string; w: number; X: number; Y: number; Z: number; dx: number; dy: number; align: Align }
  const specs: Spec[] = [
    ...input.x.map((l): Spec => ({ axis: "x", title: false, text: l.text, w: l.w, X: l.at, Y: nearY * 1.08, Z: 0, dx: 0, dy: 12, align: "center" })),
    ...input.y.map((l): Spec => ({ axis: "y", title: false, text: l.text, w: l.w, X: nearX * 1.08, Y: l.at, Z: 0, dx: nudge, dy: 10, align: "center" })),
    ...input.z.map((l): Spec => ({ axis: "z", title: false, text: l.text, w: l.w, X: left.X, Y: left.Y, Z: l.at, dx: -8, dy: 4, align: "right" })),
    { axis: "z", title: true, ...input.titles.z, X: left.X, Y: left.Y, Z: Z_TOP, dx: -8, dy: -10, align: "right" },
    { axis: "x", title: true, ...input.titles.x, X: 0, Y: nearY * 1.08, Z: 0, ...xName, align: "center" },
    { axis: "y", title: true, ...input.titles.y, X: nearX * 1.08, Y: 0, Z: 0, ...yName, align: "center" },
  ];
  const boxOf = (s: Spec) => {
    const x0 = s.dx - (s.align === "center" ? s.w / 2 : s.w);
    return { x0, x1: x0 + s.w, y0: s.dy - ASCENT, y1: s.dy + DESCENT };
  };
  // Each label's box scaled by its axis's weight about its anchor; every anchor and box corner counts.
  type Weights = Record<"x" | "y" | "z", number>;
  const itemsAt = (k: Weights): FitItem[] => [
    ...corners.flatMap((c) => [0, Z_TOP].map((Z) => {
      const q = U(c.X, c.Y, Z);
      return { ux: q.x, uy: q.y, x0: 0, x1: 0, y0: 0, y1: 0 };
    })),
    ...specs.map((s) => {
      const q = U(s.X, s.Y, s.Z);
      const b = boxOf(s);
      const m = k[s.axis];
      return { ux: q.x, uy: q.y, x0: b.x0 * m, x1: b.x1 * m, y0: b.y0 * m, y1: b.y1 * m };
    }),
  ];
  // Each axis's projected length at unit scale against its true length: the floor edges are 1 long, the vol axis Z_TOP.
  const span = (a: Projected, b: Projected) => Math.hypot(b.x - a.x, b.y - a.y);
  const weight = {
    x: axisWeight(span(U(-0.5, 0, 0), U(0.5, 0, 0)), 1),
    y: axisWeight(span(U(0, -0.5, 0), U(0, 0.5, 0)), 1),
    z: axisWeight(span(U(0, 0, 0), U(0, 0, Z_TOP)), Z_TOP),
  };
  // An axis turning edge-on gives its labels' room back gradually, so the fit centres the labels shown and never
  // jumps as a drag or an ease turns the box.
  const fit = fitFrame(itemsAt(weight), W, H, MARGIN, scaleCap(W, H));
  const P = (X: number, Y: number, Z: number) => project(X, Y, Z, view, W, H, fit);
  const shown = { x: weight.x === 1, y: weight.y === 1, z: weight.z === 1 };
  // The vol ticks are placed first, so the floor tick wins against a floor-corner strike, tenor or expiry label, which
  // drops instead (Polish 11): a vol axis that starts above the box floor would misread.
  const order = (s: Spec) => (s.title ? 3 : s.axis === "z" ? 0 : s.axis === "x" ? 1 : 2);
  const placed = specs
    .filter((s) => shown[s.axis])
    .sort((a, b) => order(a) - order(b))
    .map((s) => {
      const q = P(s.X, s.Y, s.Z);
      const b = boxOf(s);
      const rect = { x0: q.x + b.x0 - LABEL_PAD, x1: q.x + b.x1 + LABEL_PAD, y0: q.y + b.y0 - LABEL_PAD, y1: q.y + b.y1 + LABEL_PAD };
      return { label: { text: s.text, x: q.x + s.dx, y: q.y + s.dy, w: s.w, align: s.align, title: s.title }, rect };
    });
  const keep = keepLabels(placed.map((p) => p.rect), W, H);
  return { fit, farX, farY, labels: placed.filter((_, k) => keep[k]).map((p) => p.label) };
}

/** The unit box of a grid: where a column, a row and a vol sit, and the vol axis ticks. */
export interface Frame { nx: (c: number) => number; ny: (r: number) => number; nz: (v: number) => number; zt: Ticks }

export function surfaceFrame(grid: VolGrid, xKind: "linear" | "sqrt"): Frame {
  const fx = xKind === "sqrt" ? Math.sqrt : (v: number) => v;
  const unit = (f: (v: number) => number, vals: number[]) => {
    const lo = f(vals[0] ?? 0);
    const span = f(vals[vals.length - 1] ?? 1) - lo;
    return (v: number) => (span === 0 ? 0 : (f(v) - lo) / span - 0.5);
  };
  const cells = grid.cells.flat().filter((v): v is number => v !== null);
  const zt = niceTicks(cells.length ? Math.min(...cells) : 0, cells.length ? Math.max(...cells) : 1, 5);
  return { nx: unit(fx, grid.cols), ny: unit(Math.sqrt, grid.rows), nz: (v) => ((v - zt.lo) / (zt.hi - zt.lo || 1)) * Z_TOP, zt };
}

/** Every stored quote as a vertex of the unit box; a missing quote is no vertex. */
export function vertices(grid: VolGrid, frame: Frame): Vertex[] {
  const out: Vertex[] = [];
  grid.rows.forEach((r, i) => grid.cols.forEach((c, j) => {
    const v = grid.cells[i]![j];
    if (v !== null && v !== undefined) out.push({ i, j, X: frame.nx(c), Y: frame.ny(r), Z: frame.nz(v), v });
  }));
  return out;
}

/**
 * The selection trace of one expiry row (by j) or one column (by i) as runs of stored quotes: a missing quote breaks
 * the run, so the trace never draws a straight line across a hole in the grid (Polish 11).
 */
export function traceRuns(verts: Vertex[], by: "row" | "col", at: number): Vertex[][] {
  const along = (q: Vertex) => (by === "row" ? q.j : q.i);
  const mine = verts.filter((q) => (by === "row" ? q.i : q.j) === at).sort((a, b) => along(a) - along(b));
  const out: Vertex[][] = [];
  for (const q of mine) {
    const run = out[out.length - 1];
    if (run !== undefined && along(q) === along(run[run.length - 1]!) + 1) run.push(q);
    else out.push([q]);
  }
  return out;
}

/** A drag on the surface: the last point the view turned to (the press point until it passes 3 px) and whether it has. */
export interface SurfaceDragState { x: number; y: number; moved: boolean }
export type SurfaceDragEvent =
  | { type: "down"; x: number; y: number; button: number }
  | { type: "move"; x: number; y: number }
  | { type: "up" }
  | { type: "cancel" };

/**
 * The surface's drag after a pointer event (Polish 11). Only the primary button starts one. The view turns only once
 * the pointer is more than 3 px (across plus down) from the press, by the whole offset then and move by move after, so
 * a click with a little jitter leaves the view still; a release that never turned pins; a cancel or a lost pointer
 * capture ends the drag with no pin.
 */
export function surfaceDrag(drag: SurfaceDragState | null, e: SurfaceDragEvent): { drag: SurfaceDragState | null; turn: { dx: number; dy: number } | null; pin: boolean } {
  if (e.type === "cancel") return { drag: null, turn: null, pin: false };
  if (e.type === "down") return e.button === 0 ? { drag: { x: e.x, y: e.y, moved: false }, turn: null, pin: false } : { drag, turn: null, pin: false };
  if (drag === null) return { drag: null, turn: null, pin: false };
  if (e.type === "up") return { drag: null, turn: null, pin: !drag.moved };
  const dx = e.x - drag.x;
  const dy = e.y - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= 3) return { drag, turn: null, pin: false };
  return { drag: { x: e.x, y: e.y, moved: true }, turn: { dx, dy }, pin: false };
}

/** The media query that stops matching when the device pixel ratio leaves dpr, so a move to another display redraws. */
export const resolutionQuery = (dpr: number) => `(resolution: ${dpr}dppx)`;

/** The light a face turns away, as an alpha of the shade token: 0 facing the light, up to 0.5 turned from it. */
export function shadeOf(a: Vertex, b: Vertex, c: Vertex, d: Vertex): number {
  const u = [c.X - a.X, c.Y - a.Y, c.Z - a.Z];
  const w = [d.X - b.X, d.Y - b.Y, d.Z - b.Z];
  let n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
  if (n[2]! < 0) n = n.map((k) => -k);
  const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
  const lam = Math.max(0, (n[0]! * LIGHT[0] + n[1]! * LIGHT[1] + n[2]! * LIGHT[2]) / len);
  return Math.max(0, Math.min(0.5, (1 - lam) * 0.5));
}

/** The faces that join four stored quotes, projected, far to near (painter's order by mean depth). */
export function faces(grid: VolGrid, frame: Frame, view: View, W: number, H: number, fit: Fit = baseFit(W, H)): Face[] {
  const at = new Map<string, Vertex>(vertices(grid, frame).map((q) => [`${q.i}:${q.j}`, q]));
  const out: Face[] = [];
  for (let i = 0; i + 1 < grid.rows.length; i++) {
    for (let j = 0; j + 1 < grid.cols.length; j++) {
      const a = at.get(`${i}:${j}`);
      const b = at.get(`${i}:${j + 1}`);
      const c = at.get(`${i + 1}:${j + 1}`);
      const d = at.get(`${i + 1}:${j}`);
      if (!a || !b || !c || !d) continue;
      const pts = [a, b, c, d].map((q) => project(q.X, q.Y, q.Z, view, W, H, fit));
      out.push({
        corners: [a, b, c, d],
        pts,
        depth: pts.reduce((s, p) => s + p.d, 0) / 4,
        step: seqStep((a.v + b.v + c.v + d.v) / 4, grid.min, grid.max, 7),
        shade: shadeOf(a, b, c, d),
      });
    }
  }
  return out.sort((p, q) => q.depth - p.depth);
}

/**
 * The stored quote the pointer is on: the nearest projected vertex within radius px; of two close hits (within 30 px
 * squared of the nearest) the one nearer the eye, so a quote behind the surface loses to the one in front of it.
 */
export function hitTest(points: Array<Projected & { i: number; j: number }>, mx: number, my: number, radius = 16): { i: number; j: number } | null {
  const near = points.map((p) => ({ p, d2: (p.x - mx) ** 2 + (p.y - my) ** 2 })).filter((h) => h.d2 <= radius * radius);
  if (near.length === 0) return null;
  const best = near.reduce((a, b) => (b.d2 < a.d2 ? b : a));
  const front = near.filter((h) => h.d2 <= best.d2 + 30).reduce((a, b) => (b.p.d < a.p.d ? b : a));
  return { i: front.p.i, j: front.p.j };
}

/** k of the way (0 to 1) from one view to another on a cubic ease-out. */
export function easeView(from: View, to: View, k: number): View {
  const t = Math.max(0, Math.min(1, k));
  const s = 1 - Math.pow(1 - t, 3);
  return { az: from.az + (to.az - from.az) * s, el: from.el + (to.el - from.el) * s };
}

/** At most n values spread evenly over vals, the first and last kept. */
export function pickTicks(vals: number[], n: number): number[] {
  if (vals.length <= n) return vals;
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(vals[Math.round((k * (vals.length - 1)) / (n - 1))]!);
  return Array.from(new Set(out));
}
