import type { ReactNode } from "react";
import { signClass } from "@alm/reader";

/**
 * The comparison delta table.
 *
 * HONESTY BOUNDARY: the ONE piece of
 * result-plane arithmetic the client is permitted is the comparison delta
 * B - A, and it must be (a) labeled "derived: B - A" and (b) displayed beside
 * both originals so the reader can check the subtraction by eye. That
 * subtraction lives in `deriveDelta` below and nowhere else in the viewer.
 * Every other number in this table is a verbatim envelope field passed in by
 * the caller; this component performs no other computation.
 */

/** The exact column label the honesty contract requires on the derived column. */
export const DELTA_LABEL = "derived: B - A";

/**
 * The one permitted client-side computation: B minus A. Defined only when both
 * originals are present and finite; anything else yields undefined (rendered as
 * an em dash), never zero, because "absent" and "zero" are different facts.
 */
export function deriveDelta(a: number | undefined, b: number | undefined): number | undefined {
  if (typeof a !== "number" || typeof b !== "number") return undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return b - a;
}

export interface DeltaRow {
  key: string;
  label: ReactNode;
  /** Verbatim envelope value from run A; undefined when the field is absent. */
  a: number | undefined;
  /** Verbatim envelope value from run B; undefined when the field is absent. */
  b: number | undefined;
  /** Formats the two originals. Presentation only; no arithmetic beyond scaling for display. */
  format: (n: number) => string;
  /** Formats the derived delta; defaults to `format`. */
  formatDelta?: (n: number) => string;
  /** Rendered in place of the em dash when `a` is undefined (e.g. "n/a (base-only)"). */
  aFallback?: ReactNode;
  /** Rendered in place of the em dash when `b` is undefined. */
  bFallback?: ReactNode;
}

/**
 * Side-by-side A/B table with the labeled derived delta. Both originals always
 * render; the delta renders only when both sides are present and finite.
 */
export function DeltaTable({
  rowHeader,
  aLabel,
  bLabel,
  rows,
  footnote,
}: {
  rowHeader: string;
  aLabel: ReactNode;
  bLabel: ReactNode;
  rows: DeltaRow[];
  footnote?: ReactNode;
}) {
  return (
    <div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>{rowHeader}</th>
              <th>A: {aLabel}</th>
              <th>B: {bLabel}</th>
              <th title="Computed client-side as B minus A and shown beside both originals so the subtraction is checkable. The only client-side arithmetic on this page.">
                {DELTA_LABEL}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const delta = deriveDelta(r.a, r.b);
              const fmtDelta = r.formatDelta ?? r.format;
              return (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="num">
                    {r.a !== undefined && Number.isFinite(r.a) ? r.format(r.a) : (r.aFallback ?? "—")}
                  </td>
                  <td className="num">
                    {r.b !== undefined && Number.isFinite(r.b) ? r.format(r.b) : (r.bFallback ?? "—")}
                  </td>
                  <td className={`num ${delta !== undefined ? signClass(delta) : ""}`}>
                    {delta !== undefined ? fmtDelta(delta) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footnote ? <p className="footnote">{footnote}</p> : null}
    </div>
  );
}
