/**
 * The interactive line chart (Polish 10 T1). An SVG drawn at its real pixel width, measured on its wrapper after layout and on every resize; a server
 * render draws at FALLBACK_WIDTH, so the tests see the whole markup. Y tick numbers and grid lines on a nice range,
 * x on a linear or a square-root axis (tenors to scale), 2 px lines, hollow markers on stored points. Hover snaps to
 * the nearest stored x: a crosshair, a dot on each visible series and one tooltip listing every visible series' value
 * there, high to low; the arrow keys step it while the chart has focus. The legend chips hide and show a series (the
 * y range refits) and lift one on hover. With zoom a drag zooms x; Reset zoom and a double-click zoom back out. With
 * delta the tooltip and the table add each series' gap to that base series in bp. Every plotted value is a stored
 * one; the Show table prints them all. Colours are tokens only; the numbers live in plotScale.ts.
 */
import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useLayoutBeforePaint } from "../layout/wholeRows";
import {
  deltaBp, GLYPH_PX, nearestX, pathD, segments, signedBp, steadyLeftMargin, storedXs, thinTicks, tipPlace, tipRows, tipTop, toggleHidden, xClipPad, xScale, yDomain,
  zoomBand,
  zoomDrag, zoomTo, type Point, type XScaleKind, type XTick, type ZoomEvent,
} from "./plotScale";

/** accent to sixth are --series-1 to --series-6 (categorical identities, in order); muted is the grey context line; ink is a slice's selected row. */
export type PlotTone = "accent" | "second" | "third" | "fourth" | "fifth" | "sixth" | "muted" | "ink";
export interface PlotSeries { id: string; label: string; tone: PlotTone; dash?: boolean; points: Point[] }
/** A thin muted line with no legend chip and no tooltip row: the rest of a surface behind a slice. */
export interface PlotContext { id: string; points: Point[] }

const STROKE: Record<PlotTone, string> = {
  accent: "var(--series-1)", second: "var(--series-2)", third: "var(--series-3)", fourth: "var(--series-4)",
  fifth: "var(--series-5)", sixth: "var(--series-6)", muted: "var(--muted)", ink: "var(--ink)",
};
const keyBackground = (s: PlotSeries) => (s.dash === true ? `repeating-linear-gradient(90deg, ${STROKE[s.tone]} 0 4px, transparent 4px 7px)` : STROKE[s.tone]);

/** The width a server render draws at, before the wrapper is measured. */
export const FALLBACK_WIDTH = 640;
const M = { l: 50, r: 16, t: 10, b: 28 };
/** How far the line clip reaches beyond the plot area, in px: always in y (Polish 11 fix round 1), in x only when all drawn lies inside the window (Polish 14). */
const CLIP_PAD = 6;

export interface LinePlotProps {
  series: PlotSeries[];
  context?: PlotContext[];
  xScale: XScaleKind;
  /** The x range before any zoom; the stored x extent when absent. */
  xDomain?: [number, number];
  /** Tick values and labels, or a function of the shown x range; a tick whose label box would meet the one before drops. */
  xTicks: XTick[] | ((lo: number, hi: number) => XTick[]);
  /** A stored x as the tooltip head and the table's Point cell. */
  xLabel: (x: number) => string;
  yTick: (v: number, step: number) => string;
  /** A stored value as the tooltip and the table print it. */
  format: (v: number) => string;
  unit: string;
  height?: number;
  /** Hollow point markers; by default on a series of 40 points or fewer. */
  markers?: boolean;
  /** A soft gradient under a single solid visible series. */
  area?: boolean;
  zoom?: boolean;
  /** A series id: the tooltip and the table add each other series' gap to it, in bp (percent-unit values). */
  delta?: string;
  /** A series id with the delta series' own points (a base scenario beside the base curve): the tooltip leaves its row
   *  out where the delta series shows the same value, so the base prints once. The legend, dots and table keep it. */
  deltaTwin?: string;
  /** The y range always holds 0 (Polish 13): an all-positive set floors at 0, however far above it the values sit. */
  yZero?: boolean;
  /** On by default for two or more series. */
  legend?: boolean;
  table?: boolean;
}

/** A series' gap to the base as the tooltip and the table print it: base on the base itself, whole signed bp else. */
function gapText(id: string, v: number, delta: string | undefined, baseValue: number | null): string {
  if (id === delta) return "base";
  return baseValue === null ? "Unobservable" : signedBp(deltaBp(v, baseValue));
}

/** Every stored value, and with delta each other series' gap to the base in bp. Memoized, so a hover does not redraw it. */
const PlotTable = memo(function PlotTable(props: { series: PlotSeries[]; delta?: string; format: (v: number) => string; xLabel: (x: number) => string }) {
  const { series } = props;
  const byX = new Map(series.map((s) => [s.id, new Map(s.points)]));
  const at = (id: string, x: number) => byX.get(id)?.get(x) ?? null;
  const base = series.find((s) => s.id === props.delta);
  const others = base === undefined ? [] : series.filter((s) => s.id !== base.id);
  return (
    <details className="viz-table">
      <summary>Show table</summary>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Point</th>
              {series.map((s) => <th scope="col" key={s.id} className="num">{s.label}</th>)}
              {others.map((s) => <th scope="col" key={`d${s.id}`} className="num">{s.label} vs base, bp</th>)}
            </tr>
          </thead>
          <tbody>
            {storedXs(series, -Infinity, Infinity).map((x) => (
              <tr key={x}>
                <th scope="row">{props.xLabel(x)}</th>
                {series.map((s) => { const v = at(s.id, x); return <td key={s.id} className="num lvl">{v === null ? "Unobservable" : props.format(v)}</td>; })}
                {others.map((s) => {
                  const v = at(s.id, x);
                  return <td key={`d${s.id}`} className="num lvl">{v === null ? "Unobservable" : gapText(s.id, v, props.delta, base === undefined ? null : at(base.id, x))}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
});

export function LinePlot(props: LinePlotProps) {
  const { series, unit } = props;
  const context = props.context ?? [];
  const H = props.height ?? 300;
  const uid = useId().replace(/:/g, "");
  const wrap = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(FALLBACK_WIDTH);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [lift, setLift] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<[number, number] | null>(null);
  const [hov, setHov] = useState<{ x: number; py: number | null } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  useLayoutBeforePaint(() => {
    const el = wrap.current;
    if (el === null) return;
    const measure = () => setW((w) => (el.clientWidth > 0 && Math.round(el.clientWidth) !== w ? Math.round(el.clientWidth) : w));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const visible = series.filter((s) => !hidden.has(s.id));
  const all = useMemo(() => storedXs(series, -Infinity, Infinity), [series]);
  const [u0, u1] = props.xDomain ?? [all[0] ?? 0, all[all.length - 1] ?? 1];
  const [x0, x1] = zoomed ?? [u0, u1];
  const ph = Math.max(1, H - M.t - M.b);
  const inX = (x: number) => x >= x0 - 1e-9 && x <= x1 + 1e-9;
  const valuesIn = (drawn: Array<{ points: Point[] }>, lo: number, hi: number) =>
    drawn.flatMap((s) => s.points.filter((p): p is [number, number] => p[1] !== null && p[0] >= lo - 1e-9 && p[0] <= hi + 1e-9).map((p) => p[1]));
  const yd = yDomain(valuesIn([...visible, ...context], x0, x1), ph, props.yZero === true);
  // The y labels first, then the left margin that fits the widest of them (50 px for short ones), then x from it. The
  // margin also fits the labels of the full unzoomed range over every series, hidden ones included (Polish 14), so a
  // hide or a zoom cannot narrow it and slide the plot sideways. Those full-range labels read only the series, the
  // context, the unzoomed range, the height, yZero and the formatter, so they are memoized on exactly those and a hover
  // render reuses them (Polish 15 item 2). The key holds props.context, not context, whose fallback [] is new each render.
  const yLabels = yd.ticks.map((v) => props.yTick(v, yd.step));
  const fullLabels = useMemo(() => {
    const full = yDomain(valuesIn([...series, ...context], u0, u1), ph, props.yZero === true);
    return full.ticks.map((v) => props.yTick(v, full.step));
  }, [series, props.context, u0, u1, ph, props.yZero, props.yTick]);
  const ml = steadyLeftMargin(yLabels, fullLabels, GLYPH_PX, 8, M.l);
  const pw = Math.max(1, W - ml - M.r);
  const sx = xScale(props.xScale, x0, x1, ml, ml + pw);
  const xPad = xClipPad([...visible, ...context], x0, x1, CLIP_PAD);
  const py = (v: number) => M.t + ((yd.hi - v) / (yd.hi - yd.lo || 1)) * ph;
  const tickList = typeof props.xTicks === "function" ? props.xTicks(x0, x1) : props.xTicks;
  const xt = thinTicks(tickList.filter((t) => inX(t.value)), sx.toPx);
  const xs = storedXs(visible, x0, x1);
  const byX = useMemo(() => new Map(series.map((s) => [s.id, new Map(s.points)])), [series]);
  const valueAt = (s: PlotSeries, x: number) => byX.get(s.id)?.get(x) ?? null;
  const base = props.delta === undefined ? undefined : series.find((s) => s.id === props.delta);
  const markersOn = (s: PlotSeries) => props.markers ?? s.points.length <= 40;
  const dim = (id: string) => (lift !== null && lift !== id ? 0.18 : undefined);
  const areaSeries = props.area === true && visible.length === 1 && visible[0]!.dash !== true ? visible[0]! : null;
  const showLegend = props.legend ?? series.length >= 2;

  // The tooltip's place, after it is drawn: right of the crosshair, left of it at the right edge, and never over it.
  // Measured at its natural width first; when neither side holds that, it is capped to the larger side and its rows
  // wrap, then placed by the width it takes there (Polish 11, F11).
  useLayoutBeforePaint(() => {
    const tip = tipRef.current;
    if (tip === null || hov === null) return;
    const at = sx.toPx(hov.x);
    tip.style.maxWidth = "";
    tip.style.minWidth = "";
    tip.style.left = "0px";
    const cap = tipPlace(at, tip.offsetWidth, W).maxWidth;
    // A cap under the tooltip's 150 px minimum must still hold, so the minimum yields to it.
    tip.style.maxWidth = cap === null ? "" : `${cap}px`;
    tip.style.minWidth = cap === null ? "" : "0px";
    tip.style.left = `${tipPlace(at, tip.offsetWidth, W).left}px`;
    tip.style.top = `${tipTop(hov.py, tip.offsetHeight, H, M.t + 6)}px`;
  });
  // A hidden series or a zoom can leave the crosshair on an x no visible series stores.
  useEffect(() => {
    if (hov !== null && !xs.includes(hov.x)) setHov(null);
  });

  const loc = (e: PointerEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) * (W / (r.width || W)), (e.clientY - r.top) * (H / (r.height || H))];
  };
  // The drag zoom's state runs through zoomDrag: a release zooms to the band, a cancel or a lost capture clears it.
  const step = (e: ZoomEvent) => {
    const r = zoomDrag(drag, e);
    setDrag(r.drag);
    const z = r.release === null ? null : zoomTo(r.release[0], r.release[1], sx, ml, ml + pw);
    if (z !== null) setZoomed(z);
    return r;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const [px, pyy] = loc(e);
    if (drag !== null) step({ type: "move", px });
    if (px < ml - 10 || px > W - M.r + 10) return setHov(null);
    const x = nearestX(xs, sx.toPx, px);
    setHov(x === null ? null : { x, py: pyy });
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (props.zoom !== true) return;
    const [px] = loc(e);
    // Only a primary-button press starts a drag (zoomDrag), and only a started drag captures the pointer.
    if (step({ type: "down", px, button: e.button }).drag === drag) return;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    if (drag === null) return;
    const [px] = loc(e);
    step({ type: "up", px });
  };
  const onCancel = () => {
    if (drag !== null) step({ type: "cancel" });
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    if (xs.length === 0) return;
    const at = hov === null ? -1 : xs.indexOf(hov.x);
    const i = hov === null ? 0 : Math.max(0, Math.min(xs.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)));
    setHov({ x: xs[i]!, py: null });
  };
  const toggle = (id: string) => {
    const next = toggleHidden(hidden, series.map((s) => s.id), id);
    setHidden(next);
    if (next.has(id) && lift === id) setLift(null);
  };

  const rows = hov === null ? [] : tipRows(visible, (s) => valueAt(s, hov.x));
  // The dots keep every row; the tooltip names the base once, leaving out its twin where the two agree (Polish 15 item 4),
  // unless the twin is the lifted series, whose row then stays in the ink.
  const twin = lift !== null && lift === props.deltaTwin ? undefined : props.deltaTwin;
  const tipList = hov === null ? [] : tipRows(visible, (s) => valueAt(s, hov.x), props.delta, twin);
  const gap = (s: PlotSeries, v: number, x: number) => gapText(s.id, v, props.delta, base === undefined ? null : valueAt(base, x));
  const bottom = M.t + ph;
  const band = drag === null ? null : zoomBand(drag.from, drag.to, ml, ml + pw);

  return (
    <div className="lp">
      {showLegend ? (
        <div className="lp-legend" role="group" aria-label="Series">
          {series.map((s) => (
            <button
              key={s.id}
              type="button"
              className="lp-chip"
              aria-pressed={!hidden.has(s.id)}
              onClick={() => toggle(s.id)}
              onMouseEnter={() => setLift(hidden.has(s.id) ? null : s.id)}
              onMouseLeave={() => setLift(null)}
            >
              <i className="key-line" style={{ background: keyBackground(s) }} />{s.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="lp-unit">
        <span>{unit}</span>
        {props.zoom === true ? (zoomed === null ? <span>Drag to zoom</span> : <button type="button" className="lp-reset" onClick={() => setZoomed(null)}>Reset zoom</button>) : null}
      </div>
      <div className="lp-plot" ref={wrap}>
        <svg
          tabIndex={0}
          width="100%"
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${series.map((s) => s.label).join(", ")}, ${unit}`}
          onPointerMove={onMove}
          onPointerLeave={() => { if (drag === null) setHov(null); }}
          onPointerDown={onDown}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
          onLostPointerCapture={onCancel}
          onDoubleClick={() => setZoomed(null)}
          onKeyDown={onKey}
          onBlur={() => setHov(null)}
        >
          <defs>
            {/* 6 px beyond the plot, so a marker with its stroke on the top or bottom gridline, or on the first or last x,
                draws whole. x stays tight when a line runs on past the window (a zoom, or a context line past a
                slice's null end cell): there it must stop at the edge. */}
            <clipPath id={`${uid}-clip`}><rect x={ml - xPad} y={M.t - CLIP_PAD} width={pw + 2 * xPad} height={ph + 2 * CLIP_PAD} /></clipPath>
            {areaSeries === null ? null : (
              <linearGradient id={`${uid}-area`} x1={0} x2={0} y1={0} y2={1}>
                <stop offset={0} style={{ stopColor: STROKE[areaSeries.tone], stopOpacity: 0.16 }} />
                <stop offset={1} style={{ stopColor: STROKE[areaSeries.tone], stopOpacity: 0 }} />
              </linearGradient>
            )}
          </defs>
          {yd.ticks.map((v, i) => (
            <g key={`y${v}`}>
              <line className="lp-grid" x1={ml} x2={ml + pw} y1={py(v)} y2={py(v)} />
              <text className="lp-ax" x={ml - 8} y={py(v) + 3.5} textAnchor="end">{yLabels[i]}</text>
            </g>
          ))}
          {yd.lo < 0 && yd.hi > 0 ? <line className="lp-zero" x1={ml} x2={ml + pw} y1={py(0)} y2={py(0)} /> : null}
          {xt.map((t) => (
            <g key={`x${t.value}`}>
              <line className="lp-grid lp-grid-x" x1={sx.toPx(t.value)} x2={sx.toPx(t.value)} y1={M.t} y2={bottom} />
              <text className="lp-ax" x={sx.toPx(t.value)} y={H - 8} textAnchor="middle">{t.label}</text>
            </g>
          ))}
          <g clipPath={`url(#${uid}-clip)`}>
            {context.map((c) => <path key={c.id} className="lp-ctx" d={pathD(c.points, sx.toPx, py)} />)}
            {areaSeries === null ? null : segments(areaSeries.points).filter((run) => run.length >= 2).map((run) => {
              // One fill per run between nulls, so the area breaks where the line does.
              const d = `${pathD(run, sx.toPx, py)}L${sx.toPx(run[run.length - 1]![0]).toFixed(2)},${bottom}L${sx.toPx(run[0]![0]).toFixed(2)},${bottom}Z`;
              return <path key={`area${run[0]![0]}`} className="lp-area" d={d} fill={`url(#${uid}-area)`} opacity={dim(areaSeries.id)} />;
            })}
            {visible.map((s) => (
              <path key={s.id} className="lp-line" d={pathD(s.points, sx.toPx, py)} stroke={STROKE[s.tone]} strokeDasharray={s.dash === true ? "6 4" : undefined} opacity={dim(s.id)} />
            ))}
            {visible.filter(markersOn).map((s) => s.points.filter((p): p is [number, number] => p[1] !== null && inX(p[0])).map((p) => (
              <circle key={`${s.id}:${p[0]}`} className="lp-mark" cx={sx.toPx(p[0])} cy={py(p[1])} r={2.6} stroke={STROKE[s.tone]} opacity={dim(s.id)} />
            )))}
          </g>
          {hov === null ? null : (
            <g className="lp-hover">
              <line className="lp-xh" x1={sx.toPx(hov.x)} x2={sx.toPx(hov.x)} y1={M.t} y2={bottom} />
              {rows.filter((r) => lift === null || lift === r.s.id).map((r) => (
                <circle key={r.s.id} className="lp-dot" cx={sx.toPx(hov.x)} cy={py(r.v)} r={4.5} fill={STROKE[r.s.tone]} />
              ))}
            </g>
          )}
          {band === null ? null : <rect className="lp-band" x={band[0]} y={M.t} width={band[1] - band[0]} height={ph} />}
        </svg>
        {hov === null ? null : (
          <div className="lp-tip" ref={tipRef} aria-hidden="true">
            <div className="lp-tip-head">{props.xLabel(hov.x)}</div>
            <table>
              {base === undefined ? null : <thead><tr><th scope="col" /><th scope="col" /><th scope="col" className="lp-d">vs base, bp</th></tr></thead>}
              <tbody>
                {tipList.map((r) => (
                  <tr key={r.s.id} className={lift !== null && lift !== r.s.id ? "lp-dim" : undefined}>
                    <td><i className="key-line" style={{ background: keyBackground(r.s) }} />{r.s.label}</td>
                    <td className="lp-v">{props.format(r.v)}</td>
                    {base === undefined ? null : <td className="lp-d">{gap(r.s, r.v, hov.x)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {props.table === false ? null : <PlotTable series={series} delta={props.delta} format={props.format} xLabel={props.xLabel} />}
    </div>
  );
}
