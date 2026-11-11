// apps/studio/src/pages/controls/ApprovalsPage.tsx
/**
 * Govern > Controls > Approvals and sign-off (Controls 2, approvals). Lists every stored approval record from
 * GET /api/approvals, newest first, and holds a small form that appends one: choose an artifact (a finished run, a run
 * plan or an assumption set), read its status, type a name and press Record approval or Record revocation.
 *
 * Records only. Studio has no sign-in, so the name on a record is typed by whoever records it and is not verified; a
 * record gates no run and edits nothing, and a record is never edited or removed (a revocation is a new record). The
 * content hash a record binds to is taken from GET /api/approvals/status, never from a listing: the assumption-set
 * listing's contentHash is the engine's bindings hash, which the server refuses.
 */
import { useState } from "react";
import {
  getApprovalStatus, listApprovals, listAssumptionSets, listRunPlans, listRuns, recordApproval,
  type ApprovalDecision, type ApprovalRecord, type ApprovalStatus, type ApprovalTarget,
} from "@alm/reader";
import type { WorkspaceManifest } from "@alm/reader";
import { errText } from "../../errText";
import { WorkspaceSignOffCard } from "../govern/WorkspaceGovern";
import { useLoad } from "../../useLoad";
import { TARGET_LABEL, recordBlock, recordRows, stateLine, type ApprovalForm } from "../../controls/approvalsModel";

const TARGETS: ApprovalTarget[] = ["runs", "run-plans", "assumption-sets"];
const REASON_ID = "approvals-block-reason";
const REVOKE_REASON_ID = "approvals-revoke-reason";

export interface ApprovalsViewProps {
  /** null while reading or after a failed read. */
  records: ApprovalRecord[] | null;
  recordsError: string | null;
  form: ApprovalForm;
  /** Ids of the chosen target's artifacts; null while reading or after a failed read. */
  ids: string[] | null;
  idsError: string | null;
  /** null while reading, with no artifact chosen, or after a failed read. */
  status: ApprovalStatus | null;
  statusError: string | null;
  busy: boolean;
  actionError: string | null;
  notice: string | null;
  onTarget: (t: ApprovalTarget) => void;
  onArtifact: (id: string) => void;
  onBy: (v: string) => void;
  onNote: (v: string) => void;
  onRecord: (d: ApprovalDecision) => void;
}

function StatusPanel(props: { status: ApprovalStatus | null; error: string | null; chosen: boolean }) {
  const { status, error, chosen } = props;
  if (error !== null) return <p className="card-desc" role="alert">{error}</p>;
  if (!chosen) return <p className="muted">Choose an artifact to read its status.</p>;
  if (status === null) return <p className="muted">Reading the artifact status</p>;
  const line = stateLine(status);
  const l = status.latest;
  return (
    <div role="status" aria-label="Artifact status">
      <p className="card-desc">Current content hash <span className="mono">{status.currentContentHash}</span></p>
      <p className="card-desc"><span className={line.cls}>{line.text}</span></p>
      {l !== null && status.state !== "none"
        ? <p className="card-foot">Latest record {l.at}, recorded by {l.by} (typed, not verified).</p>
        : null}
    </div>
  );
}

/** The records and the form. Props only. */
export function ApprovalsView(props: ApprovalsViewProps) {
  const { form, status } = props;
  const approveBlock = recordBlock(form, props.statusError !== null ? null : status, "approved");
  const revokeBlock = recordBlock(form, props.statusError !== null ? null : status, "revoked");
  const rows = props.records !== null ? recordRows(props.records) : [];
  const sameReason = approveBlock !== null && approveBlock === revokeBlock;
  const approveDesc = approveBlock !== null ? REASON_ID : undefined;
  const revokeDesc = revokeBlock !== null ? (sameReason ? REASON_ID : REVOKE_REASON_ID) : undefined;
  return (
    <>
      <section className="card" aria-label="About these records">
        <p className="card-desc">Studio has no sign-in, so the name on a record is typed by whoever records it and Studio does not check it.</p>
        <p className="card-desc">A record gates nothing: plans, sets and runs work the same with or without one.</p>
        <p className="card-desc">Records are append-only: a revocation is a new record, and no record is edited or removed.</p>
        <p className="card-foot">Source: /api/approvals</p>
      </section>

      <section className="card" aria-label="Record an approval">
        <div className="card-title">Record an approval or a revocation</div>
        <label className="field">
          <span className="field-label">Artifact type</span>
          <select aria-label="Artifact type" value={form.target} onChange={(e) => props.onTarget(e.target.value as ApprovalTarget)}>
            {TARGETS.map((t) => <option key={t} value={t}>{TARGET_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Artifact</span>
          <select aria-label="Artifact" value={form.artifactId} onChange={(e) => props.onArtifact(e.target.value)}>
            <option value="">{props.ids === null ? "Reading the artifacts" : "Choose an artifact"}</option>
            {(props.ids ?? []).map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        {props.idsError !== null ? <p className="card-desc" role="alert">{props.idsError}</p> : null}
        <StatusPanel status={status} error={props.statusError} chosen={form.artifactId !== ""} />
        <label className="field">
          <span className="field-label">Recorded by (typed, not verified)</span>
          <input className="input input-text" type="text" value={form.by} maxLength={80} autoComplete="off" onChange={(e) => props.onBy(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Note (optional)</span>
          <input className="input input-text" type="text" value={form.note} maxLength={500} autoComplete="off" onChange={(e) => props.onNote(e.target.value)} />
        </label>
        {/* Off by aria-disabled, not disabled, so a focused button keeps focus (the Polish 1 rule). */}
        <div role="group" aria-label="Record">
          <button type="button" className="btn btn-primary" aria-disabled={approveBlock !== null || props.busy ? true : undefined} aria-describedby={approveDesc}
            onClick={approveBlock !== null || props.busy ? undefined : () => props.onRecord("approved")}>Record approval</button>
          <button type="button" className="btn" aria-disabled={revokeBlock !== null || props.busy ? true : undefined} aria-describedby={revokeDesc}
            onClick={revokeBlock !== null || props.busy ? undefined : () => props.onRecord("revoked")}>Record revocation</button>
        </div>
        {approveBlock !== null ? <p className="muted" id={REASON_ID}>{approveBlock}</p> : null}
        {revokeBlock !== null && !sameReason ? <p className="muted" id={REVOKE_REASON_ID}>{revokeBlock}</p> : null}
        {props.actionError !== null ? <p className="card-desc" role="alert">{props.actionError}</p> : null}
        {props.notice !== null ? <p className="card-desc" role="status">{props.notice}</p> : null}
      </section>

      <section className="card table-card" aria-label="Approval records">
        <div className="card-title">Records</div>
        {props.recordsError !== null ? <p className="card-desc" role="alert">{props.recordsError}</p> : null}
        {props.records === null && props.recordsError === null ? <p className="muted">Reading the records</p> : null}
        {props.records !== null && rows.length === 0 ? <p className="muted">No approval record has been written yet.</p> : null}
        {rows.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th scope="col">Recorded at (UTC)</th><th scope="col">Decision</th><th scope="col">Artifact</th>
                <th scope="col">Content hash</th><th scope="col">Recorded by (typed, not verified)</th><th scope="col">Note</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.at}<br /><span className="mono">{r.id}</span></td>
                    <td><span className={r.statusClass}>{r.decisionText}</span></td>
                    <td>{r.artifactText}</td>
                    <td className="mono">{r.hash}</td>
                    <td>{r.by}</td>
                    <td>{r.note === "" ? <span className="muted">No note</span> : r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}

/** The ids of the chosen target's artifacts: finished runs, stored run plans, stored assumption sets. Ids only. */
async function loadIds(target: ApprovalTarget): Promise<string[]> {
  if (target === "runs") return (await listRuns()).filter((r) => r.state === "done").map((r) => r.runId);
  if (target === "run-plans") return (await listRunPlans()).map((p) => p.id);
  return (await listAssumptionSets()).map((s) => s.id);
}

/** `head` puts the open workspace's sign-off above the artifact records; `onSigned` rereads the head. */
export function ApprovalsPage(props: { head?: WorkspaceManifest | null; onSigned?: () => void } = {}) {
  const [form, setForm] = useState<ApprovalForm>({ target: "runs", artifactId: "", by: "", note: "" });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const records = useLoad(() => listApprovals(), [reload]);
  const ids = useLoad(() => loadIds(form.target), [form.target, reload]);
  const status = useLoad(
    () => (form.artifactId === "" ? Promise.resolve(null) : getApprovalStatus(form.target, form.artifactId)),
    [form.target, form.artifactId, reload],
  );

  function record(decision: ApprovalDecision) {
    if (status.state !== "ok" || status.value === null) return;
    const hash = status.value.currentContentHash;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    recordApproval({
      artifactCollection: form.target,
      artifactId: form.artifactId,
      artifactContentHash: hash,
      decision,
      by: form.by,
      ...(form.note.trim() !== "" ? { note: form.note } : {}),
    }).then(
      (rec) => { setNotice(`Recorded ${rec.decision} as ${rec.id}.`); setForm((f) => ({ ...f, note: "" })); },
      (e: unknown) => { setActionError(errText(e)); },
    ).finally(() => { setBusy(false); setReload((n) => n + 1); });
  }

  return (
    <>
    {props.head === undefined || props.head === null ? null : <WorkspaceSignOffCard head={props.head} {...(props.onSigned === undefined ? {} : { onSigned: props.onSigned })} />}
    <ApprovalsView
      records={records.state === "ok" ? records.value : null}
      recordsError={records.state === "error" ? errText(records.error) : null}
      form={form}
      ids={ids.state === "ok" ? ids.value : null}
      idsError={ids.state === "error" ? errText(ids.error) : null}
      status={status.state === "ok" ? status.value : null}
      statusError={status.state === "error" ? errText(status.error) : null}
      busy={busy}
      actionError={actionError}
      notice={notice}
      onTarget={(t) => { setForm((f) => ({ ...f, target: t, artifactId: "" })); setActionError(null); setNotice(null); }}
      onArtifact={(id) => { setForm((f) => ({ ...f, artifactId: id })); setActionError(null); setNotice(null); }}
      onBy={(by) => setForm((f) => ({ ...f, by }))}
      onNote={(note) => setForm((f) => ({ ...f, note }))}
      onRecord={record}
    />
    </>
  );
}
