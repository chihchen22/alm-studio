// apps/studio/src/pages/workspace/OverviewPage.tsx
/**
 * Workspace > Overview (spec v3.1 Sections 3.1 and 3.6 step 3). The manifest, what each block pins, the
 * readiness checklist with its six states, the next-step button, the history, and the clone and archive actions.
 *
 * Sign-off lives on Govern > Approvals; a Production workspace's card here says what it does (it locks, for good) and
 * links there. A locked month has no way back: the correction is a clone typed Production that supersedes it
 * (rulings 7, 13 and 14), so this page carries no control that changes a lock.
 */
import { useState } from "react";
import {
  archiveWorkspace,
  type HistoryLine,
  type ReadinessReport,
  type WorkspaceManifest,
} from "@alm/reader";
import { errText } from "../../errText";
import { hrefFor, SECTIONS } from "../../router";
import { blockSummary, cloneFormFor, describeChange, nextStep, statusLabel, type CurveSetupLabels } from "../../rows/workspaceRows";
import { historyWithCurveLabels } from "../../rows/curveSetupLabels";
import { ReadinessChip } from "../../shell/ReadinessChip";
import { TYPE_LABEL, TypeBadge } from "../../shell/WorkspaceSwitcher";
import { useLoad } from "../../useLoad";
import { ByField, WorkspaceFormCard, useBy } from "./wsCommon";

type CloneMode = "copy" | "roll-forward" | "correct";

const sectionLabel = (id: string): string => SECTIONS.find((s) => s.id === id)?.label ?? id;

function lineageText(head: WorkspaceManifest): string {
  const l = head.lineage;
  const from = l.fromWorkspaceId ?? "an earlier workspace";
  switch (l.mode) {
    case "blank": return "Created blank";
    case "seed": return "Derived from the store by the seed";
    case "copy": return `Copy of ${from}`;
    case "roll-forward": return `Rolled forward from ${from}`;
    case "supersede": return `Correction of ${from}`;
  }
}

function ManifestCard(props: { head: WorkspaceManifest }) {
  const { head } = props;
  return (
    <section className="card" aria-label="Manifest">
      <div className="card-title">Manifest</div>
      <dl className="kv">
        <dt>Name</dt><dd>{head.name}</dd>
        <dt>Id</dt><dd className="mono">{head.id}</dd>
        <dt>Type</dt><dd><TypeBadge type={head.type} /></dd>
        <dt>Status</dt><dd>{statusLabel(head.status)}</dd>
        <dt>Cut-off date</dt><dd className="num">{head.cutoffDate}</dd>
        <dt>Owner</dt><dd>{head.owner}</dd>
        <dt>Revision</dt><dd className="num">{head.revision}</dd>
        <dt>Created at</dt><dd className="mono">{head.createdAt}</dd>
        <dt>Updated at</dt><dd className="mono">{head.updatedAt}</dd>
        <dt>Started from</dt><dd>{lineageText(head)}</dd>
        <dt>Signed hash</dt><dd className="mono ws-hash">{head.signedHash}</dd>
        {head.note !== "" ? <><dt>Note</dt><dd>{head.note}</dd></> : null}
      </dl>
      <p className="card-foot">The cut-off date is fixed at creation; a different date is a roll-forward into a new workspace.</p>
      {head.clashes.length > 0 ? (
        <div className="ws-clashes" role="note">
          <p className="card-desc">Cut-off clashes recorded on this {TYPE_LABEL[head.type]} workspace:</p>
          <ul className="list">
            {head.clashes.map((c, i) => (
              <li key={i}><span>{c.block} <span className="mono">{c.id}</span> is dated {c.documentAsOf}, recorded {c.recordedAt}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function BlocksCard(props: { head: WorkspaceManifest }) {
  const rows = blockSummary(props.head);
  return (
    <section className="card table-card" aria-label="What this workspace pins">
      <div className="card-title">What this workspace pins</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Block</th><th scope="col">Pinned</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.block}>
                <td><a href={hrefFor({ ws: props.head.id, section: r.section, screen: r.screen })}>{r.label}</a></td>
                <td className="words">{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReadinessCard(props: { head: WorkspaceManifest; readiness: ReadinessReport | null }) {
  const { readiness } = props;
  if (readiness === null) {
    return (
      <section className="card unobs-panel" aria-label="Readiness">
        <div className="card-title">Readiness</div>
        <p className="unobs-text">Readiness could not be read. The manifest above is the head as stored.</p>
      </section>
    );
  }
  const slots = Object.entries(readiness.launchable);
  return (
    <section className="card table-card" aria-label="Readiness">
      <div className="card-title">Readiness</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th scope="col">Section</th><th scope="col">Item</th><th scope="col">State</th><th scope="col">Needed to launch</th><th scope="col">Detail</th></tr>
          </thead>
          <tbody>
            {readiness.items.map((i, n) => (
              <tr key={`${i.section}/${i.item}/${n}`}>
                <td>{sectionLabel(i.section)}</td>
                <td>{i.item}</td>
                <td><ReadinessChip state={i.state} /></td>
                <td>{i.required ? "Required" : "Optional"}</td>
                <td className="words ws-detail">
                  {i.detail}
                  {i.staleRoles !== undefined && i.staleRoles.length > 0 ? (
                    <ul className="ws-stale-roles">
                      {i.staleRoles.map((s) => (
                        <li key={s.role}><span className="mono">{s.role}</span> was pinned at {s.pinned.slice(0, 12)}, is now {s.current === null ? "empty" : s.current.slice(0, 12)}</li>
                      ))}
                    </ul>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {slots.length > 0 ? (
        <ul className="list ws-launch-gate" aria-label="Launch gate">
          {slots.map(([slot, g]) => (
            <li key={slot}>
              <span className="mono">{slot}</span>
              <span>
                {g.ok ? "Ready to launch" : `Blocked by ${g.blocking.join(", ")}`}
                {g.acknowledgeable.length > 0 ? `; acknowledge ${g.acknowledgeable.join(", ")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="card-foot">Source: GET /api/workspaces/{props.head.id}/readiness</p>
    </section>
  );
}

function NextStepCard(props: { head: WorkspaceManifest; readiness: ReadinessReport | null }) {
  const { head, readiness } = props;
  if (readiness === null || head.status !== "active") return null;
  const step = nextStep(readiness);
  return (
    <section className="card" aria-label="Next step">
      <div className="card-title">Next step</div>
      <p className="card-desc">The first requirement still open for a first run, in the order positions, base snapshot, assumption set, routing policy, run setup.</p>
      <p><a className="btn btn-primary" href={hrefFor({ ws: head.id, section: step.section, screen: step.screen, query: step.query })}>{step.label}</a></p>
    </section>
  );
}

/** The Production sign-off card: what sign-off does, or the state a locked month is in and the way to correct it. */
function SignOffCard(props: { head: WorkspaceManifest; onClone: (m: CloneMode) => void }) {
  const { head } = props;
  if (head.type !== "production") return null;
  const approvals = hrefFor({ ws: head.id, section: "govern", screen: "approvals" });
  if (head.lock !== null) {
    return (
      <section className="card" aria-label="Sign-off">
        <div className="card-title">Sign-off</div>
        <p className="card-desc">
          This month is locked. It was signed off at <span className="mono">{head.lock.lockedAt}</span> by {head.lock.by} (typed, not verified) on
          approval <span className="mono">{head.lock.approvalId}</span>. It accepts no block change, import or launch, and the lock is permanent.
        </p>
        <p className="card-desc">
          To correct it, clone it as Production: the clone is a new month at the same cut-off date, and creating it marks this workspace superseded,
          with the lineage recorded. This workspace keeps its approval and stays readable.
        </p>
        {head.status === "locked" ? (
          <p><button type="button" className="btn btn-primary" onClick={() => props.onClone("correct")}>Clone to correct</button></p>
        ) : null}
      </section>
    );
  }
  if (head.status === "active") {
    return (
      <section className="card" aria-label="Sign-off">
        <div className="card-title">Sign-off</div>
        <p className="card-desc">
          Signing off a Production month locks the workspace: afterwards no block, import or launch changes it, and the lock is permanent. A later
          correction is a clone typed Production that supersedes this month.
        </p>
        <p><a className="btn" href={approvals}>Sign off on Govern, Approvals</a></p>
      </section>
    );
  }
  return (
    <section className="card" aria-label="Sign-off">
      <div className="card-title">Sign-off</div>
      <p className="card-desc">This Production month is {statusLabel(head.status).toLowerCase()} and takes no sign-off.</p>
    </section>
  );
}

function ArchiveAction(props: { head: WorkspaceManifest; onChanged: () => void }) {
  const { head } = props;
  const [by, setBy] = useBy();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (head.status !== "active" && head.status !== "locked") return null;
  function archive() {
    if (by.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    archiveWorkspace(head.id, { expectedRevision: head.revision, by: by.trim() }).then(
      () => { setConfirming(false); props.onChanged(); },
      (e: unknown) => { setError(errText(e)); },
    ).finally(() => setBusy(false));
  }
  if (!confirming) {
    return <button type="button" className="btn" onClick={() => setConfirming(true)}>Archive workspace</button>;
  }
  return (
    <div className="ws-confirm" role="group" aria-label="Confirm archive">
      <p className="card-desc">An archived workspace stays readable and refuses every change and launch. There is no way to reopen it in this version.</p>
      <ByField value={by} onChange={setBy} />
      <div className="ws-actions">
        <button type="button" className="btn btn-primary" aria-disabled={by.trim() === "" || busy ? true : undefined} onClick={archive}>Confirm archive</button>
        <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
      {error !== null ? <p className="card-desc" role="alert">{error}</p> : null}
    </div>
  );
}

const CLONE_TITLE: Record<CloneMode, string> = {
  copy: "Clone this workspace",
  "roll-forward": "Roll this workspace forward",
  correct: "Clone to correct this Production month",
};

function ActionsCard(props: {
  head: WorkspaceManifest;
  workspaces: WorkspaceManifest[];
  open: CloneMode | null;
  onOpen: (m: CloneMode | null) => void;
  onChanged: () => void;
  today: Date;
}) {
  const { head, open } = props;
  const canCorrect = head.type === "production" && (head.status === "active" || head.status === "locked");
  return (
    <>
      <section className="card" aria-label="Clone and archive">
        <div className="card-title">Clone and archive</div>
        <p className="card-desc">A clone is how a workspace changes after the fact: nothing here edits a signed month in place.</p>
        <div className="ws-actions">
          <button type="button" className="btn" aria-pressed={open === "copy" ? true : undefined} onClick={() => props.onOpen(open === "copy" ? null : "copy")}>Copy</button>
          <button type="button" className="btn" aria-pressed={open === "roll-forward" ? true : undefined} onClick={() => props.onOpen(open === "roll-forward" ? null : "roll-forward")}>Roll forward</button>
          {canCorrect ? (
            <button type="button" className="btn" aria-pressed={open === "correct" ? true : undefined} onClick={() => props.onOpen(open === "correct" ? null : "correct")}>Clone to correct</button>
          ) : null}
          <ArchiveAction head={head} onChanged={props.onChanged} />
        </div>
      </section>
      {open !== null ? (
        <WorkspaceFormCard
          key={open}
          title={CLONE_TITLE[open]}
          submitLabel="Create clone"
          initial={cloneFormFor(head, open)}
          workspaces={props.workspaces}
          fixedSource={head}
          today={props.today}
          onDone={() => { props.onOpen(null); props.onChanged(); }}
        />
      ) : null}
    </>
  );
}

function HistoryCard(props: { history: HistoryLine[] | null | undefined; error?: string | null; labels?: CurveSetupLabels }) {
  const { history } = props;
  return (
    <section className="card table-card" aria-label="History">
      <div className="card-title">History</div>
      {props.error !== undefined && props.error !== null ? <p className="card-desc" role="alert">{props.error}</p> : null}
      {(history === null || history === undefined) && (props.error === undefined || props.error === null) ? <p className="muted">Reading the history</p> : null}
      {history !== null && history !== undefined && history.length === 0 ? <p className="muted">No history line is stored.</p> : null}
      {history !== null && history !== undefined && history.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col" className="num">Revision</th><th scope="col">At (UTC)</th><th scope="col">By (typed, not verified)</th><th scope="col">Change</th></tr></thead>
            <tbody>
              {[...history].sort((x, y) => y.revision - x.revision).map((h) => (
                <tr key={h.revision}>
                  <td className="num">{h.revision}</td>
                  <td className="mono">{h.at}</td>
                  <td>{h.by}</td>
                  <td className="words">{describeChange(h.change, props.labels, h.by)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="card-foot">Source: GET /api/workspaces/{"{id}"}/history</p>
    </section>
  );
}

/** Props only. `history` is null while it reads; `onChanged` is what a write calls so App rereads the head. */
export function OverviewView(props: {
  head: WorkspaceManifest;
  readiness: ReadinessReport | null;
  history?: HistoryLine[] | null;
  historyError?: string | null;
  /** Curve setup labels by document id, so a history line names a setup by its label (the id when none is known). */
  curveLabels?: CurveSetupLabels;
  workspaces?: WorkspaceManifest[];
  onChanged?: () => void;
  today?: Date;
}) {
  const { head } = props;
  const [open, setOpen] = useState<CloneMode | null>(null);
  const onChanged = props.onChanged ?? (() => {});
  return (
    <>
      {head.status === "superseded" ? (
        <section className="card ws-banner" role="note" aria-label="Superseded">
          <p className="card-desc">
            This month was superseded
            {head.lineage.supersededBy !== null ? <> by <a href={hrefFor({ ws: head.lineage.supersededBy, section: "workspace", screen: "overview" })}>{head.lineage.supersededBy}</a></> : null}
            . It stays readable and refuses every change and launch.
          </p>
        </section>
      ) : null}
      <NextStepCard head={head} readiness={props.readiness} />
      <ManifestCard head={head} />
      <BlocksCard head={head} />
      <ReadinessCard head={head} readiness={props.readiness} />
      <SignOffCard head={head} onClone={(m) => setOpen(m)} />
      <ActionsCard head={head} workspaces={props.workspaces ?? []} open={open} onOpen={setOpen} onChanged={onChanged} today={props.today ?? new Date()} />
      <HistoryCard history={props.history} error={props.historyError ?? null} labels={props.curveLabels} />
    </>
  );
}

/** The route: the head and its readiness from App, the history read here. */
export function OverviewPage(props: {
  head: WorkspaceManifest | null;
  readiness: ReadinessReport | null;
  workspaces: WorkspaceManifest[];
  refresh: () => void;
}) {
  const { head } = props;
  const history = useLoad(
    () => (head === null ? Promise.resolve({ lines: [] as HistoryLine[], labels: new Map<string, string>() as CurveSetupLabels }) : historyWithCurveLabels(head.id)),
    [head?.id ?? "", head?.revision ?? 0],
  );
  if (head === null) return <div className="card muted">No workspace is open.</div>;
  return (
    <OverviewView
      head={head}
      readiness={props.readiness}
      history={history.state === "ok" ? history.value.lines : null}
      curveLabels={history.state === "ok" ? history.value.labels : undefined}
      historyError={history.state === "error" ? errText(history.error) : null}
      workspaces={props.workspaces}
      onChanged={props.refresh}
    />
  );
}
