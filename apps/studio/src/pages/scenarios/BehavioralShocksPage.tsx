// apps/studio/src/pages/scenarios/BehavioralShocksPage.tsx
/**
 * Data > Scenarios > Behavioral shocks. Pick a stored
 * assumption set, add ops (add to, scale or set one number parameter of one
 * binding), preview the derived set, and save it under its own id. The server
 * derives the set and computes every number printed here (the base and derived
 * values of the preview); the page adds, scales and rounds nothing. Nothing
 * runs: the saved set is bound to a scenario on Scenario sets.
 */
import { useId, useState } from "react";
import {
  getAssumptionSet, listAssumptionSets, previewDerivedSet, saveDerivedSet,
  type AssumptionSetListItem, type DerivedSetPreview,
} from "@alm/reader";
import type { AssumptionSet, DerivationOpKind } from "@alm/engine";
import { numberFieldsOf } from "@alm/engine/src/contracts/paramSchema";
import { reasonOf } from "../../errText";
import { useLoad } from "../../useLoad";
import {
  OP_CHOICES, addOp, bindingChoices, boundsText, changeBindingText, emptyShockDraft, paramChoices, previewShown, removeOp, requestKey, requestOf,
  saveNoteOf, setBase, setOpField, setsHref, storedValueText,
  type OpDraft, type ShockDraft, type ShockNote,
} from "../../scenarios/behavioralShockModel";

export const SHOCK_COPY = {
  intro: "Derive a new assumption set from a stored one: pick a base set, then add to, scale or set named behavioral parameters. The server derives the set, checks every value against the parameter schema, and stores it under its own id with a record of its base and its ops. Nothing runs here: bind the derived set to a scenario on Scenario sets.",
  units: "Values are in the unit each parameter is stored in and are never converted. Add 3 to a % CPR parameter means three percentage points; add 25 to a bp parameter means 25 basis points. Scale multiplies the stored value by the factor: 1.25 is a quarter more, and 0 sets a value to zero where the schema allows zero. Add and scale results are kept to 12 significant digits; set stores the value exactly.",
  demonstration: "Every value entered here is a demonstration value, calibrated to nothing. The derived set's label says so.",
  attribution: "Attribution does not split a behavioral shock. A scenario whose assumption set differs from the base scenario's set is declined by attribution, not split into drivers, so a derived set's effect shows only in the scenario totals.",
  spread: "Where a family binds both a loan client rate and a four-factor prepayment model, the total spread must equal the securitization plus the primary spread. A shock that moves one side alone is refused; move both by the same basis points in one derivation.",
  scope: "Only number parameters can be shocked. The deposit decay buckets and the commitment draw ramp are not offered, and neither are a plugin's registered parameters.",
  elsewhere: "A scenario cannot move the funding spread curve or a volatility surface, and no deterministic result reads a volatility. Target balances are shocked on Balance shocks, the funding spread (TLP) on Funding spread shocks and the constructed short-rate volatilities on Volatility shocks, each saved as its own input and run as its own run; a volatility shock moves stochastic runs only.",
} as const;

export interface BehavioralShocksViewProps {
  /** Every stored set: the base options, and the derived ones listed at the foot. */
  sets: AssumptionSetListItem[];
  /** The picked base set as stored; null for none or while it is read. */
  base: AssumptionSet | null;
  /** Why there is no base on screen for a picked id: "Reading set <id>" or the read error; null otherwise. */
  baseNote: string | null;
  draft: ShockDraft;
  /** Why Preview and Save are off; null when the request is complete. */
  block: string | null;
  /** The preview of the request on the form; null when none was made or the form has changed since. */
  preview: DerivedSetPreview | null;
  note: ShockNote | null;
  /** What the page is waiting for; null when idle. */
  busy: string | null;
  /** The Scenario sets address that names the saved set; null when nothing was saved. */
  setsLink: string | null;
  onBase(id: string | null): void;
  onAddOp(): void;
  onRemoveOp(key: number): void;
  onOp(key: number, patch: Partial<Omit<OpDraft, "key">>): void;
  onLabel(label: string): void;
  onId(id: string): void;
  onPreview(): void;
  onSave(): void;
}

function OpRow(p: { n: number; row: OpDraft; base: AssumptionSet; off: boolean; onOp: BehavioralShocksViewProps["onOp"]; onRemoveOp: BehavioralShocksViewProps["onRemoveOp"] }) {
  const { row, base } = p;
  const binding = row.bindingIndex === null ? undefined : base.bindings[row.bindingIndex];
  const field = binding === undefined || row.path === null ? undefined : numberFieldsOf(binding.overlay).find((f) => f.path === row.path);
  return (
    <section className="card" aria-label={`Op ${p.n}`}>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Binding</span>
          <select aria-label={`Binding of op ${p.n}`} disabled={p.off} value={row.bindingIndex === null ? "" : String(row.bindingIndex)}
            onChange={(e) => p.onOp(row.key, { bindingIndex: e.target.value === "" ? null : Number(e.target.value) })}>
            <option value="">Pick a binding</option>
            {bindingChoices(base).map((c) => <option key={c.index} value={String(c.index)} disabled={c.disabled}>{c.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Parameter</span>
          <select aria-label={`Parameter of op ${p.n}`} disabled={p.off || binding === undefined} value={row.path ?? ""}
            onChange={(e) => p.onOp(row.key, { path: e.target.value === "" ? null : e.target.value })}>
            <option value="">Pick a parameter</option>
            {binding === undefined ? null : paramChoices(binding).map((c) => <option key={c.path} value={c.path}>{c.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Op</span>
          <select aria-label={`Op ${p.n} kind`} disabled={p.off} value={row.op} onChange={(e) => p.onOp(row.key, { op: e.target.value as DerivationOpKind })}>
            {OP_CHOICES.map((c) => <option key={c.op} value={c.op}>{c.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Value</span>
          <input className="input" inputMode="decimal" aria-label={`Value of op ${p.n}`} disabled={p.off} value={row.valueText} onChange={(e) => p.onOp(row.key, { valueText: e.target.value })} />
        </label>
      </div>
      {field !== undefined && row.bindingIndex !== null && row.path !== null
        ? <p className="field-help">Stored value {storedValueText(base, row.bindingIndex, row.path)} {field.unit}; bounds {boundsText(field)}</p>
        : null}
      <div className="sheet-actions">
        <button type="button" className="btn" aria-label={`Remove op ${p.n}`} disabled={p.off} onClick={() => p.onRemoveOp(row.key)}>Remove</button>
      </div>
    </section>
  );
}

export function BehavioralShocksView(p: BehavioralShocksViewProps) {
  const reasonId = useId();
  const baseId = useId();
  const off = p.busy !== null;
  const blocked = p.block !== null || off;
  const stored = p.sets.filter((s) => s.derivedFromSetId !== undefined);
  const { note } = p;
  return (
    <>
      <section className="card" aria-label="About behavioral shocks">
        <div className="card-title">Behavioral shocks</div>
        <p className="card-desc">{SHOCK_COPY.intro}</p>
        <p className="card-desc">{SHOCK_COPY.units}</p>
        <p className="card-desc">{SHOCK_COPY.demonstration}</p>
        <p className="card-desc">{SHOCK_COPY.attribution}</p>
        <p className="card-desc">{SHOCK_COPY.spread}</p>
        <p className="card-desc">{SHOCK_COPY.scope}</p>
        <p className="card-desc">{SHOCK_COPY.elsewhere}</p>
      </section>
      <section className="card stack" aria-label="Derive a set">
        <label className="field">
          <span className="field-label">Base set</span>
          <select id={baseId} aria-label="Base set" disabled={off} value={p.draft.baseId ?? ""} onChange={(e) => p.onBase(e.target.value === "" ? null : e.target.value)}>
            <option value="">Pick a base set</option>
            {p.sets.map((s) => <option key={s.id} value={s.id}>{s.id}: {s.label}</option>)}
          </select>
        </label>
        {p.baseNote !== null ? <p className="muted" role="status">{p.baseNote}</p> : null}
        {p.base !== null ? p.draft.ops.map((row, i) => <OpRow key={row.key} n={i + 1} row={row} base={p.base!} off={off} onOp={p.onOp} onRemoveOp={p.onRemoveOp} />) : null}
        {p.base !== null ? <div className="sheet-actions"><button type="button" className="btn" disabled={off} onClick={p.onAddOp}>Add an op</button></div> : null}
        <div className="param-grid">
          <label className="field">
            <span className="field-label">Label</span>
            <input className="input" aria-label="Label" disabled={off} value={p.draft.label} onChange={(e) => p.onLabel(e.target.value)} />
            <span className="field-help">Leave empty for a label that names the base set</span>
          </label>
          <label className="field">
            <span className="field-label">Id</span>
            <input className="input" aria-label="Id" disabled={off} value={p.draft.id} onChange={(e) => p.onId(e.target.value)} />
            <span className="field-help">Leave empty for the derived id</span>
          </label>
        </div>
        <div className="sheet-actions">
          {/* Off by aria-disabled, not disabled, so a focused button keeps focus through a call (the Polish 1 rule). */}
          <button type="button" className="btn" aria-disabled={blocked ? true : undefined} aria-describedby={p.block !== null ? reasonId : undefined}
            onClick={blocked ? undefined : p.onPreview}>Preview</button>
          <button type="button" className="btn btn-primary" aria-disabled={blocked ? true : undefined} aria-describedby={p.block !== null ? reasonId : undefined}
            onClick={blocked ? undefined : p.onSave}>Save</button>
          {p.block !== null ? <span className="muted" id={reasonId} role="status">{p.block}</span> : null}
          {p.busy !== null ? <span className="muted" role="status">{p.busy}</span> : null}
        </div>
      </section>
      {note === null ? null : (
        <section className="card" role={note.kind === "created" || note.kind === "unchanged" ? "status" : "alert"} aria-label="Result">
          <span className={note.kind === "created" || note.kind === "unchanged" ? "status status-pass" : "status status-breach"}>{note.text}</span>
          {note.problems.length > 0 ? <ul className="diff-list">{note.problems.map((m, i) => <li key={i}>{m}</li>)}</ul> : null}
          {note.savedId !== null && p.setsLink !== null ? <p className="card-desc"><a href={p.setsLink}>Bind it on Scenario sets</a></p> : null}
        </section>
      )}
      {p.preview === null ? null : (
        <section className="card table-card" aria-label="Preview">
          <div className="card-title">Preview: <span className="mono">{p.preview.set.id}</span></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Binding</th><th scope="col">Parameter</th><th scope="col">Unit</th><th scope="col" className="num">Base value</th><th scope="col" className="num">Derived value</th></tr></thead>
              <tbody>
                {p.preview.changes.map((c) => (
                  <tr key={`${c.bindingIndex}:${c.path}`}>
                    <th scope="row">{changeBindingText(c)}</th>
                    <td>{c.label}</td>
                    <td>{c.unit}</td>
                    <td className="num">{String(c.from)}</td>
                    <td className="num">{String(c.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="card-foot">Source: /api/assumption-sets/derive/preview</p>
        </section>
      )}
      <section className="card table-card" aria-label="Stored behavioral shocks">
        <div className="card-title">Stored behavioral shocks</div>
        {stored.length === 0 ? <p className="muted">None stored</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Set</th><th scope="col">Label</th><th scope="col">Base set</th></tr></thead>
              <tbody>
                {stored.map((s) => (
                  <tr key={s.id}>
                    {/* A row the listing marks documentMissing: its stored document file is gone (mfu-1); the row is listed from its meta. */}
                    <th scope="row" className="mono">{s.id}{s.documentMissing === true ? <>{" "}<span className="muted">document missing</span></> : null}</th>
                    <td>{s.label}</td>
                    <td className="mono">{s.derivedFromSetId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

interface Shown { key: string; value: DerivedSetPreview }

/** The page: holds the draft, the base set read, the preview and the calls. */
export function BehavioralShocksPage(props: { ws: string; query: Record<string, string>; bookId: string | null }) {
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<ShockDraft>(emptyShockDraft);
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState<ShockNote | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const list = useLoad<AssumptionSetListItem[]>(() => listAssumptionSets(), [refresh]);
  // A re-read after a save keeps the last list on screen until the new one lands.
  const [kept, setKept] = useState<AssumptionSetListItem[] | null>(null);
  if (list.state === "ok" && list.value !== kept) setKept(list.value);
  const baseLoad = useLoad<AssumptionSet | null>(() => (draft.baseId === null ? Promise.resolve(null) : getAssumptionSet(draft.baseId)), [draft.baseId]);
  const base = baseLoad.state === "ok" && baseLoad.value !== null && baseLoad.value.id === draft.baseId ? baseLoad.value : null;
  const baseNote = draft.baseId === null ? null : baseLoad.state === "loading" ? `Reading set ${draft.baseId}` : baseLoad.state === "error" ? reasonOf(baseLoad.error) : null;
  const req = requestOf(draft, base);
  const key = "body" in req ? requestKey(req.body) : null;
  const preview = shown !== null && previewShown(shown.key, key) ? shown.value : null;
  // Any edit of the form drops the last note: it described the request as it was.
  const edit = (next: (d: ShockDraft) => ShockDraft) => { setDraft(next); setNote(null); };
  const run = async (what: string, save: boolean) => {
    if (working !== null || !("body" in req)) return;
    const body = req.body;
    setWorking(what);
    setNote(null);
    try {
      if (save) {
        const reply = await saveDerivedSet(body);
        setShown({ key: requestKey(body), value: { set: reply.set, changes: reply.changes } });
        setNote(saveNoteOf(reply));
        setRefresh((n) => n + 1);
      } else {
        setShown({ key: requestKey(body), value: await previewDerivedSet(body) });
      }
    } catch (e) {
      setShown(null);
      setNote(saveNoteOf(e));
    } finally {
      setWorking(null);
    }
  };
  if (list.state === "error") return <div className="card" role="alert">{reasonOf(list.error)}</div>;
  const sets = list.state === "ok" ? list.value : kept;
  if (sets === null) return <div className="card muted">Reading the assumption sets</div>;
  return (
    <BehavioralShocksView
      sets={sets} base={base} baseNote={baseNote} draft={draft} block={"block" in req ? req.block : null} preview={preview} note={note} busy={working}
      setsLink={note !== null && note.savedId !== null ? setsHref(props.ws, props.query, note.savedId) : null}
      onBase={(id) => { edit((d) => setBase(d, id)); setShown(null); }}
      onAddOp={() => edit(addOp)}
      onRemoveOp={(k) => edit((d) => removeOp(d, k))}
      onOp={(k, patch) => edit((d) => setOpField(d, k, patch))}
      onLabel={(label) => edit((d) => ({ ...d, label }))}
      onId={(id) => edit((d) => ({ ...d, id }))}
      onPreview={() => void run("Previewing", false)}
      onSave={() => void run("Saving", true)}
    />
  );
}
