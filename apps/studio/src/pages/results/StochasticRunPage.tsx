// apps/studio/src/pages/results/StochasticRunPage.tsx
/**
 * Analyze > Measures > Stochastic distributions:
 * #/analyze/measures/stochastic?run=<runId> reads one stochastic run's stored
 * envelope over GET /api/runs/:id/stochastic/summary and displays it. With no
 * run picked it lists the done stochastic runs. Read-only: Studio does not run
 * stochastic runs, and derives nothing here.
 */
import { listRuns } from "@alm/reader";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { loadStochastic, type StochasticData } from "./loadStochastic";
import { StochasticRunBody, StochasticRunIndexView } from "./StochasticRunViews";
import { detailGridAsOf, ResultMeta } from "./GridAsOf";
import { ResultsGate, type ResultsFrame } from "./ResultPicker";
import type { ResultsBodyMeta } from "./ResultsPage";

function StochasticRunIndex(props: { ws: string }) {
  const load = useLoad(() => listRuns(), []);
  if (load.state === "loading") return <div className="card muted">Reading the run list</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <StochasticRunIndexView ws={props.ws} runs={load.value} />;
}

/**
 * The framed body: the Grid as of line and the basis label, then the run. A stochastic envelope stores no cash flow
 * grid, but the run's request.json records the grid as-of in both modes, so the line reads the run detail's
 * `grid.asOf` (the source Compare reads) with the cut-off clash badge, and says not recorded only when the detail
 * carries no grid (spec v3.1 Section 5.4, review M7).
 */
export function StochasticFramedBody(props: { runId: string; data: StochasticData; meta: ResultsBodyMeta; query?: Record<string, string> }) {
  return (
    <>
      <ResultMeta gridAsOf={detailGridAsOf(props.data.detail)} cutoff={props.meta.cutoff} basisLabel={props.meta.basisLabel} />
      <StochasticRunBody runId={props.runId} data={props.data} query={props.query} />
    </>
  );
}

function StochasticRunLoaded(props: { runId: string; meta?: ResultsBodyMeta; query?: Record<string, string> }) {
  const load = useLoad(() => loadStochastic(props.runId), [props.runId]);
  if (load.state === "loading") return <div className="card muted">Reading run {props.runId}</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  if (props.meta !== undefined) return <StochasticFramedBody runId={props.runId} data={load.value} meta={props.meta} query={props.query} />;
  return <StochasticRunBody runId={props.runId} data={load.value} query={props.query} />;
}

/**
 * Inside a workspace (a frame): the result picker, defaulting to the newest done stochastic run, then that run.
 * Without a frame: one stochastic run named in the query, or the done stochastic run list when none is named.
 */
export function StochasticRunPage(props: { ws: string; query: Record<string, string>; frame?: ResultsFrame }) {
  const frame = props.frame;
  if (frame !== undefined) {
    return (
      <ResultsGate frame={frame} query={props.query} want="stochastic">
        {(pick) => <StochasticRunLoaded runId={pick.runId} meta={{ cutoff: frame.cutoffDate, basisLabel: pick.basisLabel }} query={props.query} />}
      </ResultsGate>
    );
  }
  const runId = props.query.run;
  if (runId === undefined || runId === "") return <StochasticRunIndex ws={props.ws} />;
  return <StochasticRunLoaded runId={runId} query={props.query} />;
}
