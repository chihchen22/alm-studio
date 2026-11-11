// apps/studio/src/pages/workspace/ComparePage.tsx
/**
 * Compare workspaces (spec v3.1 Section 2.4 Compare). Two workspaces, one verdict per block read from the
 * stored block hashes (`same`, `changed`, `only in A`, `only in B`), the two entry lists side by side for a changed
 * block, and the drill links: the default sets' diff, each side's Rate indices, and Results > Compare of the newest
 * done run on each side. The page computes nothing; every verdict is the server's.
 *
 * The export is WorkspaceComparePage: Results > Compare already owns the name ComparePage.
 */
import {
  compareWorkspaces,
  listWorkspaceRuns,
  type WorkspaceCompareReply,
  type WorkspaceCompareSide,
  type WorkspaceManifest,
  type WorkspaceRunRow,
} from "@alm/reader";
import { errText } from "../../errText";
import { compareHref } from "../../router";
import { compareRows } from "../../rows/workspaceRows";
import { TYPE_LABEL } from "../../shell/WorkspaceSwitcher";
import { useLoad } from "../../useLoad";
import "./wsCommon";

function Picker(props: { label: string; value: string; workspaces: WorkspaceManifest[]; onPick: (id: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select className="input" aria-label={props.label} value={props.value} onChange={(e) => props.onPick(e.target.value)}>
        <option value="">Choose a workspace</option>
        {props.workspaces.map((w) => <option key={w.id} value={w.id}>{`${w.name} (${TYPE_LABEL[w.type]}, cut-off ${w.cutoffDate})`}</option>)}
      </select>
    </label>
  );
}

function SideCard(props: { which: "A" | "B"; side: WorkspaceCompareSide }) {
  const { side } = props;
  return (
    <section className="card" aria-label={`Workspace ${props.which}`}>
      <div className="card-title">Workspace {props.which}: {side.name}</div>
      <dl className="kv kv-stack">
        <dt>Id</dt><dd className="mono">{side.id}</dd>
        <dt>Type</dt><dd>{TYPE_LABEL[side.type]}</dd>
        <dt>Status</dt><dd>{side.status}</dd>
        <dt>Cut-off date</dt><dd className="num">{side.cutoffDate}</dd>
        <dt>Revision</dt><dd className="num">{side.revision}</dd>
        <dt>Signed hash</dt><dd className="mono ws-hash">{side.signedHash}</dd>
      </dl>
    </section>
  );
}

/** Props only. `reply` is null until a pair is chosen; `newestDone` holds the newest done run id on each side, or null. */
export function WorkspaceCompareView(props: {
  reply: WorkspaceCompareReply | null;
  workspaces: WorkspaceManifest[];
  newestDone: { a: string | null; b: string | null };
  a?: string;
  b?: string;
  onPick?: (a: string, b: string) => void;
  error?: string | null;
}) {
  const a = props.a ?? props.reply?.a.id ?? "";
  const b = props.b ?? props.reply?.b.id ?? "";
  const pick = props.onPick ?? (() => {});
  const rows = props.reply === null ? [] : compareRows(props.reply, props.newestDone);
  return (
    <>
      <section className="card" aria-label="Choose two workspaces">
        <div className="card-title">Compare two workspaces</div>
        <div className="ws-compare-pickers">
          <Picker label="Workspace A" value={a} workspaces={props.workspaces} onPick={(id) => pick(id, b)} />
          <Picker label="Workspace B" value={b} workspaces={props.workspaces} onPick={(id) => pick(a, id)} />
        </div>
        {props.error !== undefined && props.error !== null ? <p className="card-desc" role="alert">{props.error}</p> : null}
      </section>

      {props.reply === null ? (
        <section className="card unobs-panel" aria-label="Comparison">
          <span className="status status-unobs">No comparison</span>
          <p className="unobs-text">Choose two workspaces.</p>
        </section>
      ) : (
        <>
          <div className="grid-2">
            <SideCard which="A" side={props.reply.a} />
            <SideCard which="B" side={props.reply.b} />
          </div>
          <section className="card table-card" aria-label="Blocks">
            <div className="card-title">Blocks</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Block</th><th scope="col">Verdict</th><th scope="col">In A</th><th scope="col">In B</th><th scope="col">Drill</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.block} className={`ws-verdict-row ws-verdict-${r.verdict}`}>
                      <td>{r.label}</td>
                      <td><span className={`ws-verdict ws-verdict-chip-${r.verdict}`}>{r.verdictLabel}</span></td>
                      <td className="words ws-entries">{r.a.length === 0 ? <span className="muted">{r.verdict === "changed" ? "none" : ""}</span> : <ul>{r.a.map((t, i) => <li key={i}>{t}</li>)}</ul>}</td>
                      <td className="words ws-entries">{r.b.length === 0 ? <span className="muted">{r.verdict === "changed" ? "none" : ""}</span> : <ul>{r.b.map((t, i) => <li key={i}>{t}</li>)}</ul>}</td>
                      <td className="words">
                        {r.drills.map((d) => <div key={d.href}><a href={d.href}>{d.label}</a></div>)}
                        {r.absent !== null ? <span className="muted">{r.absent}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="card-foot">Source: GET /api/workspaces/compare, one verdict per block hash</p>
          </section>
        </>
      )}
    </>
  );
}

/** The newest done deterministic run on a side: the runs route answers newest first; a stochastic run never pairs with a deterministic one (fix round M4). */
export function newestDoneOf(rows: WorkspaceRunRow[] | null): string | null {
  return rows?.find((r) => r.status?.state === "done" && r.mode !== "stochastic")?.runId ?? null;
}

export function WorkspaceComparePage(props: { workspaces: WorkspaceManifest[]; query: Record<string, string> }) {
  const a = props.query.a ?? "";
  const b = props.query.b ?? "";
  const chosen = a !== "" && b !== "";
  const load = useLoad(
    async () => {
      if (!chosen) return null;
      const [reply, ra, rb] = await Promise.all([
        compareWorkspaces(a, b),
        listWorkspaceRuns(a).catch(() => null),
        listWorkspaceRuns(b).catch(() => null),
      ]);
      return { reply, newestDone: { a: newestDoneOf(ra), b: newestDoneOf(rb) } };
    },
    [a, b],
  );
  const onPick = (x: string, y: string) => { window.location.hash = x === "" || y === "" ? "#/workspaces/compare" : compareHref(x, y); };
  if (load.state === "loading" && chosen) return <div className="card muted">Reading the comparison of {a} and {b}</div>;
  return (
    <WorkspaceCompareView
      reply={load.state === "ok" && load.value !== null ? load.value.reply : null}
      newestDone={load.state === "ok" && load.value !== null ? load.value.newestDone : { a: null, b: null }}
      workspaces={props.workspaces}
      a={a}
      b={b}
      onPick={onPick}
      error={load.state === "error" ? errText(load.error) : null}
    />
  );
}
