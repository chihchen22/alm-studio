/**
 * A vol surface heatmap. Hand-written SVG (recharts has no heatmap).
 * Every cell is a stored quote in basis points from volSurfaceGrid.ts; this
 * component picks a ramp step per cell and lays out geometry, nothing else.
 * Text wears text tokens; the ramp colors fills only.
 */
import { useState } from "react";
import { sig } from "@alm/reader";
import { RAMP_STEPS, rampIndex, type VolGrid } from "@alm/reader";

const GUTTER = 56; // row-label gutter, px
const LABEL_H = 44; // column-label band below the grid, px
const CELL_W = 24;
const CELL_H = 18;
const GAP = 2; // the dataviz surface gap between fills
const ATM_GAP = 6; // extra gap after the ATM column
const SWATCH_W = 24;
const SWATCH_H = 10;
const EXPIRY_DIGITS = 4;

const TOOLTIP_STYLE = {
  position: "absolute",
  pointerEvents: "none",
  background: "var(--panel)",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--ink)",
  padding: "6px 8px",
  whiteSpace: "nowrap",
} as const;

interface Hover {
  key: string;
  x: number;
  y: number;
  text: string;
}

export function VolHeatmap({
  grid,
  colFormat,
  colLabel,
}: {
  grid: VolGrid;
  /** Column header text: pct(strike, 2) for cap, sig(tenor) for swaption. */
  colFormat: (c: number) => string;
  /** "Strike" or "Tenor (y)", used in the tooltip. */
  colLabel: string;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  if (grid.rows.length === 0) return <p className="emptynote">No points mirrored for this surface.</p>;

  // The ATM column and its label render only when at least one ATM quote exists.
  const atm = grid.atm !== null && grid.atm.some((v) => v !== null) ? grid.atm : null;
  const atmOffset = atm === null ? 0 : CELL_W + GAP + ATM_GAP;
  const colX = (c: number) => GUTTER + atmOffset + c * (CELL_W + GAP);
  const rowY = (r: number) => r * (CELL_H + GAP);
  const gridH = grid.rows.length * (CELL_H + GAP);
  const width = GUTTER + atmOffset + grid.cols.length * (CELL_W + GAP);
  const height = gridH + LABEL_H;
  const fill = (bp: number) => `var(--seq-${rampIndex(bp, grid.min, grid.max) + 1})`;
  const cellText = (expiry: number, col: string, bp: number) =>
    `Expiry ${sig(expiry, EXPIRY_DIGITS)}y, ${col}: ${bp.toFixed(1)} bp`;

  const cell = (key: string, x: number, y: number, bp: number, text: string) => (
    <rect
      key={key}
      x={x}
      y={y}
      width={CELL_W}
      height={CELL_H}
      rx={2}
      fill={fill(bp)}
      stroke={hover !== null && hover.key === key ? "var(--line-strong)" : "none"}
      strokeWidth={1.5}
      onMouseEnter={() => setHover({ key, x: x + CELL_W + 8, y, text })}
      onMouseLeave={() => setHover(null)}
    >
      <title>{text}</title>
    </rect>
  );

  const labelY = gridH + 8;

  return (
    <div>
      <div style={{ position: "relative", overflowX: "auto" }}>
        <svg
          width={width}
          height={height}
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label={`Normal vol heatmap, expiry by ${colLabel}, ${grid.min.toFixed(1)} to ${grid.max.toFixed(1)} bp`}
        >
          {grid.rows.map((expiry, r) => {
            const atmBp = atm === null ? null : atm[r];
            return (
              <g key={expiry}>
                <text
                  x={GUTTER - 6}
                  y={rowY(r) + CELL_H / 2 + 4}
                  textAnchor="end"
                  fontSize={11}
                  fill="var(--muted)"
                >
                  {sig(expiry, EXPIRY_DIGITS)}
                </text>
                {atmBp === null ? null : cell(`${r}:atm`, GUTTER, rowY(r), atmBp, cellText(expiry, "ATM", atmBp))}
                {grid.cells[r].map((bp, c) =>
                  bp === null
                    ? null
                    : cell(
                        `${r}:${c}`,
                        colX(c),
                        rowY(r),
                        bp,
                        cellText(expiry, `${colLabel} ${colFormat(grid.cols[c])}`, bp),
                      ),
                )}
              </g>
            );
          })}
          {atm === null ? null : (
            <text
              transform={`translate(${GUTTER + CELL_W / 2} ${labelY}) rotate(-45)`}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted)"
            >
              ATM
            </text>
          )}
          {grid.cols.map((col, c) => (
            <text
              key={col}
              transform={`translate(${colX(c) + CELL_W / 2} ${labelY}) rotate(-45)`}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted)"
            >
              {colFormat(col)}
            </text>
          ))}
        </svg>
        {hover === null ? null : (
          <div style={{ ...TOOLTIP_STYLE, left: hover.x, top: hover.y }}>{hover.text}</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 11, color: "var(--muted)" }}>
        <span>{grid.min.toFixed(1)} bp</span>
        <svg width={RAMP_STEPS * SWATCH_W} height={SWATCH_H} aria-hidden="true">
          {Array.from({ length: RAMP_STEPS }, (_, i) => (
            <rect key={i} x={i * SWATCH_W} y={0} width={SWATCH_W} height={SWATCH_H} fill={`var(--seq-${i + 1})`} />
          ))}
        </svg>
        <span>{grid.max.toFixed(1)} bp</span>
      </div>
    </div>
  );
}
