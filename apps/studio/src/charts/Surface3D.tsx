/**
 * The vol surface in 3D (Polish 10 T3):
 * a canvas 2D drawing, device-pixel-ratio aware, 440 px tall, of the grid's stored quotes (geometry in
 * surfaceProjection.ts). Two back walls and the floor in the second surface with grid lines at the tick values, the
 * faces far to near in their --seq-N step shaded through --shade and edged in the surface ink, the selected expiry's
 * row in the ink and the selected column in the second series colour, with a dot and a dashed drop line. Tick labels
 * on the near edges and the vol axis on the leftmost vertical edge. Colours are the computed tokens, read at every
 * draw; a theme change (data-theme on the root, or the system scheme) redraws. Drag turns it; four buttons ease to
 * preset views (instant under reduced motion). Hover reads the nearest stored quote; a click without a drag pins it,
 * a click on the pinned quote unpins it, and while pinned a hover moves nothing. The grid and the slice tables are
 * the accessible form of every value; the canvas carries a label naming the surface and its quote count.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { VolGrid } from "@alm/reader";
import { useLayoutBeforePaint } from "../layout/wholeRows";
import { tipLeft, tipTop } from "./plotScale";
import {
  clampEl, easeView, faces, hitTest, layoutSurface, pickTicks, project, resolutionQuery, surfaceDrag, surfaceFrame, traceRuns, vertices,
  VIEWS, Z_TOP, type Projected, type SurfaceDragEvent, type SurfaceDragState, type View,
} from "./surfaceProjection";

const H = 440;
const VIEW_BUTTONS = [["iso", "3D"], ["front", "Front"], ["side", "Side"], ["top", "Top"]] as const;
type ViewName = (typeof VIEW_BUTTONS)[number][0];
const STEPS = [1, 2, 3, 4, 5, 6, 7] as const;

export interface Surface3DProps {
  grid: VolGrid;
  /** Strike columns sit linearly; swap tenor columns on a square-root axis. */
  xKind: "linear" | "sqrt";
  xName: string;
  /** The column ticks drawn on the floor and labelled on the near edge. */
  colTicks: number[];
  colAxis: (c: number) => string;
  colFormat: (c: number) => string;
  colNoun: string;
  rowFormat: (r: number) => string;
  sel: { i: number; j: number };
  pinned: boolean;
  onHover: (i: number, j: number) => void;
  onPin: (i: number, j: number) => void;
  label: string;
}

export function Surface3D(props: Surface3DProps) {
  const { grid } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>(VIEWS.iso);
  const width = useRef(640);
  const drag = useRef<SurfaceDragState | null>(null);
  const anim = useRef(0);
  const projected = useRef<Array<Projected & { i: number; j: number }>>([]);
  const [preset, setPreset] = useState<ViewName | null>("iso");
  const [tip, setTip] = useState<{ i: number; j: number; mx: number; my: number } | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const draw = () => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const p = latest.current;
    const g = p.grid;
    const css = getComputedStyle(cv);
    const tok = (name: string) => css.getPropertyValue(name).trim();
    const C = {
      line2: tok("--line-2"), muted: tok("--muted"), ink: tok("--ink"), ink2: tok("--ink-2"), surface: tok("--surface"),
      surface2: tok("--surface-2"), series2: tok("--series-2"), shade: tok("--shade"), font: tok("--font"), fontNum: tok("--font-num"),
    };
    const seq = STEPS.map((k) => tok(`--seq-${k}`));
    const W = width.current;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const v = view.current;
    const frame = surfaceFrame(g, p.xKind);
    const xTicks = pickTicks(p.colTicks, 6);
    const yTicks = pickTicks(g.rows, 6);
    // The labels, measured in their faces; the layout fits the box and every label to the canvas, drops an edge-on
    // axis's labels and any label that would meet one already placed.
    const tickFont = `11px ${C.fontNum}`;
    const nameFont = `600 11px ${C.font}`;
    const measure = (font: string) => (text: string, at: number) => { ctx.font = font; return { at, text, w: ctx.measureText(text).width }; };
    const tick = measure(tickFont);
    const name = (text: string) => measure(nameFont)(text, 0);
    const layout = layoutSurface(v, {
      x: xTicks.map((c) => tick(p.colAxis(c), frame.nx(c))),
      y: yTicks.map((r) => tick(p.rowFormat(r), frame.ny(r))),
      z: frame.zt.ticks.map((z) => tick(`${Number(z.toFixed(1))}`, frame.nz(z))),
      titles: { x: name(p.xName), y: name("Expiry"), z: name("bp") },
    }, W, H);
    const P = (X: number, Y: number, Z: number) => project(X, Y, Z, v, W, H, layout.fit);
    const poly = (pts: Projected[], fill: string | null, stroke: string | null, lw = 1) => {
      ctx.beginPath();
      pts.forEach((q, k) => (k === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      ctx.closePath();
      if (fill !== null) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke !== null) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
    };
    const line = (a: Projected, b: Projected, ink: string, lw = 1, dash: number[] = []) => {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    };
    // The back walls: on each axis the wall farther from the eye.
    const { farX, farY } = layout;
    ctx.globalAlpha = 0.55;
    poly([P(farX, -0.5, 0), P(farX, 0.5, 0), P(farX, 0.5, Z_TOP), P(farX, -0.5, Z_TOP)], C.surface2, null);
    poly([P(-0.5, farY, 0), P(0.5, farY, 0), P(0.5, farY, Z_TOP), P(-0.5, farY, Z_TOP)], C.surface2, null);
    poly([P(-0.5, -0.5, 0), P(0.5, -0.5, 0), P(0.5, 0.5, 0), P(-0.5, 0.5, 0)], C.surface2, null);
    ctx.globalAlpha = 1;
    for (const c of xTicks) { const X = frame.nx(c); line(P(X, -0.5, 0), P(X, 0.5, 0), C.line2, 0.6); line(P(X, farY, 0), P(X, farY, Z_TOP), C.line2, 0.6); }
    for (const r of yTicks) { const Y = frame.ny(r); line(P(-0.5, Y, 0), P(0.5, Y, 0), C.line2, 0.6); line(P(farX, Y, 0), P(farX, Y, Z_TOP), C.line2, 0.6); }
    for (const z of frame.zt.ticks) { const Z = frame.nz(z); line(P(farX, -0.5, Z), P(farX, 0.5, Z), C.line2, 0.6); line(P(-0.5, farY, Z), P(0.5, farY, Z), C.line2, 0.6); }
    // The faces, far to near: the step fill, the shade over it, a thin edge in the surface ink.
    for (const f of faces(g, frame, v, W, H, layout.fit)) {
      poly(f.pts, seq[f.step - 1]!, null);
      ctx.globalAlpha = f.shade; poly(f.pts, C.shade, null);
      ctx.globalAlpha = 0.35; poly(f.pts, null, C.surface, 0.6);
      ctx.globalAlpha = 1;
    }
    const verts = vertices(g, frame);
    projected.current = verts.map((q) => ({ i: q.i, j: q.j, ...P(q.X, q.Y, q.Z) }));
    // The selection: the expiry's row in the ink, the column in the second series colour, a dot and a drop line.
    // Each trace runs over stored quotes only and breaks at a missing one (traceRuns), as the slice lines do.
    const lift = (pts: typeof verts) => pts.map((q) => P(q.X, q.Y, q.Z + 0.002));
    const trace = (pts: Projected[], ink: string, lw: number) => {
      if (pts.length < 2) return;
      ctx.beginPath(); pts.forEach((q, k) => (k === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.stroke();
    };
    for (const run of traceRuns(verts, "row", p.sel.i).map(lift)) { trace(run, C.surface, 5); trace(run, C.ink, 2.2); }
    for (const run of traceRuns(verts, "col", p.sel.j).map(lift)) { trace(run, C.surface, 5); trace(run, C.series2, 2.2); }
    const at = verts.find((q) => q.i === p.sel.i && q.j === p.sel.j);
    if (at !== undefined) {
      const top = P(at.X, at.Y, at.Z + 0.002);
      const foot = P(at.X, at.Y, 0);
      // The drop line over a surface-coloured under-stroke, as the traces are, so it reads over the darkest faces.
      line(foot, top, C.surface, 3);
      line(foot, top, C.ink2, 1, [3, 3]);
      ctx.beginPath(); ctx.arc(top.x, top.y, 5.5, 0, 2 * Math.PI);
      ctx.fillStyle = C.ink; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = C.surface; ctx.stroke();
    }
    // Tick labels on the near edges and the vol axis on the leftmost vertical edge, muted; the axis names in ink.
    for (const l of layout.labels) {
      ctx.font = l.title ? nameFont : tickFont;
      ctx.fillStyle = l.title ? C.ink2 : C.muted;
      ctx.textAlign = l.align;
      ctx.fillText(l.text, l.x, l.y);
    }
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Width on mount and on every resize; a theme change redraws with the new tokens; so does a change of the device
  // pixel ratio alone (a move to another display), watched through a resolution query renewed at each new ratio.
  useLayoutBeforePaint(() => {
    const cv = canvas.current;
    if (cv === null) return;
    const measure = () => { width.current = cv.clientWidth || 640; drawRef.current(); };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(cv);
    const theme = new MutationObserver(() => drawRef.current());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => drawRef.current();
    scheme.addEventListener("change", onScheme);
    let dpr: MediaQueryList | null = null;
    const onDpr = () => { watchDpr(); drawRef.current(); };
    const watchDpr = () => {
      dpr?.removeEventListener("change", onDpr);
      dpr = window.matchMedia(resolutionQuery(window.devicePixelRatio || 1));
      dpr.addEventListener("change", onDpr);
    };
    watchDpr();
    return () => {
      watch.disconnect(); theme.disconnect(); scheme.removeEventListener("change", onScheme);
      dpr?.removeEventListener("change", onDpr); cancelAnimationFrame(anim.current);
    };
  }, []);
  // A new selection, pin or grid redraws.
  useEffect(() => { drawRef.current(); }, [grid, props.sel.i, props.sel.j, props.pinned]);
  useLayoutBeforePaint(() => {
    const el = tipRef.current;
    if (el === null || tip === null) return;
    el.style.left = `${tipLeft(tip.mx, el.offsetWidth, width.current)}px`;
    el.style.top = `${tipTop(tip.my, el.offsetHeight, H, 0)}px`;
  });

  const goTo = (name: ViewName) => {
    setPreset(name);
    cancelAnimationFrame(anim.current);
    const from = view.current;
    const to = VIEWS[name];
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = reduce ? 1 : (t - t0) / 500;
      view.current = easeView(from, to, k);
      drawRef.current();
      if (k < 1) anim.current = requestAnimationFrame(tick);
    };
    anim.current = requestAnimationFrame(tick);
  };
  const loc = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // The drag runs through surfaceDrag: the primary button only, no turn inside 3 px, a pin on a release that never
  // turned, and a cancel or a lost capture that ends it with no pin.
  const step = (e: SurfaceDragEvent) => {
    const r = surfaceDrag(drag.current, e);
    drag.current = r.drag;
    return r;
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const was = drag.current;
    if (step({ type: "down", ...loc(e), button: e.button }).drag === was) return;
    cancelAnimationFrame(anim.current);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onCancel = () => { step({ type: "cancel" }); };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const at = loc(e);
    if (drag.current !== null) {
      const { turn } = step({ type: "move", ...at });
      setTip(null);
      if (turn === null) return;
      view.current = { az: view.current.az - turn.dx * 0.008, el: clampEl(view.current.el + turn.dy * 0.006) };
      setPreset(null);
      drawRef.current();
      return;
    }
    if (props.pinned) return setTip(null);
    const h = hitTest(projected.current, at.x, at.y);
    if (h === null) return setTip(null);
    props.onHover(h.i, h.j);
    setTip({ ...h, mx: at.x, my: at.y });
  };
  const onUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!step({ type: "up" }).pin) return;
    const at = loc(e);
    const h = hitTest(projected.current, at.x, at.y);
    if (h !== null) props.onPin(h.i, h.j);
  };

  const tipValue = tip === null ? null : grid.cells[tip.i]?.[tip.j] ?? null;
  const atm = tip === null || grid.atm === null ? null : grid.atm[tip.i] ?? null;
  return (
    <div className="s3">
      <div className="seg s3-views" role="group" aria-label="View">
        {VIEW_BUTTONS.map(([name, text]) => (
          <button key={name} type="button" aria-pressed={preset === name} onClick={() => goTo(name)}>{text}</button>
        ))}
      </div>
      <div className="s3-plot">
        <canvas
          ref={canvas}
          className="s3-canvas"
          height={H}
          role="img"
          aria-label={props.label}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
          onLostPointerCapture={onCancel}
          onPointerLeave={() => setTip(null)}
        />
        {tip === null || tipValue === null ? null : (
          <div className="lp-tip" ref={tipRef} aria-hidden="true">
            <div className="lp-tip-head">{props.rowFormat(grid.rows[tip.i]!)} expiry, {props.colFormat(grid.cols[tip.j]!)} {props.colNoun}</div>
            <table>
              <tbody>
                <tr><td>Normal vol</td><td className="lp-v">{tipValue.toFixed(1)} bp</td></tr>
                {atm === null ? null : <tr><td>ATM at this expiry</td><td className="lp-v">{atm.toFixed(1)} bp</td></tr>}
              </tbody>
            </table>
            <div className="s3-hint">Click to pin. Drag to turn.</div>
          </div>
        )}
      </div>
    </div>
  );
}
