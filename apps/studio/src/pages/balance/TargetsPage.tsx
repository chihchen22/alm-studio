// apps/studio/src/pages/balance/TargetsPage.tsx
/**
 * Data > Balance sheet > Targets and new business (ALM Studio P2). Pick a
 * stored balance plan of the book's as-of or start a new one, set each
 * family's target and new-business pricing, save under a new id. The opening
 * balance is the served SQL aggregate; nothing is computed here.
 * Studio Polish 1: a save note does not survive a Book pill change (T1); Save
 * and the rows are off while a plan is read or saved, and the page says which
 * (T2); a plan that cannot be read keeps the picker and prints why, with no
 * rows and no previous plan's label beside it (T3, Task 8 fix). A save
 * keeps the form mounted and the last book body on screen while the book is
 * re-read, so the rows never flash blank (T2).
 */
import { useEffect, useRef, useState } from "react";
import type { BalancePlan } from "@alm/engine";
import { getBalancePlan, getCatalogAggregateGrouped, getPortfolio, listBalancePlans, saveBalancePlan, type BalancePlanListItem, type WorkspaceManifest } from "@alm/reader";
import { AttachStored, useBlockWrite } from "../../controls/AttachStored";
import { balancePlanOptions, planSavedWrite, targetsAddBody, writeBlock } from "../../controls/attachBodies";
import { useBy } from "../../controls/ByName";
import { errText, reasonOf } from "../../errText";
import { useLoad, type LoadState } from "../../useLoad";
import { nextEditId } from "../../plan/planEdits";
import { coaRows, type CoaNodeLike, type CoaRow } from "../../balance/coaModel";
import {
  balanceReadBack, checkNodeRows, checkRows, emptyNodeRow, familyRows, nodeRowsOf, toBalancePlan, usd, withKind,
  type NodeTargetRow, type TargetKind, type TargetRow,
} from "../../balance/targetsModel";

export interface TargetsViewProps {
  bookId: string;
  asOf: string;
  plans: BalancePlanListItem[];
  selected: string | null;
  rows: TargetRow[];
  label: string;
  saveId: string;
  problems: string[];
  saveMsg: string | null;
  /** What the page is waiting for ("Reading balance plan <id>", "Saving <id>"); null when idle. Save and the rows are off meanwhile. */
  busy: string | null;
  /** Why the picked plan could not be read; null when it was. Save is off; the picker stays. */
  loadError: string | null;
  /** The chart nodes, depth first, for the node-target rows; absent hides the node targets (a book whose chart was not read). */
  coaNodes?: CoaRow[];
  nodeRows?: NodeTargetRow[];
  onNodeRow?(index: number, row: NodeTargetRow): void;
  onAddNode?(): void;
  onRemoveNode?(index: number): void;
  onPick(id: string | null): void;
  onRow(index: number, row: TargetRow): void;
  onLabel(label: string): void;
  onSave(): void;
}

const KIND_TEXT: Record<TargetKind, string> = { runoff: "Run off", flat: "Hold flat", reach: "Reach", stored: "Stored path" };

/**
 * A cell a target does not use, said in words so it never reads as a missing value. It is the balance tables' absence
 * cell (num muted: the body face, the muted ink, one line, right-aligned), so the word ends on its right-aligned
 * header's edge, as a value does (Polish 6 T4).
 */
const Unused = (props: { text: string }) => <td className="num muted">{props.text}</td>;

function RowView(props: { row: TargetRow; disabled: boolean; onRow(row: TargetRow): void }) {
  const { row, disabled, onRow } = props;
  const kinds: TargetKind[] = row.kind === "stored" ? ["runoff", "flat", "reach", "stored"] : ["runoff", "flat", "reach"];
  const readBack = row.kind === "reach" ? balanceReadBack(row.balance) : null;
  return (
    <tr>
      <th scope="row" className="mono">{row.familyId}</th>
      <td className="num">
        {row.opening !== null ? usd(row.opening) : <span className="status status-unobs">{row.inBook ? "Unobservable: no opening balance served" : "Unobservable: not in this book"}</span>}
      </td>
      <td>
        <select aria-label={`Target for ${row.familyId}`} disabled={disabled} value={row.kind} onChange={(e) => onRow(withKind(row, e.target.value as TargetKind))}>
          {kinds.map((k) => <option key={k} value={k}>{KIND_TEXT[k]}</option>)}
        </select>
      </td>
      {/* A run-off target takes no new business: one word per column, like the other rows (Polish 6 T4). */}
      {row.kind === "runoff" ? <><Unused text="No new business" /><Unused text="Not used" /><Unused text="Not used" /><Unused text="Not used" /></> : (
        <>
          {row.kind === "reach" ? (
            <td className="num">
              <input className="input input-bal" aria-label={`Balance, USD, ${row.familyId}`} inputMode="decimal" disabled={disabled} value={row.balance} onChange={(e) => onRow({ ...row, balance: e.target.value })} />
              {readBack !== null ? <div className="field-help">{readBack}</div> : null}
            </td>
          ) : row.kind === "stored" ? <td className="num"><span className="mono">{row.storedPath!.map((k) => `M${k.month} ${usd(k.balance)}`).join("; ")}</span></td>
            : <Unused text="Held at opening" />}
          {row.kind === "reach" ? <td className="num"><input className="input input-short" aria-label={`By month, ${row.familyId}`} inputMode="numeric" disabled={disabled} value={row.month} onChange={(e) => onRow({ ...row, month: e.target.value })} /></td>
            : <Unused text={row.kind === "flat" ? "Every month" : "In the path"} />}
          <td className="num"><input className="input input-short" aria-label={`Spread, bp, ${row.familyId}`} inputMode="decimal" disabled={disabled} value={row.spreadBp} onChange={(e) => onRow({ ...row, spreadBp: e.target.value })} /></td>
          <td className="num"><input className="input input-short" aria-label={`Term, months, ${row.familyId}`} inputMode="numeric" disabled={disabled} value={row.termMonths} onChange={(e) => onRow({ ...row, termMonths: e.target.value })} /></td>
        </>
      )}
    </tr>
  );
}

/** One node-target row: the node picker, the path, the pricing, and the allocation across templates (one vehicle in this release). */
function NodeRowView(props: { n: number; row: NodeTargetRow; nodes: CoaRow[]; disabled: boolean; onRow(row: NodeTargetRow): void; onRemove(): void }) {
  const { n, row, nodes, disabled, onRow } = props;
  const readBack = row.storedPath === null ? balanceReadBack(row.balance) : null;
  return (
    <tr>
      <td>
        <select aria-label={`COA node of node target ${n}`} disabled={disabled} value={row.coaNodeId} onChange={(e) => onRow({ ...row, coaNodeId: e.target.value })}>
          <option value="">Pick a node</option>
          {nodes.map((c) => <option key={c.id} value={c.id}>{`${c.label} (${c.id})`}</option>)}
        </select>
      </td>
      {row.storedPath !== null ? (
        <>
          <td className="num"><span className="mono">{row.storedPath.map((k) => `M${k.month} ${usd(k.balance)}`).join("; ")}</span></td>
          <Unused text="In the path" />
        </>
      ) : (
        <>
          <td className="num">
            <input className="input input-bal" aria-label={`Balance, USD, node target ${n}`} inputMode="decimal" disabled={disabled} value={row.balance} onChange={(e) => onRow({ ...row, balance: e.target.value })} />
            {readBack !== null ? <div className="field-help">{readBack}</div> : null}
          </td>
          <td className="num"><input className="input input-short" aria-label={`By month, node target ${n}`} inputMode="numeric" disabled={disabled} value={row.month} onChange={(e) => onRow({ ...row, month: e.target.value })} /></td>
        </>
      )}
      <td className="num"><input className="input input-short" aria-label={`Spread, bp, node target ${n}`} inputMode="decimal" disabled={disabled} value={row.spreadBp} onChange={(e) => onRow({ ...row, spreadBp: e.target.value })} /></td>
      <td className="num"><input className="input input-short" aria-label={`Term, months, node target ${n}`} inputMode="numeric" disabled={disabled} value={row.termMonths} onChange={(e) => onRow({ ...row, termMonths: e.target.value })} /></td>
      <td>100 percent to the 60-month fixed bullet</td>
      <td><button type="button" className="btn btn-quiet" aria-label={`Remove node target ${n}`} disabled={disabled} onClick={props.onRemove}>Remove</button></td>
    </tr>
  );
}

function NodeTargetsCard(p: TargetsViewProps) {
  const rows = p.nodeRows ?? [];
  const disabled = p.busy !== null || p.loadError !== null;
  return (
    <section className="card table-card" aria-label="Node targets">
      <div className="card-title">Node targets</div>
      <p className="card-desc">A node target sets one path for a chart of accounts node. The engine allocates it to the node&apos;s leaf families pro rata on opening balance, so the mix inside the node stays as it opens, and prices the new business at the spread and term here. A node and a family target over one family is refused. Allocation across several templates waits for a later release.</p>
      {rows.length === 0 ? null : (
        <div className="table-wrap">
          <table className="table targets-table">
            <thead><tr><th scope="col">Node</th><th scope="col" className="num">Balance, USD</th><th scope="col" className="num">By month</th><th scope="col" className="num">Spread, bp</th><th scope="col" className="num">Term, months</th><th scope="col">Allocation across templates</th><th scope="col">Remove</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <NodeRowView key={i} n={i + 1} row={r} nodes={p.coaNodes ?? []} disabled={disabled}
                  onRow={(next) => p.onNodeRow?.(i, next)} onRemove={() => p.onRemoveNode?.(i)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn" disabled={disabled} onClick={p.onAddNode}>Add a node target</button>
      </div>
      <p className="card-foot">Source: /api/portfolios/{p.bookId} coa.nodes; the saved plan carries nodeTargets beside targets</p>
    </section>
  );
}

export function TargetsView(p: TargetsViewProps) {
  const listed = p.plans.filter((b) => b.asOf === p.asOf);
  const busy = p.busy !== null;
  // A plan that could not be read shows none of the form: no rows, and not the label of the plan shown before.
  const failed = p.loadError !== null;
  return (
    <>
      <div className="plan-toolbar">
        <label>
          Balance plan{" "}
          <select aria-label="Balance plan" value={p.selected ?? ""} onChange={(e) => p.onPick(e.target.value === "" ? null : e.target.value)}>
            <option value="">New balance plan</option>
            {listed.map((b) => <option key={b.id} value={b.id}>{b.label !== "" && b.label !== b.id ? `${b.id}: ${b.label}` : b.id}</option>)}
            {/* A plan just saved is selected before the re-read list holds it; it stays the picker's choice meanwhile (Polish 1 T2). */}
            {p.selected !== null && !listed.some((b) => b.id === p.selected) ? <option value={p.selected}>{p.selected}</option> : null}
          </select>
        </label>
        <label>Label <input className="input" aria-label="Label" disabled={busy || failed} value={failed ? "" : p.label} onChange={(e) => p.onLabel(e.target.value)} /></label>
        {/* Off while busy by aria-disabled, so a focused Save keeps focus through the save and the re-read rather than
            dropping to the page; the click is ignored then, and the editor's in-flight guard still stops a second POST (final review M4). */}
        <button type="button" className="btn btn-primary" aria-disabled={busy && !failed ? true : undefined} disabled={failed} onClick={busy ? undefined : p.onSave}>Save as <span className="mono">{p.saveId}</span></button>
        {p.busy !== null ? <span className="muted" role="status">{p.busy}</span> : null}
        {p.saveMsg !== null ? <span role="status">{p.saveMsg}</span> : null}
      </div>
      {/* The Unobservable panel the Rates and Lineage layers use for a read that failed. */}
      {failed ? <section className="card unobs-panel" role="alert"><span className="status status-unobs">Balance plan not read</span><p className="unobs-text">{p.loadError}</p></section> : null}
      {/* A failed read shows no form, so no problems of the form shown before (final review M5). */}
      {!failed && p.problems.length > 0 ? <div className="card plan-banner" role="alert">{p.problems.map((m) => <div key={m}>{m}</div>)}</div> : null}
      <div className="card card-desc">New business feeds NII only. EVE and the gaps run the book off. A target is flat or one steady growth rate from the opening balance; the same monthly rate continues past month M to the horizon. The engine derives the rate and refuses any other shape when the plan is validated or run.</div>
      {failed ? null : <section className="card table-card" aria-label="Targets">
        <div className="card-title">Targets and new business, {p.bookId}, as of {p.asOf}</div>
        <div className="table-wrap">
          <table className="table targets-table">
            <thead><tr><th scope="col">Family</th><th scope="col" className="num">Opening balance, USD</th><th scope="col">Target</th><th scope="col" className="num">Balance, USD</th><th scope="col" className="num">By month</th><th scope="col" className="num">Spread, bp</th><th scope="col" className="num">Term, months</th></tr></thead>
            <tbody>{p.rows.map((r, i) => <RowView key={r.familyId} row={r} disabled={busy} onRow={(next) => p.onRow(i, next)} />)}</tbody>
          </table>
        </div>
        <p className="card-foot">Source: /api/catalog/portfolios/{p.bookId}/positions/aggregate?groupBy=family groups[].totalNotional; /api/balance-plans</p>
      </section>}
      {failed || p.coaNodes === undefined ? null : <NodeTargetsCard {...p} />}
    </>
  );
}

/** Why the picked plan could not be read, as the server's sentence (reasonOf), not its status and code; null otherwise. */
export function planLoadError(body: LoadState<BalancePlan | null>): string | null {
  return body.state === "error" ? reasonOf(body.error) : null;
}

/**
 * The id the next save takes. The selection is a stored plan's id, so it counts as taken even before the re-read
 * list holds it: right after a save, Save never offers the id just saved (Polish 1 T2).
 */
export function saveIdFor(selected: string | null, bookId: string, plans: BalancePlanListItem[]): string {
  return nextEditId(selected ?? `bp-${bookId}`, new Set([...plans.map((b) => b.id), ...(selected !== null ? [selected] : [])]));
}

/**
 * The form. After a save it selects the saved plan and says "Saved <id>" itself; the page keeps it mounted across
 * the book re-read, so the targets stay on screen instead of resetting to a blank form. initialSelected and
 * initialMsg set the opening selection and message on mount only.
 */
export function TargetsEditor(props: {
  bookId: string; asOf: string; plans: BalancePlanListItem[]; groups: Array<{ key: string | null; totalNotional: number | null }>;
  /** The book's chart nodes; absent shows no node-target row. */
  coaNodes?: CoaNodeLike[];
  initialSelected?: string | null; initialMsg?: string | null; onSaved(id: string): void;
}) {
  const [selected, setSelected] = useState<string | null>(props.initialSelected ?? null);
  const body = useLoad<BalancePlan | null>(() => (selected === null ? Promise.resolve(null) : getBalancePlan(selected)), [selected]);
  const [rows, setRows] = useState<TargetRow[]>(() => familyRows(props.groups, null));
  const [nodeRows, setNodeRows] = useState<NodeTargetRow[]>([]);
  const [label, setLabel] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [saveMsg, setSaveMsg] = useState<string | null>(props.initialMsg ?? null);
  const [saving, setSaving] = useState(false);
  // A second click lands before React re-renders the disabled button; the ref stops it (Polish 1 T2).
  const inFlight = useRef(false);
  // Only a read that landed resets the form: a read in flight or a failed one leaves what is on screen (Polish 1 T2, T3).
  useEffect(() => {
    if (body.state !== "ok") return;
    setRows(familyRows(props.groups, body.value));
    setNodeRows(nodeRowsOf(body.value));
    setLabel(body.value?.label ?? "");
    setProblems([]);
  }, [body, props.groups]);
  const saveId = saveIdFor(selected, props.bookId, props.plans);
  const save = async () => {
    if (inFlight.current) return;
    const found = [...checkRows(rows, nodeRows.length > 0), ...checkNodeRows(nodeRows, props.coaNodes ?? [], rows)];
    setProblems(found);
    setSaveMsg(null);
    if (found.length > 0) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await saveBalancePlan(toBalancePlan({ id: saveId, label: label.trim() === "" ? saveId : label.trim(), asOf: props.asOf }, rows, nodeRows));
      setSelected(saveId);
      setSaveMsg(`Saved ${saveId}`);
      props.onSaved(saveId);
    } catch (e) {
      setSaveMsg(errText(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const busy = saving ? `Saving ${saveId}` : selected !== null && body.state === "loading" ? `Reading balance plan ${selected}` : null;
  return (
    <TargetsView
      bookId={props.bookId} asOf={props.asOf} plans={props.plans} selected={selected} rows={rows} label={label}
      saveId={saveId} problems={problems} saveMsg={saveMsg} busy={busy} loadError={planLoadError(body)}
      coaNodes={props.coaNodes === undefined ? undefined : coaRows(props.coaNodes)} nodeRows={nodeRows}
      onNodeRow={(i, next) => setNodeRows(nodeRows.map((r, j) => (j === i ? next : r)))}
      onAddNode={() => setNodeRows([...nodeRows, emptyNodeRow()])}
      onRemoveNode={(i) => setNodeRows(nodeRows.filter((_, j) => j !== i))}
      onPick={(id) => { setSelected(id); setSaveMsg(null); }} onRow={(i, next) => setRows(rows.map((r, j) => (j === i ? next : r)))} onLabel={setLabel} onSave={() => void save()}
    />
  );
}

/** A save, tagged with the book it was made on. */
export interface SavedPlan { bookId: string; id: string }

/**
 * The editor's opening selection and message on mount: the saved plan only when it was saved on this book, so a
 * save on another book never selects that book's plan. A save itself does not remount the editor (it selects the
 * saved plan in place), and a Book pill change clears the save (nextSaved), so this is a fallback for a remount on
 * the save's book.
 */
export function savedProps(saved: SavedPlan | null, bookId: string): { initialSelected: string | null; initialMsg: string | null } {
  return saved !== null && saved.bookId === bookId ? { initialSelected: saved.id, initialMsg: `Saved ${saved.id}` } : { initialSelected: null, initialMsg: null };
}

/**
 * The save the page still holds after a render (Studio Polish 1 T1): none once the Book pill has moved, so coming
 * back to the book later does not read as the moment of the save.
 */
export function nextSaved(saved: SavedPlan | null, prevBook: string | null, bookId: string | null): SavedPlan | null {
  return prevBook === bookId ? saved : null;
}

/** What the form reads from the book, tagged with the book it was read for. */
export interface BookBody { bookId: string; asOf: string; groups: Array<{ key: string | null; totalNotional: number | null }>; plans: BalancePlanListItem[]; coaNodes?: CoaNodeLike[] }

/**
 * The book body on screen (Studio Polish 1 T2): the new one once it lands; the kept one while the same book is
 * re-read after a save; none once the book changes, so another book's rows never show.
 */
export function bodyShown(kept: BookBody | null, next: LoadState<BookBody | null>, bookId: string | null): BookBody | null {
  if (next.state === "ok") return next.value !== null && next.value.bookId === bookId ? next.value : null;
  return next.state === "loading" && kept !== null && kept.bookId === bookId ? kept : null;
}

/** The page's view: no book, the book's read error, "Reading book <id>" while nothing is on screen, else the form. */
export function TargetsPageView(props: { bookId: string | null; load: LoadState<BookBody | null>; shown: BookBody | null; saved: SavedPlan | null; onSaved(id: string): void }) {
  const { bookId, load, shown } = props;
  if (bookId === null) return <div className="card unobs-panel"><p className="unobs-text">Unobservable: no book selected. Set the Book pill.</p></div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  if (shown === null) return <div className="card muted">Reading book {bookId}</div>;
  // Keyed on the book alone: a save re-reads the book without remounting the form (Polish 1 T2).
  return <TargetsEditor key={bookId} bookId={bookId} asOf={shown.asOf} plans={shown.plans} groups={shown.groups} coaNodes={shown.coaNodes} {...savedProps(props.saved, bookId)} onSaved={props.onSaved} />;
}

/**
 * The balance plans of this workspace's targets block, and the control that adds a stored one (final review M1). A
 * plan saved on this page is added through the same write; the Custom dynamic basis of a run setup reads this block.
 */
export function PlansAttach(props: { head: WorkspaceManifest; written: ReturnType<typeof useBlockWrite>; byState: [string, (v: string) => void]; onChanged: () => void; refresh: number }) {
  const { head } = props;
  const held = head.blocks.targets.balancePlans.map((p) => p.id);
  return (
    <AttachStored
      key={props.refresh}
      head={head}
      title="Balance plans of this workspace"
      selectLabel="Attach a stored balance plan"
      current={held.length === 0 ? "No balance plan is attached. A Custom dynamic basis on a run setup needs one; Flat and Runoff need none. A plan saved below is added here." : <>Attached: <span className="mono">{held.join(", ")}</span>. A plan saved below is added here.</>}
      foot="Source: GET /api/balance-plans; the write is POST /api/workspaces/<id>/blocks, targets add."
      attachedIds={held}
      loadingText="Reading the stored balance plans"
      list={() => listBalancePlans().then(balancePlanOptions)}
      body={targetsAddBody}
      done={(id) => `Attached balance plan ${id}`}
      onChanged={props.onChanged}
      written={props.written}
      byState={props.byState}
      blocked={writeBlock(head, "its balance plans")}
    />
  );
}

export function TargetsPage(props: { bookId: string | null; head?: WorkspaceManifest | null; onChanged?: () => void }) {
  const head = props.head ?? null;
  const onChanged = props.onChanged ?? (() => {});
  const written = useBlockWrite(head?.id ?? "", onChanged);
  const byState = useBy();
  const [listRefresh, setListRefresh] = useState(0);
  const body = <TargetsBody bookId={props.bookId} onPlanSaved={(id) => {
    setListRefresh((n) => n + 1);
    if (head === null) return;
    const w = planSavedWrite(head, id, byState[0]);
    if (typeof w === "string") written.setNote(w);
    else void written.write(w, `Saved ${id} and added it to this workspace's targets block`);
  }} />;
  if (head === null) return body;
  return (
    <>
      <PlansAttach head={head} written={written} byState={byState} onChanged={onChanged} refresh={listRefresh} />
      {body}
    </>
  );
}

function TargetsBody(props: { bookId: string | null; onPlanSaved(id: string): void }) {
  const bookId = props.bookId;
  const [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState<SavedPlan | null>(null);
  const [seenBook, setSeenBook] = useState<string | null>(bookId);
  const [kept, setKept] = useState<BookBody | null>(null);
  const load = useLoad<BookBody | null>(async () => {
    if (bookId === null) return null;
    const [spec, grouped, plans] = await Promise.all([getPortfolio(bookId), getCatalogAggregateGrouped(bookId, {}, "family"), listBalancePlans()]);
    return { bookId, asOf: spec.asOf, groups: grouped.groups, plans, coaNodes: spec.coa.nodes };
  }, [bookId, refresh]);
  // Derived during render, not in an effect: this render already reads the cleared save.
  const current = nextSaved(saved, seenBook, bookId);
  if (seenBook !== bookId) {
    setSeenBook(bookId);
    setSaved(current);
  }
  const shown = bodyShown(kept, load, bookId);
  if (shown !== kept) setKept(shown);
  return <TargetsPageView bookId={bookId} load={load} shown={shown} saved={current} onSaved={(id) => { if (bookId !== null) setSaved({ bookId, id }); setRefresh((n) => n + 1); props.onPlanSaved(id); }} />;
}
