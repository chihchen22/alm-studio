// apps/studio/src/pages/govern/WorkspaceGovern.tsx
/**
 * Govern additions for the open workspace (spec v3.1 Section 3.1): on Lineage the clone tree, the supersede
 * link, the history and the plan of a stored run; on Approvals the workspace sign-off. Each card has a props-only view
 * that renders without a fetch, and a thin loader that reads the served routes. Records only: Studio has no sign-in,
 * so the name on a sign-off is typed and not verified.
 */
import { useState } from "react";
import type { ProvenanceRecord } from "@alm/engine";
import {
  getResultSection, getRun, listApprovals, listWorkspaceRuns, signOffWorkspace,
  type ApprovalRecord, type HistoryLine, type WorkspaceManifest,
} from "@alm/reader";
import { errText } from "../../errText";
import { hrefFor } from "../../router";
import { useLoad } from "../../useLoad";
import { historyWithCurveLabels } from "../../rows/curveSetupLabels";
import type { CurveSetupLabels } from "../../rows/workspaceRows";
import { chainStages, cloneTree, historyRows, PRODUCTION_LOCK_WARNING, signOffBlock, supersedeLinks, type CloneNode } from "../../govern/workspaceGovern";
import { deterministicRows, pickerRuns, rowText } from "../results/resultChoice";
import { setHashParam } from "../results/niiWindow";
import { runCurveValue } from "../../results/curveLine";
import "./workspaceGovern.css";

const lineageHref = (ws: string): string => hrefFor({ ws, section: "govern", screen: "lineage" });

function NodeLine(props: { node: CloneNode }) {
  const n = props.node;
  if (n.missing) return <span><span className="mono">{n.id}</span> <span className="muted">not in the store</span></span>;
  return (
    <span>
      <a href={lineageHref(n.id)}>{n.name}</a> <span className="mono muted">{n.id}</span>{" "}
      <span className="chip">{n.type}</span> <span className="muted">cut-off {n.cutoffDate}{n.status !== "active" ? `, ${n.status}` : ""}</span>
    </span>
  );
}

/** The clone tree and the supersede links of one workspace. Props only. */
export function WorkspaceLineageCard(props: { head: WorkspaceManifest; workspaces: WorkspaceManifest[] }) {
  const { head } = props;
  const tree = cloneTree(head, props.workspaces);
  const links = supersedeLinks(head, props.workspaces);
  const lin = head.lineage;
  return (
    <section className="card table-card" aria-label="Workspace lineage">
      <div className="card-title">Workspace lineage</div>
      <dl className="kv">
        <dt>Made by</dt>
        <dd>{lin.mode}{lin.fromSignedHash !== null ? <> from the sign-off at <span className="mono">{lin.fromSignedHash}</span></> : null}</dd>
        {lin.carried.length > 0 ? (<><dt>Carried blocks</dt><dd>{lin.carried.join(", ")}</dd></>) : null}
        {links.supersedes !== null ? (<><dt>Supersedes</dt><dd><a href={lineageHref(links.supersedes)}>{links.supersedes}</a></dd></>) : null}
        {links.supersededBy !== null ? (<><dt>Superseded by</dt><dd><a href={lineageHref(links.supersededBy)}>{links.supersededBy}</a></dd></>) : null}
      </dl>
      {links.pending ? <p className="card-desc" role="note">A supersede clone was created from another workspace and that workspace is not yet marked superseded; the server completes the mark at its next start.</p> : null}
      <ul className="clone-tree" aria-label="Clone tree">
        {tree.ancestors.map((n, i) => <li key={n.id} style={{ paddingLeft: `calc(var(--sp-4) * ${i})` }}><NodeLine node={n} /></li>)}
        <li key={head.id} style={{ paddingLeft: `calc(var(--sp-4) * ${tree.ancestors.length})` }} aria-current="true"><strong>{head.name}</strong> <span className="mono muted">{head.id}</span> <span className="chip">this workspace</span></li>
        {tree.descendants.map((n) => <li key={n.id} style={{ paddingLeft: `calc(var(--sp-4) * ${tree.ancestors.length + n.depth})` }}><NodeLine node={n} /></li>)}
      </ul>
      <p className="card-foot">Source: each workspace's lineage.fromWorkspaceId and lineage.supersededBy, from /api/workspaces.</p>
    </section>
  );
}

/** The history of one workspace, newest revision first. Props only. */
export function WorkspaceHistoryCard(props: { lines: HistoryLine[]; labels?: CurveSetupLabels }) {
  const rows = historyRows(props.lines, props.labels);
  const ws = props.lines[0]?.manifest.id ?? "";
  return (
    <section className="card table-card" aria-label="Workspace history">
      <div className="card-title">History</div>
      {rows.length === 0 ? <p className="unobs-text">The workspace has no history lines.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col" className="num">Revision</th><th scope="col">At (UTC)</th><th scope="col">By (typed, not verified)</th><th scope="col">Change</th><th scope="col">Signed hash</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.revision}>
                  <th scope="row" className="num">{r.revision}</th>
                  <td className="num">{r.at}</td>
                  <td>{r.by}</td>
                  <td>{r.text}{r.reconciled ? <> <span className="chip" title="Written by the server's boot reconcile, not by a request">reconciled</span></> : null}</td>
                  <td className="mono">{r.signedHash.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot">Source: /api/workspaces/{ws}/history, one line per revision.</p>
    </section>
  );
}

export function WorkspaceHistory(props: { ws: string }) {
  const load = useLoad(() => historyWithCurveLabels(props.ws), [props.ws]);
  if (load.state === "loading") return <div className="card muted">Reading the history of {props.ws}</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <WorkspaceHistoryCard lines={load.value.lines} labels={load.value.labels} />;
}

/**
 * The plan identity of a stored run, read from its result provenance, with the stages that resolved a plugin in the
 * run log. The stored plan document itself is part of the run's request record, which no route serves, so the
 * compiled stage list is read from what the run recorded of its own execution. `curve` is the curve the run built on,
 * the server's words from the run detail; the row is left out when it was not read.
 */
export function RunPlanView(props: { runId: string; basisLabel: string | null; provenance: ProvenanceRecord; curve?: string }) {
  const p = props.provenance;
  const stages = chainStages(p.runLog as ReadonlyArray<{ t: string; scope?: { stageId?: string } }> | undefined);
  return (
    <>
      <dl className="kv">
        <dt>Run</dt><dd className="mono">{props.runId}</dd>
        <dt>Basis</dt><dd>{props.basisLabel ?? "not recorded"}</dd>
        {props.curve !== undefined ? <><dt>Curve</dt><dd>{props.curve}</dd></> : null}
        <dt>Plan id</dt><dd className="mono">{p.planId ?? "none: the run was not submitted from a plan"}</dd>
        <dt>Plan hash</dt><dd className="mono">{p.planHash ?? "not recorded"}</dd>
        <dt>Routing policy hash</dt><dd className="mono">{p.policyHash ?? "not recorded"}</dd>
        <dt>Balance plan hash</dt><dd className="mono">{p.balancePlanHash ?? "none"}</dd>
        {p.scenarioBalancePlanHashes !== undefined
          ? Object.entries(p.scenarioBalancePlanHashes).map(([id, h]) => (<span key={id} style={{ display: "contents" }}><dt>Balance plan hash, {id}</dt><dd className="mono">{h}</dd></span>))
          : null}
        <dt>Profile hash</dt><dd className="mono">{p.profileHash ?? "not recorded"}</dd>
      </dl>
      {stages.length === 0
        ? <p className="card-desc">The run log names no stage: a run submitted before plans recorded their log carries none.</p>
        : <p className="card-desc">Stages that resolved a plugin, in the order the run log first names them: {stages.map((s, i) => <span key={s}>{i > 0 ? " " : ""}<span className="chip mono">{s}</span></span>)}</p>}
    </>
  );
}

/** Lists the workspace's done runs and shows the plan of the one in `?chain=` (the newest by default). */
export function RunPlanCard(props: { ws: string; query: Record<string, string> }) {
  const load = useLoad(() => listWorkspaceRuns(props.ws), [props.ws]);
  // A stochastic run records no plan and serves no deterministic provenance; it is left out, said below.
  const runs = load.state === "ok" ? pickerRuns(deterministicRows(load.value), {}, null) : [];
  const stochasticCount = load.state === "ok" ? load.value.filter((r) => r.mode === "stochastic").length : 0;
  const picked = runs.find((r) => r.runId === props.query.chain) ?? runs[0] ?? null;
  // The provenance section and the run detail's curve line side by side; a detail that cannot be read says so in the row.
  const prov = useLoad(
    () => (picked === null ? Promise.resolve(null) : Promise.all([
      getResultSection(picked.runId, "provenance"),
      getRun(picked.runId).then(runCurveValue, (e: unknown) => `not read: ${errText(e)}`),
    ]).then(([provenance, curve]) => ({ provenance, curve }))),
    [picked?.runId ?? ""],
  );
  if (load.state === "loading") return <div className="card muted">Reading the runs of {props.ws}</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return (
    <section className="card table-card" aria-label="Plan of a stored run">
      <div className="card-title">Plan of a stored run</div>
      {stochasticCount > 0 ? <p className="card-desc">{`${stochasticCount} stochastic run${stochasticCount === 1 ? " is" : "s are"} left out: a stochastic run records no plan. Its model, fit and options are on Results > Stochastic distributions.`}</p> : null}
      {picked === null ? <p className="unobs-text">This workspace holds no done deterministic run.</p> : (
        <>
          <label className="field">
            <span className="field-label">Run</span>
            <select aria-label="Run" value={picked.runId} onChange={(e) => setHashParam("chain", e.target.value)}>
              {runs.map((r) => <option key={r.runId} value={r.runId}>{rowText(r)}</option>)}
            </select>
          </label>
          {prov.state === "loading" ? <p className="muted">Reading the provenance of {picked.runId}</p> : null}
          {prov.state === "error" ? <p role="alert">{errText(prov.error)}</p> : null}
          {prov.state === "ok" && prov.value !== null ? <RunPlanView runId={picked.runId} basisLabel={picked.basisLabel} provenance={prov.value.provenance} curve={prov.value.curve} /> : null}
        </>
      )}
      <p className="card-foot">Source: /api/workspaces/{props.ws}/runs, /api/runs/:id/result/provenance, and the curve line of /api/runs/:id.</p>
    </section>
  );
}

// --- Approvals: the workspace sign-off -----------------------------------------------------------------------------

export interface WorkspaceSignOffViewProps {
  head: WorkspaceManifest;
  by: string;
  note: string;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onBy: (v: string) => void;
  onNote: (v: string) => void;
  onSign: () => void;
}

const BLOCK_REASON_ID = "ws-signoff-block-reason";

/** The sign-off form with the hash it will bind. Props only. */
export function WorkspaceSignOffView(props: WorkspaceSignOffViewProps) {
  const { head } = props;
  const block = signOffBlock(head, props.by);
  const blocked = block !== null || props.busy;
  return (
    <section className="card" aria-label="Workspace sign-off">
      <div className="card-title">Sign off this workspace</div>
      <p className="card-desc">A sign-off is a record that binds to the workspace's signedHash, which covers its type, cut-off date and every block. If a block moves afterwards the record no longer matches the workspace.</p>
      <dl className="kv">
        <dt>Workspace</dt><dd>{head.name} <span className="mono muted">{head.id}</span></dd>
        <dt>Type</dt><dd>{head.type}</dd>
        <dt>Cut-off date</dt><dd>{head.cutoffDate}</dd>
        <dt>Revision</dt><dd className="num">{head.revision}</dd>
        <dt>Current signedHash</dt><dd className="mono">{head.signedHash}</dd>
      </dl>
      {head.type === "production" ? <p className="card-desc" role="note">{PRODUCTION_LOCK_WARNING}</p> : null}
      {head.lock !== null ? (
        <p className="card-desc" role="status">
          Locked at {head.lock.lockedAt} by {head.lock.by} (typed, not verified), approval <span className="mono">{head.lock.approvalId}</span>, signedHash <span className="mono">{head.lock.signedHash}</span>.
        </p>
      ) : null}
      <label className="field">
        <span className="field-label">Signed by (typed, not verified)</span>
        <input className="input input-text" type="text" value={props.by} maxLength={80} autoComplete="off" onChange={(e) => props.onBy(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Note (optional)</span>
        <input className="input input-text" type="text" value={props.note} maxLength={500} autoComplete="off" onChange={(e) => props.onNote(e.target.value)} />
      </label>
      <div role="group" aria-label="Sign off">
        <button type="button" className="btn btn-primary" aria-disabled={blocked ? true : undefined} aria-describedby={block !== null ? BLOCK_REASON_ID : undefined} onClick={blocked ? undefined : props.onSign}>Sign off</button>
      </div>
      {block !== null ? <p className="muted" id={BLOCK_REASON_ID}>{block}</p> : null}
      {props.error !== null ? <p className="card-desc" role="alert">{props.error}</p> : null}
      {props.notice !== null ? <p className="card-desc" role="status">{props.notice}</p> : null}
    </section>
  );
}

/** The sign-off records written for this workspace, each against the hash the workspace holds now. Props only. */
export function WorkspaceSignOffRecords(props: { records: ApprovalRecord[]; signedHash: string }) {
  if (props.records.length === 0) return <p className="muted">No sign-off has been recorded for this workspace.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th scope="col">Recorded at (UTC)</th><th scope="col">Signed by (typed, not verified)</th><th scope="col">Bound hash</th><th scope="col">Against the workspace now</th><th scope="col">Note</th></tr></thead>
        <tbody>
          {[...props.records].reverse().map((r) => (
            <tr key={r.id}>
              <td className="num">{r.at}<br /><span className="mono">{r.id}</span></td>
              <td>{r.by}</td>
              <td className="mono">{r.artifactContentHash}</td>
              <td>{r.artifactContentHash === props.signedHash ? <span className="status status-pass">current</span> : <span className="status status-stale">workspace has changed since</span>}</td>
              <td>{r.note === "" ? <span className="muted">No note</span> : r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WorkspaceSignOffCard(props: { head: WorkspaceManifest; onSigned?: () => void }) {
  const { head } = props;
  const [by, setBy] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const records = useLoad(() => listApprovals(), [reload, head.revision]);
  const mine = records.state === "ok"
    ? records.value.filter((r) => (r.artifactCollection as string) === "workspaces" && r.artifactId === head.id)
    : [];

  function sign() {
    setBusy(true);
    setError(null);
    setNotice(null);
    signOffWorkspace(head.id, { expectedRevision: head.revision, by: by.trim(), ...(note.trim() !== "" ? { note } : {}), signedHash: head.signedHash }).then(
      () => { setNotice(`Signed off at ${head.signedHash.slice(0, 12)}.`); setNote(""); props.onSigned?.(); },
      (e: unknown) => { setError(errText(e)); },
    ).finally(() => { setBusy(false); setReload((n) => n + 1); });
  }

  return (
    <>
      <WorkspaceSignOffView head={head} by={by} note={note} busy={busy} error={error} notice={notice} onBy={setBy} onNote={setNote} onSign={sign} />
      <section className="card table-card" aria-label="Workspace sign-off records">
        <div className="card-title">Sign-off records for this workspace</div>
        {records.state === "loading" ? <p className="muted">Reading the records</p> : null}
        {records.state === "error" ? <p className="card-desc" role="alert">{errText(records.error)}</p> : null}
        {records.state === "ok" ? <WorkspaceSignOffRecords records={mine} signedHash={head.signedHash} /> : null}
        <p className="card-foot">Source: /api/approvals, records with artifactCollection workspaces.</p>
      </section>
    </>
  );
}
