// apps/studio/src/pages/compare/CompareGridAsOf.tsx
/**
 * Grid as of on Results > Compare runs (ruling 2026-10-11; spec v3.1 Section 5.4: Compare prints both labels,
 * read from the run's request.json `grid.asOf`). Under the two pickers, one meta line per chosen run reads the run
 * detail's `grid.asOf` (GET /api/runs/:id serves request.json's grid for both modes; the stored result is not read),
 * printed by `GridAsOf` with its cut-off clash badge. A detail with no grid reads not recorded. When both dates are
 * read and differ, one badge and one sentence say so.
 */
import { getRun } from "@alm/reader";
import { errText } from "../../errText";
import type { LoadState } from "../../useLoad";
import { detailGridAsOf, GridAsOf } from "../results/GridAsOf";

/** The workspace cut-off and each chosen side's grid as-of; a side is null when no run is chosen there. */
export interface CompareGrid {
  cutoff: string | null;
  a: LoadState<string | null> | null;
  b: LoadState<string | null> | null;
}

export const GRID_DATES_DIFFER = "These two runs were built on different grids; differences below mix a grid change with a model change.";

/** One run's grid as-of from its detail, either mode; null for no run or a detail that carries no grid. */
export function loadGridAsOf(runId: string | null): Promise<string | null> {
  if (runId === null) return Promise.resolve(null);
  return getRun(runId).then(detailGridAsOf);
}

function SideLine(props: { side: "A" | "B"; runId: string; asOf: LoadState<string | null>; cutoff: string | null }) {
  const { asOf } = props;
  return (
    <p className="result-meta" aria-label={`Run ${props.side} grid as of`}>
      <span>Run {props.side} <span className="mono">{props.runId}</span>{": "}</span>
      {asOf.state === "ok" ? <GridAsOf asOf={asOf.value} cutoff={props.cutoff} />
        : asOf.state === "loading" ? <span className="result-asof">Grid as of: reading the run</span>
        : <span className="result-asof" role="alert">Grid as of: not read. {errText(asOf.error)}</span>}
    </p>
  );
}

/** The lines under the pickers; nothing when neither side has a run. */
export function CompareGridAsOf(props: { a: string | null; b: string | null; grid: CompareGrid }) {
  const { a, b, grid } = props;
  const lineA = a !== null && grid.a !== null ? <SideLine side="A" runId={a} asOf={grid.a} cutoff={grid.cutoff} /> : null;
  const lineB = b !== null && grid.b !== null ? <SideLine side="B" runId={b} asOf={grid.b} cutoff={grid.cutoff} /> : null;
  if (lineA === null && lineB === null) return null;
  const da = grid.a?.state === "ok" ? grid.a.value : null;
  const db = grid.b?.state === "ok" ? grid.b.value : null;
  const differ = lineA !== null && lineB !== null && da !== null && db !== null && da !== db;
  return (
    <section className="card" aria-label="Grid as of">
      {lineA}
      {lineB}
      {differ ? (
        <>
          <p className="result-meta"><span className="result-clash" title="Run A and run B were built on grids with different as-of dates">Grid dates differ</span></p>
          <p className="card-desc">{GRID_DATES_DIFFER}</p>
        </>
      ) : null}
    </section>
  );
}
