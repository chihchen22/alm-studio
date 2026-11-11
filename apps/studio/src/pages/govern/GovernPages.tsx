/**
 * Govern > Records (ALM Studio P1): versions and lineage, model inventory, run
 * audit log. Read-only. Each record has a pure view over already-loaded data
 * (renderable without a DOM) and a thin page that reads the served routes and
 * passes the replies in. Nothing is computed: rows are selected, sorted and
 * printed as stored.
 */
import {
  CATALOG_LINEAGE_COLLECTIONS, getCatalogLineage, getCatalogRunInputs, getPluginCatalog, getResultSection, getRun, listAssumptionSets,
  listCatalogMarkets, listCatalogPortfolios, listCatalogRuns, listScenarioSlates,
  type CatalogLineage, type CatalogLineageCollection, type CatalogRunInputs, type CatalogRunListItem, type PluginCatalogReply,
} from "@alm/reader";
import { Fragment, useMemo, useRef, type ReactNode } from "react";
import type { WorkspaceManifest } from "@alm/reader";
import { RunPlanCard, WorkspaceHistory, WorkspaceLineageCard } from "./WorkspaceGovern";
import { errText, reasonOf } from "../../errText";
import { useLoad } from "../../useLoad";
import { screenHref } from "../../pageLinks";
import { auditCell, auditPlan, auditRows, idPieces, inventoryRows, planReadable, type PlanRead } from "../../govern/governModels";
import { useWholeRows } from "../../layout/wholeRows";
import { runCurveValue } from "../../results/curveLine";

const COLLECTION_LABEL: Record<CatalogLineageCollection, string> = {
  portfolios: "Books", market: "Market snapshots", "scenario-slates": "Scenario slates", "assumption-sets": "Assumption sets",
};

/** The catalog routes read the server's SQLite mirror, not the live store; the page says when the mirror catches up. */
const MIRROR_NOTE = "The catalog is read from the server's mirror. A book, snapshot, set or slate saved in Studio, and a run that reaches its end, sync into it at once, best effort; the server's start and a seed reconcile it. A run or a set whose sync failed appears after the next start or seed.";

/** A stored text, or a muted word when the store gives none. */
function orMuted(v: string, missing: string): ReactNode {
  return v === "" ? <span className="muted">{missing}</span> : v;
}

// --- Versions and lineage ------------------------------------------------------

export function LineageView(props: {
  lc: CatalogLineageCollection;
  /** The collection's stored ids; null while they are not read. */
  ids: string[] | null;
  lid: string | undefined;
  lineage: CatalogLineage | null;
  onPick(patch: Record<string, string>): void;
}) {
  const { lc, ids, lid, lineage, onPick } = props;
  return (
    <>
      <section className="card">
        <div className="plan-toolbar">
          <label>Collection <select value={lc} onChange={(e) => onPick({ lc: e.target.value, lid: "" })}>{CATALOG_LINEAGE_COLLECTIONS.map((c) => <option key={c} value={c}>{COLLECTION_LABEL[c]}</option>)}</select></label>
          <label>Id <select value={lid ?? ""} onChange={(e) => onPick({ lid: e.target.value })}>{(ids ?? []).map((i) => <option key={i} value={i}>{i}</option>)}</select></label>
        </div>
        {ids !== null && ids.length === 0 ? <p className="unobs-text">The collection holds no stored id.</p> : null}
        <p className="card-foot">Run plans are not a run-consumable collection, so the lineage route does not serve them.</p>
        <p className="card-foot">{MIRROR_NOTE}</p>
      </section>
      {lineage !== null ? (
        <section className="card table-card" aria-label="Lineage">
          <div className="card-title">{lineage.id}</div>
          <dl className="kv"><dt>Content hash</dt><dd className="mono">{lineage.contentHash}</dd></dl>
          {lineage.consumedBy.length === 0 ? <p className="unobs-text">No run has consumed it.</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th scope="col">Run</th><th scope="col">Role</th><th scope="col">State</th><th scope="col">Submitted</th><th scope="col">Pinned hash</th></tr></thead>
              <tbody>{lineage.consumedBy.map((c) => (
                <tr key={`${c.runId}:${c.role}`}>
                  <th scope="row" className="mono">{c.runId}</th><td className="mono">{c.role}</td><td>{c.state}</td>
                  <td className="num">{c.submittedAt ?? "Unobservable: no submit time recorded"}</td><td className="mono">{c.pinnedContentHash}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <p className="card-foot">Source: /api/catalog/lineage/{lc}/{lineage.id}</p>
        </section>
      ) : null}
    </>
  );
}

/**
 * A lineage read that failed for one id (for example an id the catalog mirror has not reached yet): the house
 * Unobservable chip with the server's own reason, not its raw status text, and the route it read.
 */
export function LineageUnobservable(props: { lc: CatalogLineageCollection; lid: string; error: unknown }) {
  const reason = reasonOf(props.error);
  return (
    <section className="card unobs-panel" aria-label="Lineage">
      <div className="card-title">{props.lid}</div>
      <span className="status status-unobs">Unobservable</span>
      <p className="unobs-text">{reason}</p>
      <p className="card-foot">Source: /api/catalog/lineage/{props.lc}/{props.lid}</p>
    </section>
  );
}

async function idsOf(c: CatalogLineageCollection): Promise<string[]> {
  if (c === "portfolios") return (await listCatalogPortfolios()).map((x) => x.id);
  if (c === "market") return (await listCatalogMarkets()).map((x) => x.id);
  if (c === "assumption-sets") return (await listAssumptionSets()).map((x) => x.id);
  return (await listScenarioSlates()).map((x) => x.id);
}

/**
 * `head` and `workspaces` add the open workspace's clone tree, supersede link, history and the plan of a
 * stored run above the catalog lineage of a stored document; without them the page is the catalog lineage alone.
 */
export function LineagePage(props: { ws: string; query: Record<string, string>; head?: WorkspaceManifest | null; workspaces?: WorkspaceManifest[] }) {
  const lc = (CATALOG_LINEAGE_COLLECTIONS as readonly string[]).includes(props.query.lc ?? "") ? (props.query.lc as CatalogLineageCollection) : "assumption-sets";
  const ids = useLoad(() => idsOf(lc), [lc]);
  // An empty lid (just after a collection change) falls back to the collection's first id.
  const lid = props.query.lid !== undefined && props.query.lid !== "" ? props.query.lid : ids.state === "ok" ? ids.value[0] : undefined;
  const lineage = useLoad(() => (lid === undefined ? Promise.resolve(null) : getCatalogLineage(lc, lid)), [lc, lid ?? ""]);
  const go = (patch: Record<string, string>) => { window.location.hash = screenHref({ ws: props.ws, section: "govern", screen: "lineage" }, { ...props.query, ...patch }); };
  return (
    <>
      {props.head === undefined || props.head === null ? null : (
        <>
          <WorkspaceLineageCard head={props.head} workspaces={props.workspaces ?? [props.head]} />
          <WorkspaceHistory ws={props.head.id} />
          <RunPlanCard ws={props.head.id} query={props.query} />
        </>
      )}
      <LineageView lc={lc} ids={ids.state === "ok" ? ids.value : null} lid={lid} lineage={lineage.state === "ok" ? lineage.value : null} onPick={go} />
      {ids.state === "loading" ? <div className="card muted">Reading the {COLLECTION_LABEL[lc].toLowerCase()}</div> : null}
      {ids.state === "error" ? <div className="card" role="alert">{errText(ids.error)}</div> : null}
      {lineage.state === "loading" ? <div className="card muted">Reading lineage</div> : null}
      {lineage.state === "error" && lid !== undefined ? <LineageUnobservable lc={lc} lid={lid} error={lineage.error} /> : null}
    </>
  );
}

// --- Model inventory ------------------------------------------------------------

/**
 * A list of ids in one cell (Polish 6 T3). Each id, with the comma that follows it, is one unit; units are joined by a
 * space. Inside a unit a wbr marks each word joint (idPieces; Task 6 fix I1, ruling), so a line breaks between
 * two ids or at a joint, never inside a word; an empty list is the muted None.
 */
function IdList(props: { ids: string[] }) {
  if (props.ids.length === 0) return <span className="muted">None</span>;
  const last = props.ids.length - 1;
  return <>{props.ids.map((id, i) => (
    <Fragment key={i}>{i > 0 ? " " : null}<span className="unit">
      {idPieces(id).map((p, j) => <Fragment key={j}>{j > 0 ? <wbr /> : null}{p}</Fragment>)}{i < last ? "," : null}
    </span></Fragment>
  ))}</>;
}

export function InventoryView(props: { reply: PluginCatalogReply }) {
  // Built once per reply, so the box's fit runs again only when the rows change (Polish 8 T2).
  const rows = useMemo(() => inventoryRows(props.reply), [props.reply]);
  // The box ends on the last whole row under the .table-wrap cap, through the fit By kind uses (Polish 8 T2).
  const wrap = useRef<HTMLDivElement>(null);
  useWholeRows(wrap, rows);
  return (
    <section className="card table-card" aria-label="Model inventory">
      <div className="card-title">Model inventory</div>
      {/* inventory: every body cell sits on the row's first baseline, level with the component name (app.css, Polish 7 Task 4 I1). */}
      <div className="table-wrap" ref={wrap}><table className="table inventory">
        <thead><tr><th scope="col">Component</th><th scope="col">Status</th><th scope="col">Consumes</th><th scope="col">Produces</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            {/* The Component cell: the name and the id (inv-id, never broken inside itself); a meta line, the kind (mono,
                12 px, one unit, so it breaks only at a joint) then the role or the muted None, each after a visually
                hidden Kind: or Role: label; then Purpose, None when the catalog gives none. Both lines muted, 13 px
                (Polish 7 T2, Polish 8 T1, Polish 9, ruling 2026-09-29). */}
            <th scope="row">{r.label} <span className="mono muted inv-id">{r.id}</span><span className="muted inv-meta"><span className="sr-only">Kind: </span><span className="mono"><IdList ids={[r.kind]} /></span> · <span className="sr-only">Role: </span>{orMuted(r.role, "None")}</span><span className="muted purpose">{r.purpose === "" ? "None" : r.purpose}</span></th>
            <td>{r.runs ? <span className="chip chip-runs">Runs</span> : <span className="chip chip-catalog">Catalog only</span>}</td>
            <td className="mono wrap"><IdList ids={r.consumes} /></td><td className="mono wrap"><IdList ids={r.produces} /></td>
          </tr>
        ))}</tbody>
      </table></div>
      {/* The count, as text: the box ends on a whole row, so this line says how many rows it holds (Polish 8 T2, ruling 2026-09-29). */}
      <p className="table-foot">{rows.length} {rows.length === 1 ? "component" : "components"}</p>
      <p className="card-foot">Source: /api/catalog/plugins components[] and mounted[]; the route carries no model version.</p>
    </section>
  );
}

export function InventoryPage() {
  const load = useLoad(() => getPluginCatalog(), []);
  if (load.state === "loading") return <div className="card muted">Reading the model catalog</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <InventoryView reply={load.value} />;
}

// --- Run audit log --------------------------------------------------------------

/**
 * An opened audit row: its pinned inputs, how its plan was read from the result provenance, and the curve the run built
 * on (the run detail's curve line, B4 Task 9; the row is left out when there is none).
 */
export interface OpenedRun {
  inputs: CatalogRunInputs;
  plan: PlanRead;
  curve?: string;
}

export function AuditView(props: { ws: string; runs: CatalogRunListItem[]; query: Record<string, string>; open: string | undefined; opened: OpenedRun | null }) {
  const { query, open, opened } = props;
  return (
    <>
      <section className="card table-card" aria-label="Run audit log">
        <div className="card-title">Run audit log</div>
        <div className="table-wrap"><table className="table audit-log">
          <thead><tr><th scope="col">Run</th><th scope="col">Label</th><th scope="col">State</th><th scope="col">Submitted</th><th scope="col">Ended</th><th scope="col">Request hash</th><th scope="col">Inputs hash</th><th scope="col">Result hash</th></tr></thead>
          <tbody>{auditRows(props.runs).map((r) => (
            <tr key={r.runId} className={`row-link${r.runId === open ? " is-selected" : ""}`}>
              <th scope="row" className="mono"><a href={screenHref({ ws: props.ws, section: "govern", screen: "audit" }, { ...query, audit: r.runId })}>{r.runId}</a></th>
              <td>{r.label ?? <span className="muted">No label</span>}</td><td>{r.state}</td>
              <td className="num">{auditCell(r, "submittedAt")}</td><td className="num">{auditCell(r, "endedAt")}</td>
              <td className="mono">{r.platformRequestHash}</td><td className="mono">{auditCell(r, "engineInputsHash")}</td><td className="mono">{auditCell(r, "resultContentHash")}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="card-foot">Source: /api/catalog/runs. The list carries no plan id; open a run to read its inputs and its plan.</p>
        <p className="card-foot">{MIRROR_NOTE}</p>
      </section>
      {opened !== null ? (
        <section className="card table-card" aria-label="Run inputs">
          <div className="card-title">Inputs of {opened.inputs.runId}</div>
          <dl className="kv">
            <dt>Plan</dt>
            <dd className="mono">{auditPlan(opened.plan)}</dd>
            {opened.curve !== undefined ? <><dt>Curve</dt><dd>{opened.curve}</dd></> : null}
          </dl>
          {opened.inputs.inputs.length === 0 ? <p className="unobs-text">The run pinned no inputs.</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th scope="col">Role</th><th scope="col">Collection</th><th scope="col">Id</th><th scope="col">Content hash</th></tr></thead>
              <tbody>{opened.inputs.inputs.map((i) => <tr key={`${i.role}:${i.ord}`}><th scope="row" className="mono">{i.role}</th><td className="mono">{i.collection}</td><td className="mono">{i.id}</td><td className="mono">{i.contentHash}</td></tr>)}</tbody>
            </table></div>
          )}
          <p className="card-foot">Source: /api/catalog/runs/{opened.inputs.runId}/inputs; the plan from /api/runs/{opened.inputs.runId}/result/provenance planId{opened.curve !== undefined ? `; the curve from /api/runs/${opened.inputs.runId}` : ""}.</p>
        </section>
      ) : null}
    </>
  );
}

/**
 * An opened row whose inputs could not be read (for example a run the catalog mirror has not reached yet): the
 * house Unobservable chip with the server's own reason, not its raw status text, and the route it read.
 */
export function AuditInputsUnobservable(props: { runId: string; error: unknown }) {
  const reason = reasonOf(props.error);
  return (
    <section className="card unobs-panel" aria-label="Run inputs">
      <div className="card-title">Inputs of {props.runId}</div>
      <span className="status status-unobs">Unobservable</span>
      <p className="unobs-text">{reason}</p>
      <p className="card-foot">Source: /api/catalog/runs/{props.runId}/inputs</p>
    </section>
  );
}

/** The plan of an opened row: the provenance section of a done run's stored result; any other row has none to read. */
function readPlan(runId: string, row: CatalogRunListItem | undefined): Promise<PlanRead> {
  if (row === undefined) return Promise.resolve({ kind: "failed", error: `run ${runId} is not in /api/catalog/runs` });
  if (!planReadable(row.state)) return Promise.resolve({ kind: "skipped", state: row.state });
  return getResultSection(runId, "provenance").then(
    (provenance): PlanRead => ({ kind: "read", provenance }),
    (e: unknown): PlanRead => ({ kind: "failed", error: errText(e) }),
  );
}

/** The opened row's pinned inputs and its plan, read side by side. */
async function loadOpened(runId: string, row: CatalogRunListItem | undefined): Promise<OpenedRun> {
  const [inputs, plan, curve] = await Promise.all([
    getCatalogRunInputs(runId),
    readPlan(runId, row),
    getRun(runId).then(runCurveValue, (e: unknown) => `not read: ${errText(e)}`),
  ]);
  return { inputs, plan, curve };
}

export function AuditPage(props: { ws: string; query: Record<string, string> }) {
  const load = useLoad(() => listCatalogRuns(), []);
  const open = props.query.audit;
  // The plan read needs the row's state, so an opened row loads once the run list is in hand.
  const opened = useLoad(
    () => (open === undefined || load.state !== "ok" ? Promise.resolve(null) : loadOpened(open, load.value.find((r) => r.runId === open))),
    [open ?? "", load.state],
  );
  if (load.state === "loading") return <div className="card muted">Reading the run catalog</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return (
    <>
      <AuditView ws={props.ws} runs={load.value} query={props.query} open={open} opened={opened.state === "ok" ? opened.value : null} />
      {opened.state === "loading" && open !== undefined ? <div className="card muted">Reading run {open}</div> : null}
      {opened.state === "error" && open !== undefined ? <AuditInputsUnobservable runId={open} error={opened.error} /> : null}
    </>
  );
}
