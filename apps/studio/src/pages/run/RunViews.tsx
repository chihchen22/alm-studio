// apps/studio/src/pages/run/RunViews.tsx
/**
 * Run page views (Studio S3a), props only: the confirm sheet, the progress
 * card, the refusal banner and the two lists. Nothing here fetches or
 * computes a number; every hash, state and line is a server reply as received.
 */
import type { RunPlanMeta, RunState } from "@alm/reader";
import type { Paint } from "../../plan/gatePaint";
import type { ConfirmModel } from "../../run/confirm";
import { progressHref, resultsHref, runHref, type PastRunRow } from "../../run/runList";
import { cancellable, runErrorLine, type RunView } from "../../run/runState";
import { hrefFor } from "../../router";
import { GateBar } from "../plan/GateBar";
import type { ValidateState } from "../plan/useValidate";
import type { SubmitOutcome } from "./runActions";

export function stateClass(s: RunState): string {
  if (s === "done") return "status status-pass";
  if (s === "queued" || s === "running") return "status status-stale";
  return "status status-breach";
}

export function RefusalBanner(props: { outcome: SubmitOutcome | null }) {
  const o = props.outcome;
  if (o === null || o.kind === "submitted") return null;
  if (o.kind === "refused") {
    return (
      <div className="card plan-banner" role="alert">
        <div><span className="status status-breach">✕ {o.code}</span> {o.message}</div>
        <div className="muted">The server refused the run ({o.status}). No run was started and no result exists.</div>
      </div>
    );
  }
  return <div className="card plan-banner" role="alert"><div><span className="status status-unobs">○ Submit not confirmed</span> {o.message}</div></div>;
}

function DiffBlock(props: { diff: ConfirmModel["diff"] }) {
  const d = props.diff;
  switch (d.kind) {
    case "self":
      return <p className="card-desc">This is the seeded plan for its book; there is nothing to compare.</p>;
    case "no-seed":
      return <p className="card-desc">No seeded plan for this book: {d.seededId} is not in the plan store.</p>;
    case "same":
      return <p className="card-desc">No structural difference from {d.seededId}.</p>;
    case "diff":
      return (
        <>
          <p className="card-desc">Against {d.seededId}:</p>
          <ul className="diff-list">{d.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        </>
      );
  }
}

export function ConfirmView(props: {
  model: ConfirmModel;
  v: ValidateState;
  gates: Paint["gates"];
  busy: boolean;
  outcome: SubmitOutcome | null;
  closeHref: string;
  onRun(): void;
}) {
  const m = props.model;
  return (
    <section className="card" aria-label="Confirm run">
      <div className="card-title">Run plan <span className="mono">{m.planId}</span></div>
      <dl className="kv">
        <dt>Label</dt><dd>{m.label}</dd>
        <dt>Book</dt><dd className="mono">{m.positionBook}</dd>
        <dt>As of</dt><dd className="num">{m.asOf}</dd>
        <dt>Plan hash</dt><dd className="mono">{m.planHashText}</dd>
        <dt>Profile hash</dt><dd className="mono">{m.profileHashText}</dd>
      </dl>
      <div className="run-sub">Gates</div>
      <GateBar v={props.v} gates={props.gates} />
      <div className="run-sub">Plan diff</div>
      <DiffBlock diff={m.diff} />
      <RefusalBanner outcome={props.outcome} />
      <div className="sheet-actions">
        <button type="button" className="btn btn-primary" disabled={!m.runEnabled || props.busy} title={m.runEnabled ? undefined : "The gates did not pass"} onClick={props.onRun}>
          {props.busy ? "Submitting" : "Run"}
        </button>
        <a className="btn btn-quiet" href={props.closeHref}>Close</a>
      </div>
      <p className="card-foot">Source: /api/run-plans/{m.planId} and POST /api/plans/validate</p>
    </section>
  );
}

/** Ended: the stored end time from /api/runs once the stream has ended; the stream itself carries no time. */
function endedText(v: RunView, endedAt: string | undefined): string {
  if (v.end === null) return v.streamError !== undefined ? "not reported" : "not yet";
  return endedAt ?? `Unobservable: /api/runs holds no end time for run ${v.runId} yet`;
}

export function ProgressView(props: { ws: string; view: RunView; query: Record<string, string>; cancelMsg: string | null; onCancel(): void; endedAt?: string }) {
  const v = props.view;
  return (
    <section className="card" aria-label="Run progress">
      <div className="card-title">Run <span className="mono">{v.runId}</span></div>
      {v.streamError !== undefined ? (
        <p className="unobs-text" role="status"><span className="status status-unobs">Unobservable</span> {v.streamError}</p>
      ) : null}
      <dl className="kv">
        <dt>Status</dt><dd>{v.state ?? (v.streamError !== undefined ? "not reported" : "waiting for the first event")}</dd>
        <dt>Phase</dt><dd>{v.phase ?? "none reported"}</dd>
        <dt>Ended</dt><dd className={v.end !== null && props.endedAt !== undefined ? "num" : undefined}>{endedText(v, props.endedAt)}</dd>
      </dl>
      <div className="sheet-actions">
        {cancellable(v) ? <button type="button" className="btn" onClick={props.onCancel}>Cancel</button> : null}
        {v.end === "done" ? <a className="btn btn-primary" href={resultsHref(props.ws, props.query, v.runId)}>Open results</a> : null}
        {props.cancelMsg !== null ? <span role="status">{props.cancelMsg}</span> : null}
      </div>
      {v.end !== null && v.end !== "done" ? (
        <div className="plan-banner" role="alert"><span className="status status-breach">✕ Run {v.end}</span> No result exists for a run that did not finish.</div>
      ) : null}
      {v.errors.length > 0 ? <pre className="run-log" role="alert">{v.errors.map(runErrorLine).join("\n")}</pre> : null}
      <div className="run-sub">Log</div>
      {v.log.length === 0 ? <p className="card-desc">{v.end !== null || v.streamError !== undefined ? "No log lines." : "No log lines yet."}</p> : <pre className="run-log">{v.log.join("\n")}</pre>}
      {v.stderr.length > 0 ? (<><div className="run-sub">Standard error</div><pre className="run-log">{v.stderr.join("\n")}</pre></>) : null}
      <p className="card-foot">Source: /api/runs/{v.runId}/events, forwarded as received. The server reports no completion share, so none is shown.</p>
    </section>
  );
}

/**
 * Inside a workspace a stored plan does not launch from the queue: POST /api/plans/run is blind to the workspace and
 * its lock (final review M2). The address that names a plan gets this notice in place of the confirm sheet.
 */
export function QueueLaunchNotice(props: { ws: string; planId: string }) {
  return (
    <section className="card" aria-label="Launch from Run setups" role="status">
      <p>
        A stored plan does not launch inside a workspace. Plan <span className="mono">{props.planId}</span> runs from the run setup imported from it.{" "}
        <a className="btn btn-primary" href={hrefFor({ ws: props.ws, section: "run", screen: "setups" })}>Launch from Run &gt; Run setups</a>
      </p>
    </section>
  );
}

/** The store's run plans. `launch` false (inside a workspace) drops the Run links and says the list is the whole store. */
export function PlansCard(props: { ws: string; plans: RunPlanMeta[]; query: Record<string, string>; launch?: boolean }) {
  const launch = props.launch ?? true;
  return (
    <section className="card" aria-label="Stored run plans">
      <div className="card-title">Stored run plans</div>
      {launch ? null : (
        <p className="card-desc">
          Lists every plan in the store, not only this workspace&apos;s. A plan does not launch here.{" "}
          <a className="btn btn-quiet btn-flush" href={hrefFor({ ws: props.ws, section: "run", screen: "setups" })}>Launch from Run &gt; Run setups</a>
        </p>
      )}
      {props.plans.length === 0 ? (
        <p className="unobs-text"><span className="status status-unobs">Unobservable</span> No run plan stored: /api/run-plans returned none. Run the seed to store the demo plans.</p>
      ) : (
        <ul className="run-list">
          {props.plans.map((p) => (
            <li key={p.id}>
              {launch ? <a className="btn" href={runHref(props.ws, props.query, p.id)}>Run</a> : null}
              <span className="mono">{p.id}</span>
              <span className="muted">{p.label ?? ""}{p.seeded ? " (seeded)" : ""}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="card-foot">Source: /api/run-plans</p>
    </section>
  );
}

/** Past runs; `scoped` (inside a workspace) means the rows are the workspace's attached runs only. */
export function PastRunsCard(props: { ws: string; rows: PastRunRow[]; query: Record<string, string>; scoped?: boolean }) {
  const scoped = props.scoped === true;
  return (
    <section className="card" aria-label="Past runs">
      <div className="card-title">{scoped ? "Past runs of this workspace" : "Past runs"}</div>
      {props.rows.length === 0 ? (
        <p className="card-desc">{scoped ? "No run is attached to this workspace yet; launch one from Run > Run setups." : "No runs yet, press Run."}</p>
      ) : (
        <ul className="run-list">
          {props.rows.map((r) => (
            <li key={r.runId}>
              <span className={stateClass(r.state)}>{r.state}</span>
              <span className="mono">{r.runId}</span>
              <span className="mono muted">{r.stochastic === true ? "stochastic" : r.planId ?? "no plan"}</span>
              <span className="muted">{r.label ?? ""}</span>
              <span className="num muted">{r.submittedAt}</span>
              {r.state === "done" ? <a className="btn btn-quiet btn-flush" href={resultsHref(props.ws, props.query, r.runId, r.stochastic === true)}>Results</a> : null}
              {r.state === "queued" || r.state === "running" ? <a className="btn btn-quiet btn-flush" href={progressHref(props.ws, props.query, r.runId)}>Progress</a> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="card-foot">Source: {scoped ? `/api/workspaces/${props.ws}/runs joined to /api/runs` : "/api/runs"}. The plan id is read off the run&apos;s slate name (plan-&lt;planId&gt;).</p>
    </section>
  );
}
