// apps/studio/src/pages/balance/HierarchiesPage.tsx
/**
 * Data > Balance sheet > Hierarchies and mapping (the tag route). Pick the book's authored
 * single-valued tag, build a tree of named levels over it, map every value of the tag to a leaf, save the hierarchy
 * under a new id, and apply a stored hierarchy to write a new book that carries one more tag per level. The server
 * owns every rule and the source values; the checks here are convenience checks. The page shows no number and sums
 * nothing: apply writes tags only.
 */
import { useEffect, useRef, useState } from "react";
import {
  applyHierarchy, getHierarchy, getHierarchySources, listHierarchies, saveHierarchy,
  type Hierarchy, type HierarchyKind, type HierarchyMeta, type HierarchySources,
} from "@alm/reader";
import { errText, reasonOf } from "../../errText";
import { useLoad, type LoadState } from "../../useLoad";
import {
  addLevel, addNode, applyText, checkDraft, defaultSaveId, draftFrom, editLevel, emptyDraft, isStored, leafIds, parentChoices,
  problemsFrom, removeLastLevel, removeNode, renameNode, saveText, setMapEntry, setNodeParent, toHierarchy, unmappedValues, withSourceDimension,
  type HierarchyDraft,
} from "../../balance/hierarchyModel";

const KIND_TEXT: Record<HierarchyKind, string> = { risk: "Risk", liquidity: "Liquidity", regulatory: "Regulatory" };
const KINDS: HierarchyKind[] = ["risk", "liquidity", "regulatory"];

export interface HierarchiesViewProps {
  bookId: string;
  sources: HierarchySources;
  stored: HierarchyMeta[];
  /** The stored hierarchy picked; null for a new draft. */
  selected: string | null;
  /** The picked hierarchy as stored (or as just saved); null for a new draft and while it is read. */
  storedDoc: Hierarchy | null;
  draft: HierarchyDraft;
  problems: string[];
  msg: string | null;
  /** What the page is waiting for; null when idle. The form is off meanwhile. */
  busy: string | null;
  /** Why the picked hierarchy could not be read; null when it was. */
  loadError: string | null;
  onPick(id: string | null): void;
  onSource(dim: string): void;
  onKind(kind: HierarchyKind): void;
  onId(id: string): void;
  onLabel(label: string): void;
  onSave(): void;
  onApply(): void;
  onLevel(index: number, patch: { id?: string; label?: string }): void;
  onAddLevel(): void;
  onRemoveLevel(): void;
  onNode(index: number, id: string): void;
  onNodeParent(index: number, parentId: string): void;
  onAddNode(level: string): void;
  onRemoveNode(index: number): void;
  onMap(value: string, nodeId: string): void;
}

const DESC = "A hierarchy maps one tag the book already carries into a tree of named levels. Apply writes a new book with a new id: the same positions, each carrying one more tag per level, named hierarchy id dot level id, and a taxonomy that declares them. Apply sums nothing and moves no balance, but the new book has its own content hash, so a run on it is a run on a different input. Risk, liquidity and regulatory hierarchies only; capital, ledger and planning hierarchies are not built. On the Plan page, the Book picker offers a plan's book and its re-tagged copies, and the Views card declares a view over the new tags; the validate gate accepts or refuses it, and a run of the saved plan is grouped by it on the Results Views tab. A position that carries no value for the source tag gets no hierarchy tag, and a view over a tag refuses a book with an untagged position.";

export function HierarchiesView(p: HierarchiesViewProps) {
  const { draft } = p;
  const busy = p.busy !== null;
  const failed = p.loadError !== null;
  const eligible = new Set(p.sources.dimensions.filter((d) => d.eligible).map((d) => d.id));
  const listed = p.stored.filter((h) => eligible.has(h.sourceDimension));
  const values = p.sources.dimensions.find((d) => d.id === draft.sourceDimension)?.values ?? [];
  const unmapped = unmappedValues(values, draft.map);
  const leaves = leafIds(draft).filter((id) => id !== "");
  const applicable = p.selected !== null && p.storedDoc !== null && isStored(draft, p.storedDoc);
  return (
    <>
      <div className="plan-toolbar">
        <label>
          Hierarchy{" "}
          <select aria-label="Hierarchy" disabled={busy} value={p.selected ?? ""} onChange={(e) => p.onPick(e.target.value === "" ? null : e.target.value)}>
            <option value="">New hierarchy</option>
            {listed.map((h) => <option key={h.id} value={h.id}>{h.id}: {h.label}</option>)}
            {/* A hierarchy just saved is selected before the re-read list holds it. */}
            {p.selected !== null && !listed.some((h) => h.id === p.selected) ? <option value={p.selected}>{p.selected}</option> : null}
          </select>
        </label>
        <label>
          Source tag{" "}
          <select aria-label="Source tag" disabled={p.selected !== null || busy} value={draft.sourceDimension} onChange={(e) => p.onSource(e.target.value)}>
            {p.sources.dimensions.map((d) => <option key={d.id} value={d.id} disabled={!d.eligible}>{d.eligible ? d.id : `${d.id} (${d.reason ?? "not eligible"})`}</option>)}
          </select>
        </label>
        <label>
          Kind{" "}
          <select aria-label="Kind" disabled={busy || failed} value={draft.kind} onChange={(e) => p.onKind(e.target.value as HierarchyKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_TEXT[k]}</option>)}
          </select>
        </label>
        <label>Id <input className="input" aria-label="Hierarchy id" disabled={busy || failed} value={failed ? "" : draft.id} onChange={(e) => p.onId(e.target.value)} /></label>
        <label>Label <input className="input" aria-label="Label" disabled={busy || failed} value={failed ? "" : draft.label} onChange={(e) => p.onLabel(e.target.value)} /></label>
        {/* Off while busy by aria-disabled, so a focused Save keeps focus through the save; the click is ignored then and the editor's in-flight guard stops a second POST. */}
        <button type="button" className="btn btn-primary" aria-disabled={busy && !failed ? true : undefined} disabled={failed} onClick={busy ? undefined : p.onSave}>Save as <span className="mono">{draft.id}</span></button>
        <button type="button" className="btn" disabled={!applicable || busy || failed} onClick={p.onApply}>Apply to <span className="mono">{p.bookId}</span></button>
        {!applicable && !busy && !failed ? <span className="muted">Apply takes a stored hierarchy: save the edits first.</span> : null}
        {p.busy !== null ? <span className="muted" role="status">{p.busy}</span> : null}
        {p.msg !== null ? <span role="status">{p.msg}</span> : null}
      </div>
      {failed ? <section className="card unobs-panel" role="alert"><span className="status status-unobs">Hierarchy not read</span><p className="unobs-text">{p.loadError}</p></section> : null}
      {!failed && p.problems.length > 0 ? <div className="card plan-banner" role="alert">{p.problems.map((m) => <div key={m}>{m}</div>)}</div> : null}
      <div className="card card-desc">{DESC}</div>
      {failed ? null : (
        <>
          <section className="card table-card" aria-label="Levels">
            <div className="card-title">Levels</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col" className="num">Order</th><th scope="col">Level id</th><th scope="col">Label</th><th scope="col">Action</th></tr></thead>
                <tbody>
                  {draft.levels.map((l, i) => (
                    <tr key={i}>
                      <th scope="row" className="num">{i + 1}</th>
                      <td><input className="input" aria-label={`Level ${i + 1} id`} disabled={busy} value={l.id} onChange={(e) => p.onLevel(i, { id: e.target.value })} /></td>
                      <td><input className="input" aria-label={`Level ${i + 1} label`} disabled={busy} value={l.label} onChange={(e) => p.onLevel(i, { label: e.target.value })} /></td>
                      <td>{i === draft.levels.length - 1 && draft.levels.length > 1 ? <button type="button" className="btn" aria-label={`Remove level ${l.id}`} disabled={busy} onClick={p.onRemoveLevel}>Remove</button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="plan-toolbar"><button type="button" className="btn" disabled={busy || draft.levels.length >= 6} onClick={p.onAddLevel}>Add level</button></div>
          </section>
          <section className="card table-card" aria-label="Nodes">
            <div className="card-title">Nodes</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col" className="num">Order</th><th scope="col">Node id</th><th scope="col">Level</th><th scope="col">Parent</th><th scope="col">Action</th></tr></thead>
                <tbody>
                  {draft.nodes.map((n, i) => {
                    const first = draft.levels[0]?.id === n.level;
                    return (
                      <tr key={i}>
                        <th scope="row" className="num">{i + 1}</th>
                        <td><input className="input" aria-label={`Node ${i + 1} id`} disabled={busy} value={n.id} onChange={(e) => p.onNode(i, e.target.value)} /></td>
                        <td className="mono">{n.level}</td>
                        <td>
                          <select aria-label={`Parent of node ${i + 1}`} disabled={busy || first} value={n.parentId ?? ""} onChange={(e) => p.onNodeParent(i, e.target.value)}>
                            {first ? <option value="">None (first level)</option> : <option value="">Choose a parent</option>}
                            {first ? null : parentChoices(draft, n.level).map((id) => <option key={id} value={id}>{id}</option>)}
                          </select>
                        </td>
                        <td><button type="button" className="btn" aria-label={`Remove node ${i + 1}`} disabled={busy} onClick={() => p.onRemoveNode(i)}>Remove</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="plan-toolbar">
              {draft.levels.map((l, i) => <button key={i} type="button" className="btn" disabled={busy} onClick={() => p.onAddNode(l.id)}>Add node at {l.label}</button>)}
            </div>
          </section>
          <section className="card table-card" aria-label="Map">
            <div className="card-title">Map of {draft.sourceDimension} on {p.bookId}</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Source value</th><th scope="col">Leaf node</th></tr></thead>
                <tbody>
                  {values.map((v) => (
                    <tr key={v}>
                      <th scope="row" className="mono">{v}</th>
                      <td>
                        <select aria-label={`Leaf for ${v}`} disabled={busy} value={Object.prototype.hasOwnProperty.call(draft.map, v) ? draft.map[v] : ""} onChange={(e) => p.onMap(v, e.target.value)}>
                          <option value="">Unmapped</option>
                          {leaves.map((id) => <option key={id} value={id}>{id}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {unmapped.length > 0
              ? <p className="status status-unobs">Unmapped: {unmapped.join(", ")}</p>
              : <p className="muted">Every value of {draft.sourceDimension} on {p.bookId} maps to a leaf.</p>}
            <p className="card-foot">Source: /api/hierarchies; /api/hierarchies/sources/{p.bookId}</p>
          </section>
        </>
      )}
    </>
  );
}

/** The form: holds the draft, the picked hierarchy and the save and apply calls. */
export function HierarchyEditor(props: { bookId: string; sources: HierarchySources; stored: HierarchyMeta[]; refresh: number; onChanged(): void }) {
  const { bookId, sources, stored } = props;
  const eligibleIds = sources.dimensions.filter((d) => d.eligible).map((d) => d.id);
  const [selected, setSelected] = useState<string | null>(null);
  const taken = new Set([...stored.map((h) => h.id), ...(selected !== null ? [selected] : [])]);
  const [draft, setDraft] = useState<HierarchyDraft>(() => {
    const dim = eligibleIds[0] ?? "";
    return { ...emptyDraft(dim), id: defaultSaveId(null, dim, new Set(stored.map((h) => h.id))) };
  });
  const [storedDoc, setStoredDoc] = useState<Hierarchy | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  // A second click lands before React re-renders the disabled button; the ref stops it.
  const inFlight = useRef(false);
  const doc = useLoad<Hierarchy | null>(() => (selected === null ? Promise.resolve(null) : getHierarchy(selected)), [selected, props.refresh]);
  // Only a read that landed seeds the draft: a read in flight or a failed one leaves what is on screen.
  useEffect(() => {
    if (doc.state !== "ok" || doc.value === null) return;
    setStoredDoc(doc.value);
    setDraft(draftFrom(doc.value));
    setProblems([]);
  }, [doc]);
  const values = sources.dimensions.find((d) => d.id === draft.sourceDimension)?.values ?? [];
  /** An edit of a picked hierarchy moves its id to the next free edit id, so Save never offers the id already held. */
  const edit = (next: (d: HierarchyDraft) => HierarchyDraft) => setDraft((prev) => {
    const out = next(prev);
    return selected !== null && out.id === selected ? { ...out, id: defaultSaveId(selected, out.sourceDimension, taken) } : out;
  });
  const save = async () => {
    if (inFlight.current) return;
    const found = checkDraft(draft, values);
    setProblems(found);
    setMsg(null);
    if (found.length > 0) return;
    inFlight.current = true;
    setWorking(`Saving ${draft.id}`);
    try {
      const canonical = toHierarchy(draft);
      const reply = await saveHierarchy(canonical, bookId);
      setSelected(canonical.id);
      setStoredDoc(canonical);
      setMsg(saveText(reply.outcome, canonical.id));
      props.onChanged();
    } catch (e) {
      setProblems(problemsFrom(e));
      setMsg(errText(e));
    } finally {
      inFlight.current = false;
      setWorking(null);
    }
  };
  const apply = async () => {
    if (inFlight.current || selected === null) return;
    inFlight.current = true;
    setWorking(`Applying ${selected} to ${bookId}`);
    setMsg(null);
    setProblems([]);
    try {
      setMsg(applyText(await applyHierarchy(selected, bookId)));
    } catch (e) {
      setProblems(problemsFrom(e));
      setMsg(errText(e));
    } finally {
      inFlight.current = false;
      setWorking(null);
    }
  };
  const pick = (id: string | null) => {
    setSelected(id);
    setMsg(null);
    setProblems([]);
    setStoredDoc(null);
    if (id === null) {
      const dim = eligibleIds.includes(draft.sourceDimension) ? draft.sourceDimension : (eligibleIds[0] ?? "");
      setDraft({ ...emptyDraft(dim), id: defaultSaveId(null, dim, new Set(stored.map((h) => h.id))) });
    }
  };
  const busy = working !== null ? working : selected !== null && doc.state === "loading" ? `Reading hierarchy ${selected}` : null;
  const loadError = selected !== null && doc.state === "error" ? reasonOf(doc.error) : null;
  return (
    <HierarchiesView
      bookId={bookId} sources={sources} stored={stored} selected={selected} storedDoc={storedDoc} draft={draft}
      problems={problems} msg={msg} busy={busy} loadError={loadError}
      onPick={pick}
      onSource={(dim) => setDraft((prev) => {
        const next = withSourceDimension(prev, dim);
        return prev.id === defaultSaveId(null, prev.sourceDimension, taken) ? { ...next, id: defaultSaveId(null, dim, taken) } : next;
      })}
      onKind={(kind) => edit((d) => ({ ...d, kind }))}
      onId={(id) => setDraft((d) => ({ ...d, id }))}
      onLabel={(label) => edit((d) => ({ ...d, label }))}
      onSave={() => void save()} onApply={() => void apply()}
      onLevel={(i, patch) => edit((d) => editLevel(d, i, patch))}
      onAddLevel={() => edit(addLevel)} onRemoveLevel={() => edit(removeLastLevel)}
      onNode={(i, id) => edit((d) => renameNode(d, i, id))}
      onNodeParent={(i, parentId) => edit((d) => setNodeParent(d, i, parentId))}
      onAddNode={(level) => edit((d) => addNode(d, level))}
      onRemoveNode={(i) => edit((d) => removeNode(d, i))}
      onMap={(value, nodeId) => edit((d) => setMapEntry(d, value, nodeId))}
    />
  );
}

/** What the page reads for a book, tagged with the book it was read for. */
export interface HierarchyBody { bookId: string; sources: HierarchySources; stored: HierarchyMeta[] }

/** The body on screen: the new one once it lands; the kept one while the same book is re-read; none once the book changes. */
export function hierarchyBodyShown(kept: HierarchyBody | null, next: LoadState<HierarchyBody | null>, bookId: string | null): HierarchyBody | null {
  if (next.state === "ok") return next.value !== null && next.value.bookId === bookId ? next.value : null;
  return next.state === "loading" && kept !== null && kept.bookId === bookId ? kept : null;
}

/** The page's view: no book, the read error, "Reading book <id>", the two no-tag sentences, else the editor. */
export function HierarchiesPageView(props: { bookId: string | null; load: LoadState<HierarchyBody | null>; shown: HierarchyBody | null; refresh: number; onChanged(): void }) {
  const { bookId, load, shown } = props;
  if (bookId === null) return <div className="card unobs-panel"><p className="unobs-text">Unobservable: no book selected. Set the Book pill.</p></div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  if (shown === null) return <div className="card muted">Reading book {bookId}</div>;
  const dims = shown.sources.dimensions;
  if (shown.sources.taxonomyId === null) {
    return <div className="card unobs-panel"><p className="unobs-text">Book {bookId} declares no taxonomy, so it carries no tag to map. Pick a tagged book with the Book pill.</p></div>;
  }
  if (!dims.some((d) => d.eligible)) {
    const why = dims.map((d) => `${d.id}: ${d.reason ?? "not eligible"}`).join("; ");
    return <div className="card unobs-panel"><p className="unobs-text">Book {bookId} carries no single-valued authored tag to map{why === "" ? "" : `: ${why}`}. Pick a tagged book with the Book pill.</p></div>;
  }
  // Keyed on the book alone: a save re-reads the lists without remounting the form.
  return <HierarchyEditor key={bookId} bookId={bookId} sources={shown.sources} stored={shown.stored} refresh={props.refresh} onChanged={props.onChanged} />;
}

export function HierarchiesPage(props: { bookId: string | null }) {
  const bookId = props.bookId;
  const [refresh, setRefresh] = useState(0);
  const [kept, setKept] = useState<HierarchyBody | null>(null);
  const load = useLoad<HierarchyBody | null>(async () => {
    if (bookId === null) return null;
    const [sources, stored] = await Promise.all([getHierarchySources(bookId), listHierarchies()]);
    return { bookId, sources, stored };
  }, [bookId, refresh]);
  const shown = hierarchyBodyShown(kept, load, bookId);
  if (shown !== kept) setKept(shown);
  return <HierarchiesPageView bookId={bookId} load={load} shown={shown} refresh={refresh} onChanged={() => setRefresh((n) => n + 1)} />;
}
