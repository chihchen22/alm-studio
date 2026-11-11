// apps/studio/src/pages/results/ResultsPage.tsx
/**
 * Analyze measure layers: each Results measure is its own
 * layer, #/analyze/<area>/<measure>?run=<runId>, rendering one tab body with
 * that measure's CSV export links; with no run picked it lists the done runs.
 * The plan's notImplemented tags sit above the body. Every figure is a stored
 * field; a missing one says so.
 */
import type { NotImplemented } from "@alm/engine";
import { exportCsvUrl, listRuns, type ExportTable, type RunState } from "@alm/reader";
import { compareHref } from "../../compare/compareModel";
import { errText } from "../../errText";
import { screenHref } from "../../pageLinks";
import { pastRunRows, resultsHref, type PastRunRow } from "../../run/runList";
import { useLoad } from "../../useLoad";
import { scenarioLabeller } from "../../format/scenarios";
import { stochasticHref } from "../../results/stochasticRun";
import { loadResults, planIdText, type ResultsData } from "./loadResults";
import { tabBody, type TabId } from "./tabs";
import { envelopeBasisLabel } from "../../rows/basisLabel";
import { gridAsOfOf, ModelConventionNote, ResultMeta } from "./GridAsOf";
import { StochasticNiiCard } from "./NiiAbsentStates";
import { ResultsGate, type ResultsFrame } from "./ResultPicker";
import { INFORMATIONAL_LAYERS } from "./informational";
import { runCurveLine } from "../../results/curveLine";
import { StartHereNote } from "../workspace/StartHere";

/** Compare seeded with this run as A; no other page state travels with it. */
function compareWithHref(ws: string, runId: string): string {
  return compareHref(ws, {}, runId, null, "nii");
}

/** A run's state as a chip: done passes, error and cancelled breach, queued and running are neutral. */
function stateChip(state: RunState): string {
  if (state === "done") return "status status-pass";
  if (state === "error" || state === "cancelled") return "status status-breach";
  return "chip";
}

const NO_REFS = "Unobservable: the run detail carries no refs";

/**
 * The run in view under the head band: its label on a line of its own (Polish 1 F3: a long label no longer
 * shrinks to a few characters), then id, plan, book, market and state, then Compare. Each value names itself in
 * its title and in a visually hidden label for screen readers rather than a visible key word. The source routes
 * are the strip's title. `picked` says the Dashboard chose the run itself (no run in the Run pill). The curve the run
 * built on closes the strip on a line of its own, the server's words verbatim.
 */
export function RunStrip(props: { ws: string; runId: string; data: ResultsData; query: Record<string, string>; picked?: boolean }) {
  const { detail } = props.data;
  return (
    <div className="run-strip" role="group" aria-label="Run" title={`Source: /api/runs/${props.runId}; plan id from /api/runs/${props.runId}/result provenance.planId`}>
      <span className="run-strip-label" title={detail.label ?? "No label"}>{detail.label ?? "No label"}</span>
      <span className="mono" title="Run"><span className="sr-only">Run: </span>{props.runId}</span>
      <span className="mono" title="Plan"><span className="sr-only">Plan: </span>{planIdText(props.data)}</span>
      <span className="mono" title="Book"><span className="sr-only">Book: </span>{detail.refs?.portfolioId ?? NO_REFS}</span>
      <span className="mono" title="Market"><span className="sr-only">Market: </span>{detail.refs?.marketId ?? NO_REFS}</span>
      <span className={stateChip(detail.state)}>{detail.state}</span>
      <a className="pill pill-quiet" href={compareWithHref(props.ws, props.runId)}>Compare with...</a>
      {props.picked === true ? <span>Showing the latest done run. Pick another in the Run pill.</span> : null}
      <span className="run-strip-curve" title="Curve">{runCurveLine(detail)}</span>
    </div>
  );
}

/**
 * The engine tags attribution.<scenarioId> when a scenario differs from base in assumptions or new business
 * (packages/engine/src/run/attribution.ts); a P2 balance plan on one scenario raises one per other scenario. Those
 * read as one plain line naming the scenarios, the engine text kept verbatim behind a disclosure; every other tag
 * prints verbatim as before.
 */
const ATTRIBUTION_SKIP = "changes assumptions or new business versus base";
const isAttributionSkip = (t: NotImplemented) => t.layer.startsWith("attribution.") && t.reason.includes(ATTRIBUTION_SKIP);

export function NotImplementedBanner(props: { tags: NotImplemented[] }) {
  if (props.tags.length === 0) return null;
  const skipped = props.tags.filter(isAttributionSkip);
  const rest = props.tags.filter((t) => !isAttributionSkip(t));
  return (
    <section className="card plan-notes" aria-label="Run notes">
      <div className="card-title">Layers that did not run, and notes</div>
      <ul className="nimpl-list">
        {skipped.length > 0 ? (
          <li title={skipped.map((t) => t.layer).join(", ")}>
            <span className="status status-unobs">○ Not implemented</span> Driver attribution was not built for {skipped.map((t) => t.layer.slice("attribution.".length)).join(", ")}: their assumptions or new business differ from base.
            <details className="nimpl-detail">
              <summary>Engine text</summary>
              <ul className="nimpl-list">{skipped.map((t) => <li key={t.layer}><span className="mono">{t.layer}</span> {t.reason}</li>)}</ul>
            </details>
          </li>
        ) : null}
        {rest.map((t, i) => (
          <li key={i}><span className="status status-unobs">{INFORMATIONAL_LAYERS.has(t.layer) ? "○ Informational" : "○ Not implemented"}</span> <span className="mono">{t.layer}</span> {t.reason}</li>
        ))}
      </ul>
    </section>
  );
}

export function RunIndexView(props: { ws: string; rows: PastRunRow[]; query: Record<string, string> }) {
  const done = props.rows.filter((r) => r.state === "done");
  if (done.length === 0) {
    return (
      <section className="card unobs-panel" aria-label="Results">
        <span className="status status-unobs">No result</span>
        <p className="unobs-text">No runs yet, press Run.</p>
        <a className="btn btn-primary" href={screenHref({ ws: props.ws, section: "run", screen: "queue" })}>Go to Run</a>
      </section>
    );
  }
  return (
    <section className="card" aria-label="Done runs">
      <div className="card-title">Done runs</div>
      <ul className="run-list">
        {done.map((r) => (
          <li key={r.runId}>
            <a className="btn btn-quiet btn-flush mono" href={resultsHref(props.ws, props.query, r.runId, r.stochastic === true)}>{r.runId}</a>
            <span className="mono muted">{r.stochastic === true ? "stochastic" : r.planId ?? "no plan"}</span>
            <span className="muted">{r.label ?? ""}</span>
            <span className="num muted">{r.submittedAt}</span>
          </li>
        ))}
      </ul>
      <p className="card-foot">Source: /api/runs, state done</p>
    </section>
  );
}

function RunIndex(props: { ws: string; query: Record<string, string> }) {
  const load = useLoad(() => listRuns(), []);
  if (load.state === "loading") return <div className="card muted">Reading the run list</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <RunIndexView ws={props.ws} rows={pastRunRows(load.value)} query={props.query} />;
}

/** The export tables each measure can download (apps/server/src/export/csv.ts). FTP and the bucket ladders link from their own cards. */
export const EXPORTS_BY_TAB: Partial<Record<TabId, ExportTable[]>> = {
  nii: ["nii"],
  eve: ["eve"],
  gap: ["repricing-gap", "liquidity-gap", "cashflows"],
  attribution: ["attribution"],
};

function ExportBar(props: { runId: string; tab: TabId }) {
  const tables = EXPORTS_BY_TAB[props.tab] ?? [];
  if (tables.length === 0) return null;
  return (
    <div className="export-bar">
      {tables.map((t) => <a key={t} className="btn btn-quiet" href={exportCsvUrl(props.runId, t)} download>Export {t}.csv</a>)}
    </div>
  );
}

/**
 * No result for the run, and why. A stochastic run also links to Stochastic distributions, the layer that shows
 * its envelope. The section only: each caller keeps its own run strip. With no label the section carries
 * no aria-label, the Dashboard's markup; the Results layer passes "No result".
 */
export function NoResultCard(props: { ws: string; runId: string; data: ResultsData; label?: string }) {
  const stochastic = (props.data.detail.mode ?? "deterministic") === "stochastic";
  return (
    <section className="card unobs-panel" aria-label={props.label}>
      <span className="status status-unobs">No result</span>
      <p className="unobs-text">{props.data.note}</p>
      {stochastic ? <a className="btn btn-primary" href={stochasticHref(props.ws, props.runId)}>Open Stochastic distributions</a> : null}
    </section>
  );
}

/** What a framed Results body adds under the run strip: the cut-off the grid as-of is compared with, and the server's basis label. */
export interface ResultsBodyMeta {
  cutoff: string | null;
  basisLabel: string | null;
}

export function ResultsLayerBody(props: { ws: string; tab: TabId; runId: string; data: ResultsData; query: Record<string, string>; meta?: ResultsBodyMeta }) {
  const { detail, result } = props.data;
  const meta = props.meta;
  if (result === null) {
    return (
      <>
        <RunStrip ws={props.ws} runId={props.runId} data={props.data} query={props.query} />
        {meta === undefined ? null : <ResultMeta gridAsOf={null} cutoff={meta.cutoff} basisLabel={meta.basisLabel} />}
        <NoResultCard ws={props.ws} runId={props.runId} data={props.data} label="No result" />
        {props.tab === "nii" && (detail.mode ?? "deterministic") === "stochastic" ? <StochasticNiiCard runId={props.runId} /> : null}
      </>
    );
  }
  const body = tabBody(props.tab);
  // The server's label for an attached run; the envelope's own provenance for any other.
  const basisLabel = meta === undefined ? undefined : meta.basisLabel ?? envelopeBasisLabel(result);
  return (
    <>
      <RunStrip ws={props.ws} runId={props.runId} data={props.data} query={props.query} />
      {meta === undefined ? null : <ResultMeta gridAsOf={gridAsOfOf(result)} cutoff={meta.cutoff} basisLabel={basisLabel ?? null} />}
      <ModelConventionNote result={result} />
      <NotImplementedBanner tags={result.notImplemented ?? []} />
      <ExportBar runId={props.runId} tab={props.tab} />
      {body === undefined ? null : body({ ws: props.ws, runId: props.runId, detail, result, query: props.query, scenarioLabel: scenarioLabeller(detail), ...(basisLabel === undefined ? {} : { basisLabel }) })}
    </>
  );
}

function LayerRun(props: { ws: string; tab: TabId; runId: string; query: Record<string, string>; meta?: ResultsBodyMeta }) {
  const load = useLoad(() => loadResults(props.runId), [props.runId]);
  if (load.state === "loading") return <div className="card muted">Reading run {props.runId}</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <ResultsLayerBody ws={props.ws} tab={props.tab} runId={props.runId} data={load.value} query={props.query} {...(props.meta === undefined ? {} : { meta: props.meta })} />;
}

/** The result picker first, then the screen on the run it chose: the framed form every workspace route uses. */
function FramedResultsLayer(props: { ws: string; tab: TabId; query: Record<string, string>; frame: ResultsFrame }) {
  return (
    <ResultsGate frame={props.frame} query={props.query}>
      {(pick) => (
        <>
          {/* A result a Start here step opened says what to change and run again, on that demo's own runs only. */}
          <StartHereNote ws={props.ws} demoId={props.query.demo} runSlot={pick.setupLineageId ?? null} />
          <LayerRun ws={props.ws} tab={props.tab} runId={pick.runId} query={props.query} meta={{ cutoff: props.frame.cutoffDate, basisLabel: pick.basisLabel }} />
        </>
      )}
    </ResultsGate>
  );
}

/** One Analyze measure: the run in the Run pill, or the done-run list when none is picked. */
export function ResultsLayer(props: { ws: string; tab: TabId; query: Record<string, string>; frame?: ResultsFrame }) {
  if (props.frame !== undefined) return <FramedResultsLayer ws={props.ws} tab={props.tab} query={props.query} frame={props.frame} />;
  const runId = props.query.run;
  if (runId === undefined || runId === "") return <RunIndex ws={props.ws} query={props.query} />;
  return <LayerRun ws={props.ws} tab={props.tab} runId={runId} query={props.query} />;
}
