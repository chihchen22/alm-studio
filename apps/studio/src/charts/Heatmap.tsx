/**
 * Vol surface heatmap as an HTML grid (the S0 .hm classes). Every cell prints
 * a VolGrid value (a stored decimal normal vol times VOL_TO_BP, from the
 * reader) with the viewer VolHeatmap's cell formatter, bp.toFixed(1). The fill
 * is a --seq-N bucket picked by seqStep over the grid's own min and max: a
 * colour choice, not a number. A missing quote prints the Unobservable chip.
 * The ATM column leads when the grid carries at least one ATM quote. With a
 * selection (the vol surface explorer, Polish 10 T4) every quote cell carries
 * its row and column index; the selected cell takes a ring, its row and column
 * headers highlight, and while the pointer is on the grid the cells off its row
 * and column dim. Hovering a quote cell selects it and a click pins it (the
 * explorer decides what a pinned selection lets through); the ATM column is not
 * a surface vertex and selects nothing.
 */
import { useState, type CSSProperties, type MouseEvent } from "react";
import type { VolGrid } from "@alm/reader";
import { seqStep } from "../rows/marketRows";

const STEPS = [1, 2, 3, 4, 5, 6, 7] as const;

function inkClass(step: number): string {
  return step <= 2 ? "hm-lo" : step <= 5 ? "hm-mid" : "hm-hi";
}

/** The grid's own row and column indexes of the selected quote, with the hover and pin callbacks. */
export interface HeatSelection { i: number; j: number; onHover: (i: number, j: number) => void; onPin: (i: number, j: number) => void }

/** The quote cell under a pointer event: its data-i and data-j, or null off a quote cell. */
function cellAt(e: MouseEvent<HTMLElement>): { i: number; j: number } | null {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-j]");
  return el === null ? null : { i: Number(el.dataset.i), j: Number(el.dataset.j) };
}

export function Heatmap(props: { grid: VolGrid; colFormat: (c: number) => string; rowFormat: (r: number) => string; unit: string; selection?: HeatSelection }) {
  const { grid, colFormat, rowFormat, unit, selection } = props;
  const [over, setOver] = useState(false);
  if (grid.rows.length === 0) {
    return <p className="unobs-text"><span className="status status-unobs">Unobservable</span> The snapshot stores no quote on this surface.</p>;
  }
  const atm = grid.atm !== null && grid.atm.some((v) => v !== null) ? grid.atm : null;
  const cols: Array<{ key: string; label: string; j: number | null; values: Array<number | null> }> = [
    ...(atm === null ? [] : [{ key: "atm", label: "ATM", j: null, values: atm }]),
    ...grid.cols.map((c, j) => ({ key: String(c), label: colFormat(c), j, values: grid.rows.map((_, i) => grid.cells[i][j]) })),
  ];
  const text = (bp: number) => bp.toFixed(1);
  const sel = selection;
  // The data attributes and the selection classes of a quote cell; nothing without a selection or on the ATM column.
  const pick = (i: number, j: number | null) => {
    if (sel === undefined || j === null) return { cls: "", data: {} };
    const cross = i === sel.i || j === sel.j ? " hm-x" : "";
    return { cls: `${cross}${i === sel.i && j === sel.j ? " hm-at" : ""}`, data: { "data-i": i, "data-j": j } };
  };
  const on = (hit: boolean) => (hit ? " hm-on" : "");
  return (
    <div className="hm-block">
      <div className="hm-scroll">
        <div
          className={sel !== undefined && over ? "hm hm-hov" : "hm"}
          style={{ "--hm-cols": cols.length } as CSSProperties}
          role="group"
          aria-label={`Normal vol, ${unit}, ${grid.rows.length} expiries by ${cols.length} columns`}
          onMouseOver={sel === undefined ? undefined : (e) => { const at = cellAt(e); if (at !== null) { setOver(true); sel.onHover(at.i, at.j); } }}
          onMouseLeave={sel === undefined ? undefined : () => setOver(false)}
          onClick={sel === undefined ? undefined : (e) => { const at = cellAt(e); if (at !== null) sel.onPin(at.i, at.j); }}
        >
          <div className="hm-col">Expiry</div>
          {cols.map((c) => <div key={c.key} className={`hm-col${on(sel !== undefined && c.j !== null && c.j === sel.j)}`}>{c.label}</div>)}
          {grid.rows.map((r, i) => [
            <div key={`r${i}`} className={`hm-row${on(sel !== undefined && i === sel.i)}`}>{rowFormat(r)}</div>,
            ...cols.map((c) => {
              const bp = c.values[i];
              const p = pick(i, c.j);
              if (bp === null) {
                return (
                  <div key={`${i}:${c.key}`} className={`hm-cell unobs${p.cls}`} {...p.data} title={`${rowFormat(r)}, ${c.label}: Unobservable, no quote stored`}>
                    <span className="status status-unobs">Unobservable</span>
                  </div>
                );
              }
              const step = seqStep(bp, grid.min, grid.max, 7);
              return (
                <div key={`${i}:${c.key}`} className={`hm-cell ${inkClass(step)}${p.cls}`} {...p.data} style={{ background: `var(--seq-${step})` }} title={`${rowFormat(r)}, ${c.label}: ${text(bp)} ${unit}`}>
                  {text(bp)}
                </div>
              );
            }),
          ])}
        </div>
      </div>
      <div className="ramp-legend">
        <span>{text(grid.min)} {unit}</span>
        <div className="ramp" aria-hidden="true">
          {STEPS.map((k) => <span key={k} className="ramp-cell" style={{ background: `var(--seq-${k})` }} />)}
        </div>
        <span>{text(grid.max)} {unit}, seven equal bins from the surface minimum to its maximum</span>
      </div>
    </div>
  );
}
