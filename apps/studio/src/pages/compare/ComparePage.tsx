// apps/studio/src/pages/compare/ComparePage.tsx
/**
 * Compare route (Studio S3b): #/compare?runs=a,b&table=nii reads two done runs
 * side by side over GET /api/compare, the JSON twin of compare.csv. The page
 * computes nothing: cells are the reply's values as text, and B - A is the
 * reply's own derived column. A refusal is the server's own message.
 * When either chosen run is stochastic (the listing's mode), the pair reads
 * GET /api/compare/stochastic instead: two stochastic runs compare as
 * distributions, and a mixed pair shows the server's own refusal.
 * Compare is where the house-price response is read, so the page
 * carries MACRO_COMPARE_NOTE, rendered by ComparePage outside the bodies,
 * tables, provenance card and run pickers.
 * Ruling 2026-10-11: the pickers offer the workspace's done runs only
 * (the runs /api/workspaces/:id/runs attaches, as Run > Queue does), each row
 * in the result picker's words, and under them each chosen run prints its Grid
 * as of line (CompareGridAsOf). A run's mode, and so the route a pair reads,
 * still comes from all of /api/runs, so an address naming a run of another
 * workspace reads the same comparison it did before.
 */
import { compareCsvUrl, getCompare, getStochasticCompare, getStochasticSummary, listRuns, listWorkspaceRuns, type CompareReply, type RunSummary, type StochasticCompareReply } from "@alm/reader";
import { errText } from "../../errText";
import { useLoad, type LoadState } from "../../useLoad";
import { calibrationCardWanted, compareRouteOf, parseCompareQuery } from "../../compare/compareModel";
import { pickerRuns, rowText, type ResultsFrame } from "../results/resultChoice";
import { CompareTable, ProvenanceCard, RunPickers, type PickerScope } from "./CompareViews";
import { CompareGridAsOf, loadGridAsOf, type CompareGrid } from "./CompareGridAsOf";
import { StochasticCompareBody, type CompareCalibration } from "./StochasticCompareViews";

/** The page once the run list is read; `compare` is null until two runs are chosen. */
export function CompareBody(props: { ws: string; runs: RunSummary[]; query: Record<string, string>; compare: LoadState<CompareReply> | null; scope?: PickerScope; scopeNote?: string | null; grid?: CompareGrid }) {
  const { a, b, table } = parseCompareQuery(props.query);
  let body;
  if (a === null || b === null || props.compare === null) {
    body = (
      <section className="card unobs-panel" aria-label="Comparison">
        <span className="status status-unobs">No comparison</span>
        <p className="unobs-text">Pick two done runs.</p>
      </section>
    );
  } else if (props.compare.state === "loading") {
    body = <div className="card muted">Reading the comparison of {a} and {b}</div>;
  } else if (props.compare.state === "error") {
    body = <div className="card" role="alert">{errText(props.compare.error)}</div>;
  } else {
    const reply = props.compare.value;
    body = (
      <>
        <section className="card" aria-label="Comparison">
          <div className="card-title">
            Table <span className="mono">{reply.table}</span>: run A <span className="mono">{a}</span>, run B <span className="mono">{b}</span>
          </div>
          <p><a className="btn" href={compareCsvUrl(a, b, table)}>Download CSV</a></p>
          <CompareTable reply={reply} />
          <p className="card-foot">Source: GET /api/compare (the aligned table compare.csv renders; B - A is the one derived column)</p>
        </section>
        <ProvenanceCard reply={reply} />
      </>
    );
  }
  return (
    <>
      <RunPickers ws={props.ws} runs={props.runs} a={a} b={b} table={table} query={props.query} scope={props.scope} scopeNote={props.scopeNote} />
      {props.grid === undefined ? null : <CompareGridAsOf a={a} b={b} grid={props.grid} />}
      {body}
    </>
  );
}

/** Said under the pickers when the workspace's run list could not be read and every stored run is offered. */
export const SCOPE_UNREAD_NOTE = "The workspace's run list could not be read; all stored runs are listed.";

/**
 * Every run of /api/runs (modes and the route choice read it), and the workspace's picker scope. The scope is absent
 * (no picker scoping) with a note when the workspace's own run list failed: that read narrows the pickers and
 * nothing else, so its failure does not fail the screen.
 */
export interface CompareRuns {
  runs: RunSummary[];
  scope?: PickerScope;
  scopeNote: string | null;
}

/** /api/runs whole, and the runs /api/workspaces/:id/runs attaches (the loadRunPage join) as the picker scope, with rowText for each. */
export async function loadCompareRuns(ws: string): Promise<CompareRuns> {
  const [runs, attached] = await Promise.all([listRuns(), listWorkspaceRuns(ws).catch(() => null)]);
  const modes: Record<string, string> = {};
  for (const r of runs) if (r.mode !== undefined) modes[r.runId] = r.mode;
  if (attached === null) return { runs, scopeNote: SCOPE_UNREAD_NOTE };
  const rowTexts: Record<string, string> = {};
  for (const p of pickerRuns(attached, modes, null)) rowTexts[p.runId] = rowText(p);
  return { runs, scope: { ids: [...new Set(attached.map((r) => r.runId))], rowTexts }, scopeNote: null };
}

type Chosen = { ws: string; listed: CompareRuns; query: Record<string, string>; grid: CompareGrid };

function CompareLoaded(props: Chosen & { a: string; b: string }) {
  const { table } = parseCompareQuery(props.query);
  const load = useLoad(() => getCompare(props.a, props.b, table), [props.a, props.b, table]);
  return <CompareBody ws={props.ws} runs={props.listed.runs} scope={props.listed.scope} scopeNote={props.listed.scopeNote} query={props.query} compare={load} grid={props.grid} />;
}

/** A stochastic comparison and, for a pair naming BGM, both runs' calibration arms; null for a Hull-White pair. */
export interface StochasticCompareRead {
  reply: StochasticCompareReply;
  calibration: CompareCalibration | null;
}

/**
 * GET /api/compare/stochastic, then, only when either `model` context row reads BGM, both runs' single-run summaries
 * for their `calibration` fields. A Hull-White pair makes the one request. A refused summary
 * keeps the comparison and names the refusal in the card.
 */
export async function loadStochasticCompare(a: string, b: string): Promise<StochasticCompareRead> {
  const reply = await getStochasticCompare(a, b);
  if (!calibrationCardWanted(reply)) return { reply, calibration: null };
  try {
    const [sa, sb] = await Promise.all([getStochasticSummary(reply.runA), getStochasticSummary(reply.runB)]);
    // A server before slice two serves no calibration field: say so rather than throw in the card.
    const lacking = sa.calibration === undefined ? reply.runA : sb.calibration === undefined ? reply.runB : null;
    if (lacking !== null) return { reply, calibration: { error: `the summary of ${lacking} carries no calibration field` } };
    return { reply, calibration: { a: sa.calibration, b: sb.calibration } };
  } catch (e) {
    return { reply, calibration: { error: errText(e) } };
  }
}

function StochasticCompareLoaded(props: Chosen & { a: string; b: string }) {
  const load = useLoad<StochasticCompareRead>(() => loadStochasticCompare(props.a, props.b), [props.a, props.b]);
  const compare: LoadState<StochasticCompareReply> = load.state === "ok" ? { state: "ok", value: load.value.reply } : load;
  const calibration = load.state === "ok" ? load.value.calibration : null;
  return <StochasticCompareBody ws={props.ws} runs={props.listed.runs} scope={props.listed.scope} scopeNote={props.listed.scopeNote} query={props.query} compare={compare} calibration={calibration} grid={props.grid} />;
}

/** Where the macro effect is read. */
export const MACRO_COMPARE_NOTE = "The house-price response shows here, run against run: compare a mapped run with the unmapped run on the same market. Every scenario in a run shares one macro path, inherited from the base, so the Dashboard stress card and the EVE channel rows show none of it.";

/** The note's own paragraph, outside every pinned Compare component. */
export function MacroCompareNote() {
  return <p className="card-desc">{MACRO_COMPARE_NOTE}</p>;
}

/** The run list is read: each chosen side's grid as-of is read, then the pair's comparison on the route all of /api/runs picks. */
export function CompareChosen(props: { ws: string; listed: CompareRuns; query: Record<string, string>; cutoff: string | null }) {
  const { runs } = props.listed;
  const { a, b } = parseCompareQuery(props.query);
  const gridA = useLoad(() => loadGridAsOf(a), [a]);
  const gridB = useLoad(() => loadGridAsOf(b), [b]);
  const grid: CompareGrid = { cutoff: props.cutoff, a: a === null ? null : gridA, b: b === null ? null : gridB };
  const chosen = { ws: props.ws, listed: props.listed, query: props.query, grid };
  if (a === null || b === null) return <CompareBody ws={props.ws} runs={runs} scope={props.listed.scope} scopeNote={props.listed.scopeNote} query={props.query} compare={null} grid={grid} />;
  if (compareRouteOf(runs, a, b) === "stochastic") return <StochasticCompareLoaded {...chosen} a={a} b={b} />;
  return <CompareLoaded {...chosen} a={a} b={b} />;
}

function CompareRoute(props: { ws: string; query: Record<string, string>; cutoff: string | null }) {
  const load = useLoad(() => loadCompareRuns(props.ws), [props.ws]);
  if (load.state === "loading") return <div className="card muted">Reading the run list</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <CompareChosen ws={props.ws} listed={load.value} query={props.query} cutoff={props.cutoff} />;
}

/** Inside a workspace; the frame carries the cut-off the Grid as of lines read their clash badge against. */
export function ComparePage(props: { ws: string; query: Record<string, string>; frame?: ResultsFrame }) {
  return (
    <>
      <MacroCompareNote />
      <CompareRoute ws={props.ws} query={props.query} cutoff={props.frame?.cutoffDate ?? null} />
    </>
  );
}
