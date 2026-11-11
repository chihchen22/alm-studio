// apps/studio/src/pages/results/GridAsOf.tsx
/**
 * `Grid as of` and the clash badge (spec v3.1 Sections 2.5 and 5.4). The grid's time zero is the book's as-of, which
 * a Test, FTP, Stress or Monthly workspace may hold at a date other than its cut-off (a recorded, warned clash), so
 * every Results screen prints the run's own grid as-of and a badge naming the cut-off when the two differ.
 */
import type { RunResult } from "@alm/engine";
import type { RunDetail } from "@alm/reader";
import "./resultsE7.css";

/** The stored envelope's grid as-of (`cashflows.grid.asOf`); null when an old envelope carries none. */
export function gridAsOfOf(result: RunResult): string | null {
  const grid = (result as { cashflows?: { grid?: { asOf?: unknown } } }).cashflows?.grid;
  return typeof grid?.asOf === "string" ? grid.asOf : null;
}

/** The run detail's grid as-of (request.json's `grid.asOf`, recorded in both modes); null when the detail carries none. */
export function detailGridAsOf(detail: Pick<RunDetail, "grid">): string | null {
  return typeof detail.grid?.asOf === "string" ? detail.grid.asOf : null;
}

export function GridAsOf(props: { asOf: string | null; cutoff: string | null }) {
  if (props.asOf === null) return <span className="result-asof">Grid as of: not recorded on this run</span>;
  const clash = props.cutoff !== null && props.cutoff !== props.asOf;
  return (
    <span className="result-asof">
      Grid as of {props.asOf}
      {clash ? <> <span className="result-clash" title="The run's grid as-of differs from the workspace's cut-off date">workspace cut-off {props.cutoff}</span></> : null}
    </span>
  );
}

/** The meta line under a run strip: the grid as-of with its clash badge, then the basis label every NII figure carries. */
export function ResultMeta(props: { gridAsOf: string | null; cutoff: string | null; basisLabel: string | null }) {
  return (
    <p className="result-meta" aria-label="Result basis">
      <GridAsOf asOf={props.gridAsOf} cutoff={props.cutoff} />
      <span className="result-basis">Basis: {props.basisLabel ?? "not recorded"}</span>
    </p>
  );
}

/**
 * One line under a deterministic run's meta when it ran on the original convention. A run with no
 * convention recorded was made before the corrections; a run that named "book" chose the original convention. A run on
 * the corrections shows nothing.
 */
export function modelConventionNoteText(convention: RunResult["modelConvention"]): string | null {
  if (convention === "corrected-v1") return null;
  if (convention === "book") return "Original convention: this run keeps the behavior before the corrections.";
  return "Made before the corrections; re-run with corrections to update.";
}

export function ModelConventionNote(props: { result: RunResult }) {
  const text = modelConventionNoteText(props.result.modelConvention);
  return text === null ? null : <p className="result-meta" role="note">{text}</p>;
}
