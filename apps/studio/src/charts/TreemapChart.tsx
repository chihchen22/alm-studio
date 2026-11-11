/**
 * File named TreemapChart.tsx, not Treemap.tsx: on a case-insensitive filesystem
 * (macOS) "./Treemap" resolves to treemap.ts, the layout module.
 *
 * Treemap of served values. Geometry is squarify() over a nominal width by
 * height box, placed in percent so the plot stretches with its card. Area is
 * the only encoding: every cell has the same neutral fill (--surface-2 on a
 * --line hairline), and identity is carried by the HTML label in the cell, its
 * hover title and the card's Show table. The text is labelOf and valueOf of the
 * route's own values; nothing is derived from the rectangles. Each cell also carries --share, its value over the
 * largest cell's, which only the phone block in app.css reads: up to 900px the cells are a ranked list of bars
 * (phone 1), since a 358 px card leaves most cells too small to label.
 */
import type { CSSProperties } from "react";
import { squarify, type TreeItem } from "./treemap";

export function Treemap(props: { items: TreeItem[]; labelOf: (key: string) => string; valueOf: (key: string) => string; width: number; height: number }) {
  const { items, labelOf, valueOf, width, height } = props;
  const { rects, omitted } = squarify(items, width, height);
  const pc = (v: number, of: number) => `${(v / of) * 100}%`;
  const top = rects.reduce((m, r) => Math.max(m, r.value), 0);
  return (
    <div className="plot">
      <div className="treemap" style={{ height: `${height}px` }} role="img" aria-label={rects.map((r) => `${labelOf(r.key)} ${valueOf(r.key)}`).join(", ")}>
        {rects.map((r) => (
          <div
            key={r.key}
            className="treemap-cell"
            title={`${labelOf(r.key)}: ${valueOf(r.key)}`}
            style={{ left: pc(r.x, width), top: pc(r.y, height), width: pc(r.w, width), height: pc(r.h, height), "--share": pc(r.value, top) } as CSSProperties}
          >
            <span className="treemap-label"><span className="treemap-key">{labelOf(r.key)}</span> <span className="num">{valueOf(r.key)}</span></span>
          </div>
        ))}
      </div>
      {omitted.length > 0 && <p className="treemap-omitted">Not drawn (zero or null balance): {omitted.map((o) => labelOf(o.key)).join(", ")}</p>}
    </div>
  );
}
