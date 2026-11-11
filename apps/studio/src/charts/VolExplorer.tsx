/**
 * The vol surface explorer (Polish 10 T4): per surface, the 3D surface and two slice charts side by side (stacked below about 820 px of card width), the
 * heatmap grid under them, all sharing one selection (an expiry row and a strike or tenor column) and one pinned flag.
 * The first slice is the selected expiry's row in the ink over every other row as muted context; the second is the
 * selected column in the second series colour over the other columns, with the cap's ATM term structure as a muted
 * dashed line. Every plotted value is a stored quote in bp; the grid and the slices' Show tables are the accessible
 * form of every value.
 */
import { useState } from "react";
import { pct, type VolGrid } from "@alm/reader";
import { Heatmap } from "./Heatmap";
import { LinePlot, type PlotSeries } from "./LinePlot";
import { stepDecimals, type XTick } from "./plotScale";
import { Surface3D } from "./Surface3D";
import { strikeTicks } from "./surfaceProjection";

export interface VolSel { i: number; j: number; pinned: boolean }

/** The first selection: the fifth expiry (or the last, on a shorter grid) and the middle column, not pinned. */
export function firstSel(grid: VolGrid): VolSel {
  return { i: Math.max(0, Math.min(4, grid.rows.length - 1)), j: Math.floor(grid.cols.length / 2), pinned: false };
}

/**
 * The selection after a hover or a click. A hover moves an unpinned selection and leaves a pinned one (and returns the
 * same selection when it is already there, so a pointer moving over one quote redraws nothing); a click pins the quote
 * it is on, and a click on the pinned quote unpins it.
 */
export function nextSel(s: VolSel, kind: "hover" | "pin", i: number, j: number): VolSel {
  if (kind === "hover") return s.pinned || (s.i === i && s.j === j) ? s : { i, j, pinned: false };
  if (s.pinned && s.i === i && s.j === j) return { i, j, pinned: false };
  return { i, j, pinned: true };
}

const bp = (v: number) => `${v.toFixed(1)} bp`;
const bpTick = (v: number, step: number) => v.toFixed(stepDecimals(step));

export function VolExplorer(props: { grid: VolGrid; kind: "cap" | "swaption"; rowFormat: (r: number) => string; colFormat: (c: number) => string; title: string }) {
  const { grid, kind, rowFormat, colFormat } = props;
  const [sel, setSel] = useState<VolSel>(() => firstSel(grid));
  if (grid.rows.length === 0 || grid.cols.length === 0) {
    return <Heatmap grid={grid} rowFormat={rowFormat} colFormat={colFormat} unit="bp" />;
  }
  const cap = kind === "cap";
  const i = Math.min(sel.i, grid.rows.length - 1);
  const j = Math.min(sel.j, grid.cols.length - 1);
  const row = grid.rows[i]!;
  const col = grid.cols[j]!;
  const hover = (a: number, b: number) => setSel((s) => nextSel(s, "hover", a, b));
  const pin = (a: number, b: number) => setSel((s) => nextSel(s, "pin", a, b));
  const rowPts = (r: number) => grid.cols.map((c, k): [number, number | null] => [c, grid.cells[r]![k] ?? null]);
  const colPts = (c: number) => grid.rows.map((r, k): [number, number | null] => [r, grid.cells[k]![c] ?? null]);
  // The cap's whole-percent strikes on an even step (every 2% on a -2% to 7% grid, at most six), else six of the stored
  // strikes printed as the grid prints them (Polish 11); every swap tenor on the swaption. The chart drops a tick whose
  // label would meet the one before.
  const strikes = cap ? strikeTicks(grid.cols, 6) : null;
  const colTicks = strikes === null ? grid.cols : strikes.ticks;
  const colAxis = strikes !== null && strikes.whole ? (k: number) => pct(k, 0) : colFormat;
  const colNoun = cap ? "strike" : "tenor";
  const quotes = grid.cells.flat().filter((v) => v !== null).length;
  const across: PlotSeries[] = [{ id: "col", label: cap ? `${colFormat(col)} strike` : `${colFormat(col)} swap`, tone: "second", points: colPts(j) }];
  // The ATM term structure only when some ATM quote is stored, the grid's own guard for its ATM column (Polish 11).
  if (cap && grid.atm !== null && grid.atm.some((v) => v !== null)) across.push({ id: "atm", label: "ATM", tone: "muted", dash: true, points: grid.rows.map((r, k) => [r, grid.atm![k] ?? null]) });
  const rowTicks: XTick[] = grid.rows.map((r) => ({ value: r, label: rowFormat(r) }));
  return (
    <div className="vx">
      <div className="vx-top">
        <div className="vx-surface">
          <Surface3D
            grid={grid}
            xKind={cap ? "linear" : "sqrt"}
            xName={cap ? "Strike" : "Swap tenor"}
            colTicks={colTicks}
            colAxis={colAxis}
            colFormat={colFormat}
            colNoun={colNoun}
            rowFormat={rowFormat}
            sel={{ i, j }}
            pinned={sel.pinned}
            onHover={hover}
            onPin={pin}
            label={`${props.title} surface, ${grid.rows.length} expiries by ${grid.cols.length} ${cap ? "strikes" : "swap tenors"}, ${quotes} stored quotes; drag to turn it, hover to read a quote, click to pin it`}
          />
          <p className="vx-pin" aria-live="polite">
            {sel.pinned ? <><strong>Pinned</strong> {rowFormat(row)} by {colFormat(col)}. Click it again to unpin.</> : "Hover to read. Click a point to pin it."}
          </p>
        </div>
        <div className="vx-slices">
          <div className="vx-slice">
            <div className="vx-slice-title">{cap ? `Smile at the ${rowFormat(row)} expiry` : `Across swap tenors at the ${rowFormat(row)} expiry`}</div>
            <LinePlot
              series={[{ id: "row", label: `${rowFormat(row)} expiry`, tone: "ink", points: rowPts(i) }]}
              context={grid.rows.map((_, k) => ({ id: `r${k}`, points: rowPts(k) })).filter((c) => c.id !== `r${i}`)}
              xScale={cap ? "linear" : "sqrt"}
              xTicks={colTicks.map((c) => ({ value: c, label: colAxis(c) }))}
              xLabel={(c) => `${colFormat(c)} ${colNoun}`}
              yTick={bpTick}
              format={bp}
              unit="Normal vol, bp"
              height={190}
              legend={false}
            />
          </div>
          <div className="vx-slice">
            <div className="vx-slice-title">{cap ? `Term structure at the ${colFormat(col)} strike` : `Across expiries for the ${colFormat(col)} swap`}</div>
            <LinePlot
              series={across}
              context={grid.cols.map((_, k) => ({ id: `c${k}`, points: colPts(k) })).filter((c) => c.id !== `c${j}`)}
              xScale="sqrt"
              xTicks={rowTicks}
              xLabel={(r) => `${rowFormat(r)} expiry`}
              yTick={bpTick}
              format={bp}
              unit="Normal vol, bp"
              height={190}
              legend={false}
            />
          </div>
        </div>
      </div>
      <Heatmap grid={grid} rowFormat={rowFormat} colFormat={colFormat} unit="bp" selection={{ i, j, onHover: hover, onPin: pin }} />
    </div>
  );
}
