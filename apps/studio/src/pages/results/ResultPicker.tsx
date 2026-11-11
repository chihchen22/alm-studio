// apps/studio/src/pages/results/ResultPicker.tsx
/**
 * The result picker, the first control of a Results body (spec v3.1 Section 5.4; ruling 9: inside
 * Results only, no global Run pill). It lists the workspace's done runs as a full-width select, defaults to the
 * pinned run where the workspace holds one and else to the newest done deterministic run (resultChoice.ts), and
 * says which run it picked and why, with a control that clears an explicit choice.
 * `ResultsGate` loads the rows and hands the chosen run to the screen below it.
 */
import type { ReactNode } from "react";
import { getRun, listRuns, listWorkspaceRuns, type StoredStochasticSpec } from "@alm/reader";
import { errText } from "../../errText";
import { plural } from "../../rows/plural";
import { hrefFor, type Query, type ScreenId } from "../../router";
import { useLoad } from "../../useLoad";
import { recordSlot } from "../../registry";
import { chooseResult, pickHref, pickerRuns, rowText, type PickerRun, type ResultChoice, type ResultWant, type ResultsFrame } from "./resultChoice";

export type { ResultsFrame };

export interface PickedResult {
  runId: string;
  /** The server's basis label for this run; null when the run is not attached or its request record is missing. */
  basisLabel: string | null;
  /** The run's submission mode is stochastic: only the Stochastic screen reads its envelope. */
  stochastic: boolean;
  /** The setup slot that launched the run; null when unknown (the runs were not read, or a migrated run). S3f. */
  setupLineageId?: string | null;
}

function Badges(props: { run: PickerRun }) {
  const r = props.run;
  return (
    <>
      {r.stale ? <span className="status status-stale" title={`Consumed pins the workspace no longer holds in these roles: ${r.staleRoles.join(", ")}`}>Stale</span> : null}
      {r.reconstructed ? <span className="chip" title="The run predates workspaces; its pins were reconstructed, so currency cannot be proved">pins reconstructed</span> : null}
      {r.stochastic ? <span className="chip" title="A Monte Carlo envelope: the Stochastic screen reads it">Stochastic</span> : null}
      {r.armOfRecord ? <span className="chip" title={recordSlot(r.setupLineageId)?.title ?? "Launched from the pinned-run setup"}>Pinned run</span> : null}
    </>
  );
}

export function ResultPicker(props: { ws: string; screen: ScreenId; query: Query; runs: PickerRun[]; choice: ResultChoice; want?: ResultWant }) {
  const { ws, screen, query, runs, choice } = props;
  const runsHref = hrefFor({ ws, section: "run", screen: "setups" });
  if (choice.kind === "none" && props.want === "stochastic") {
    return (
      <section className="card unobs-panel" aria-label="Result">
        <span className="status status-unobs">No result</span>
        <p className="unobs-text">This workspace holds no done stochastic run to show. Choose a stochastic run on the Analysis path's Simulation step and launch it on the Run step; it is attached to this workspace and listed here.</p>
      </section>
    );
  }
  if (choice.kind === "none") {
    return (
      <section className="card unobs-panel" aria-label="Result">
        <span className="status status-unobs">No result</span>
        <p className="unobs-text">This workspace holds no done run to show{runs.length > 0 ? " that a deterministic screen can read" : ""}. Launch a run setup, then pick its result here.</p>
        <a className="btn btn-primary" href={runsHref}>Go to Run setups</a>
      </section>
    );
  }
  const unlisted = choice.kind === "explicit" && choice.run === null;
  const selected = pickHref(ws, screen, query, choice.runId);
  const chosen = choice.run;
  // Clearing the address goes back to the default, which is the pinned run where this list holds one.
  const clearText = props.want !== "stochastic" && runs.some((r) => r.armOfRecord && !r.stochastic) ? "Use the pinned run" : "Use the newest run";
  return (
    <section className="card result-picker" aria-label="Result">
      <label className="field">
        <span className="field-label">Result</span>
        <select aria-label="Result" value={selected} onChange={(e) => { window.location.hash = e.target.value; }}>
          {unlisted ? <option value={selected}>{choice.runId} (not among this workspace&apos;s done runs)</option> : null}
          {runs.map((r) => <option key={r.runId} value={pickHref(ws, screen, query, r.runId)}>{rowText(r)}</option>)}
        </select>
      </label>
      <p className="result-picker-why" role="status">
        {choice.kind === "record"
          ? <>Showing the pinned run by default, the newest run of its setup: {rowText(choice.run)}. Pick another run above to change it.</>
          : choice.kind === "newest"
          ? <>Showing the newest done run of this workspace: {rowText(choice.run)}.</>
          : chosen !== null
          ? <>Showing the run chosen in the address: {rowText(chosen)}.</>
          : <>Showing run <span className="mono">{choice.runId}</span>, chosen in the address. This workspace&apos;s done runs do not list it.</>}
        {choice.kind === "explicit" ? <> <a className="btn btn-quiet btn-flush" href={pickHref(ws, screen, query, null)}>{clearText}</a></> : null}
      </p>
      {chosen !== null ? <div className="result-picker-badges"><Badges run={chosen} /></div> : null}
      {runs.length > 1 ? (
        <details className="result-picker-all">
          <summary>{`All ${plural(runs.length, "done run", "done runs")} of this workspace`}</summary>
          <ul>
            {runs.map((r) => (
              <li key={r.runId}>
                <a href={pickHref(ws, screen, query, r.runId)} aria-current={choice.runId === r.runId ? "true" : undefined}>{rowText(r)}</a>
                <Badges run={r} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="card-foot">Source: /api/workspaces/{ws}/runs, state done, newest first.</p>
    </section>
  );
}

/**
 * Loads the workspace's runs and their modes, renders the picker, and hands the chosen run to `children`. A failed
 * read prints its sentence and, when the address names a run, still shows that run with no label from the server.
 */
export function ResultsGate(props: { frame: ResultsFrame; query: Query; want?: ResultWant; children: (pick: PickedResult) => ReactNode }) {
  const { frame, query } = props;
  const load = useLoad(
    () => Promise.all([listWorkspaceRuns(frame.ws), listRuns().then((all) => all, () => null)]).then(async ([rows, all]) => {
      // A stochastic row names its model and path count, read off each attached stochastic run's detail; a failed read leaves it unnamed.
      const attached = new Set(rows.map((r) => r.runId));
      const ids = (all ?? []).filter((s) => s.mode === "stochastic" && attached.has(s.runId)).map((s) => s.runId);
      const specs = await Promise.all(ids.map((id) => getRun(id).then((d): [string, StoredStochasticSpec | null] => [id, d.stochastic ?? null], (): [string, StoredStochasticSpec | null] => [id, null])));
      return [rows, all, Object.fromEntries(specs)] as const;
    }),
    [frame.ws],
  );
  const explicit = query.result ?? query.run;
  if (load.state === "loading") return <div className="card muted">Reading the runs of workspace {frame.ws}</div>;
  if (load.state === "error") {
    return (
      <>
        <div className="card" role="alert">{errText(load.error)}</div>
        {explicit !== undefined && explicit !== "" ? props.children({ runId: explicit, basisLabel: null, stochastic: false }) : null}
      </>
    );
  }
  const [rows, summaries, specs] = load.value;
  const modes: Record<string, string> = {};
  for (const s of summaries ?? []) if (s.mode !== undefined) modes[s.runId] = s.mode;
  const runs = pickerRuns(rows, modes, frame.readiness, specs);
  const want = props.want ?? "deterministic";
  const choice = chooseResult(runs, explicit, want);
  return (
    <>
      <ResultPicker ws={frame.ws} screen={frame.screen} query={query} runs={runs} choice={choice} want={want} />
      {choice.kind === "none" ? null : props.children({
        runId: choice.runId,
        basisLabel: choice.run?.basisLabel ?? null,
        stochastic: choice.run?.stochastic ?? false,
        setupLineageId: choice.run?.setupLineageId ?? null,
      })}
    </>
  );
}
