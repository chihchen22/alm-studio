// apps/studio/src/pages/scenarios/BalanceShocksPage.tsx
/**
 * Data > Scenarios > Balance shocks. Pick a stored
 * balance plan, add ops (add to, scale or set the target balance of one listed
 * family, at every knot or at one knot month), preview the derived plan, and
 * save it under its own id. The server derives the plan, checks that every
 * target still lowers against the book in the top bar, and computes every
 * number printed here (the base and derived targets and the lowered rules); the
 * page adds, scales and rounds nothing. Nothing runs: the saved plan is bound
 * to a scenario on Scenario sets, in a plan with a balance stage.
 */
import { useId, useState } from "react";
import {
  getBalancePlan, listBalancePlans, previewDerivedBalancePlan, saveDerivedBalancePlan,
  type BalancePlanListItem, type DerivedBalancePlanPreview,
} from "@alm/reader";
import type { BalancePlan, DerivationOpKind } from "@alm/engine";
import { usd } from "../../balance/targetsModel";
import { reasonOf } from "../../errText";
import { useLoad } from "../../useLoad";
import { OP_CHOICES, previewShown, requestKey, type ShockNote } from "../../scenarios/behavioralShockModel";
import {
  addBalanceOp, balanceRequestOf, balanceSaveNoteOf, emptyBalanceShockDraft, familyChoices, growthRateText, knotChoices, lowersToText,
  removeBalanceOp, setBalanceBase, setBalanceOpField, setsLinkFor,
  type BalanceOpDraft, type BalanceShockDraft,
} from "../../scenarios/balanceShockModel";

export const BALANCE_SHOCK_COPY = {
  intro: "Derive a new balance plan from a stored one: pick a base plan, then add to, scale or set the target balance of a listed family, at every knot of its path or at one knot month. The server derives the plan, checks that every target still lowers onto the new-business rule against the book in the top bar, and stores it under its own id with a record of its base and its ops. Nothing runs here: bind the derived plan to a scenario on Scenario sets, in a plan with a balance stage.",
  units: "Add is in book currency units: add -10000000 lowers the target by 10,000,000. Scale multiplies the stored target by the factor: 0.9 is ten percent lower. Set replaces the target at one knot month and needs that month. Add and scale results are kept to 12 significant digits; set stores the value exactly. A target must stay finite and at least 0, and a target ending at zero is refused: leave the family out of the plan to run it off.",
  shape: "Each target is carried as one monthly growth rate from the opening balance, and that rate continues past the last knot to the horizon. A one-knot target lowers unless its knot is at zero or the family has no opening balance on the book. A target that falls faster than the book runs off cannot be met: new business cannot be negative, so origination stops at zero, the balance follows runoff, and the run reports a shortfall for that family. A multi-knot path lowers only while it stays a single geometric growth from the opening balance, so on such a path the engine refuses a uniform scale or add as well as a change at one knot. No op adds or removes a family or a knot.",
  measures: "Under the wiring that Add balance stage on Scenario sets builds, a balance shock moves NII only, through dynamic new business: EVE, the repricing and liquidity gaps and FTP stay on the contractual stage and run the book off. A hand-wired plan that also feeds the balance stage to EVE, a gap or a custom metric moves those measures as well. The opening balance is not shocked, and a stochastic run refuses a balance plan on its base scenario.",
  attribution: "Attribution compares each scenario with the base scenario. A scenario whose lowered new-business rules differ from the base scenario's is declined by attribution for NII 12 month, NII 24 month and EVE (EVE too, even where the shock does not move EVE), with a not-implemented note, and the run proceeds; the shock's effect shows only in the scenario totals.",
  demonstration: "Every value entered here is a demonstration value, calibrated to nothing. The derived plan's label says so.",
  notBuilt: "Not built: new-business pricing shocks (spread over index and term). Funding spread (TLP) shocks and volatility shocks are derived markets, on Funding spread shocks and Volatility shocks.",
} as const;

export interface BalanceShocksViewProps {
  /** Every stored balance plan: the base options, and the derived ones listed at the foot. */
  plans: BalancePlanListItem[];
  /** The picked base plan as stored; null for none or while it is read. */
  base: BalancePlan | null;
  /** Why there is no base on screen for a picked id: "Reading plan <id>" or the read error; null otherwise. */
  baseNote: string | null;
  /** The book in the top bar, the one the derived plan is checked against; null for none. */
  bookId: string | null;
  draft: BalanceShockDraft;
  /** Why Preview and Save are off; null when the request is complete. */
  block: string | null;
  /** The preview of the request on the form; null when none was made or the form has changed since. */
  preview: DerivedBalancePlanPreview | null;
  note: ShockNote | null;
  /** What the page is waiting for; null when idle. */
  busy: string | null;
  /** The Scenario sets address; null when nothing was saved. */
  setsLink: string | null;
  onBase(id: string | null): void;
  onAddOp(): void;
  onRemoveOp(key: number): void;
  onOp(key: number, patch: Partial<Omit<BalanceOpDraft, "key">>): void;
  onLabel(label: string): void;
  onId(id: string): void;
  onPreview(): void;
  onSave(): void;
}

function OpRow(p: { n: number; row: BalanceOpDraft; base: BalancePlan; off: boolean; onOp: BalanceShocksViewProps["onOp"]; onRemoveOp: BalanceShocksViewProps["onRemoveOp"] }) {
  const { row, base } = p;
  return (
    <section className="card" aria-label={`Op ${p.n}`}>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Family</span>
          <select aria-label={`Family of op ${p.n}`} disabled={p.off} value={row.familyId ?? ""}
            onChange={(e) => p.onOp(row.key, { familyId: e.target.value === "" ? null : e.target.value })}>
            <option value="">Pick a family</option>
            {familyChoices(base).map((c) => <option key={c.familyId} value={c.familyId}>{c.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Knot</span>
          <select aria-label={`Knot of op ${p.n}`} disabled={p.off || row.familyId === null} value={row.month === null ? "" : String(row.month)}
            onChange={(e) => p.onOp(row.key, { month: e.target.value === "" ? null : Number(e.target.value) })}>
            {(row.familyId === null ? [{ month: null, text: "Every knot" }] : knotChoices(base, row.familyId)).map((c) => (
              <option key={c.month === null ? "all" : c.month} value={c.month === null ? "" : String(c.month)}>{c.text}</option>
            ))}
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
          <span className="field-help">Book currency units for Add, a factor for Scale by, a balance for Set to</span>
        </label>
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" aria-label={`Remove op ${p.n}`} disabled={p.off} onClick={() => p.onRemoveOp(row.key)}>Remove</button>
      </div>
    </section>
  );
}

export function BalanceShocksView(p: BalanceShocksViewProps) {
  const reasonId = useId();
  const baseId = useId();
  const off = p.busy !== null;
  const blocked = p.block !== null || off;
  const stored = p.plans.filter((s) => s.derivedFromPlanId !== undefined);
  const { note, preview } = p;
  // The lowering table lists each changed family once, in the order the changes name them, with the rule the server lowered for it.
  const loweredFamilies = preview === null ? [] : [...new Set(preview.changes.map((c) => c.familyId))];
  return (
    <>
      <section className="card" aria-label="About balance shocks">
        <div className="card-title">Balance shocks</div>
        <p className="card-desc">{BALANCE_SHOCK_COPY.intro}</p>
        <p className="card-desc">{BALANCE_SHOCK_COPY.units}</p>
        <p className="card-desc">{BALANCE_SHOCK_COPY.shape}</p>
        <p className="card-desc">{BALANCE_SHOCK_COPY.measures}</p>
        <p className="card-desc">{BALANCE_SHOCK_COPY.attribution}</p>
        <p className="card-desc">{BALANCE_SHOCK_COPY.demonstration}</p>
        <p className="card-desc">{BALANCE_SHOCK_COPY.notBuilt}</p>
      </section>
      <section className="card stack" aria-label="Derive a balance plan">
        {p.bookId !== null ? <p className="card-desc">Checked against book <span className="mono">{p.bookId}</span></p> : <p className="muted">Pick a book in the top bar</p>}
        <label className="field">
          <span className="field-label">Base plan</span>
          <select id={baseId} aria-label="Base plan" disabled={off} value={p.draft.baseId ?? ""} onChange={(e) => p.onBase(e.target.value === "" ? null : e.target.value)}>
            <option value="">Pick a base plan</option>
            {p.plans.map((s) => <option key={s.id} value={s.id}>{s.id}: {s.label} (as of {s.asOf})</option>)}
          </select>
        </label>
        {p.baseNote !== null ? <p className="muted" role="status">{p.baseNote}</p> : null}
        {p.base !== null ? p.draft.ops.map((row, i) => <OpRow key={row.key} n={i + 1} row={row} base={p.base!} off={off} onOp={p.onOp} onRemoveOp={p.onRemoveOp} />) : null}
        {p.base !== null ? <div className="sheet-actions"><button type="button" className="btn" disabled={off} onClick={p.onAddOp}>Add an op</button></div> : null}
        <div className="param-grid">
          <label className="field">
            <span className="field-label">Label</span>
            <input className="input" aria-label="Label" disabled={off} value={p.draft.label} onChange={(e) => p.onLabel(e.target.value)} />
            <span className="field-help">Leave empty for a label that names the base plan</span>
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
          {note.savedId !== null && p.setsLink !== null ? (
            <>
              <p className="card-desc"><a href={p.setsLink}>Bind it on Scenario sets</a></p>
              <p className="card-desc">Add balance stage on Scenario sets if the plan has none</p>
            </>
          ) : null}
        </section>
      )}
      {preview === null ? null : (
        <>
          <section className="card table-card" aria-label="Preview">
            <div className="card-title">Preview: <span className="mono">{preview.plan.id}</span></div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Family</th><th scope="col">Knot month</th><th scope="col" className="num">Base target</th><th scope="col" className="num">Derived target</th></tr></thead>
                <tbody>
                  {preview.changes.map((c) => (
                    <tr key={`${c.targetIndex}:${c.month}`}>
                      <th scope="row">{c.familyId}</th>
                      <td>{c.month}</td>
                      <td className="num">{usd(c.from)}</td>
                      <td className="num">{usd(c.to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="card-foot">Source: /api/balance-plans/derive/preview</p>
          </section>
          <section className="card table-card" aria-label="After lowering">
            <div className="card-title">After lowering</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Family</th><th scope="col">Lowers to</th><th scope="col" className="num">Monthly growth rate</th></tr></thead>
                <tbody>
                  {loweredFamilies.map((familyId) => {
                    const rule = preview.rules.find((r) => r.familyId === familyId);
                    return (
                      <tr key={familyId}>
                        <th scope="row">{familyId}</th>
                        <td>{rule === undefined ? "none served" : lowersToText(rule)}</td>
                        <td className="num">{rule === undefined ? "none" : growthRateText(rule)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      <section className="card table-card" aria-label="Stored balance shocks">
        <div className="card-title">Stored balance shocks</div>
        {stored.length === 0 ? <p className="muted">None stored</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Plan</th><th scope="col">Label</th><th scope="col">Base plan</th><th scope="col">As of</th></tr></thead>
              <tbody>
                {stored.map((s) => (
                  <tr key={s.id}>
                    <th scope="row" className="mono">{s.id}</th>
                    <td>{s.label}</td>
                    <td className="mono">{s.derivedFromPlanId}</td>
                    <td>{s.asOf}</td>
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

interface Shown { key: string; value: DerivedBalancePlanPreview }

/** The page: holds the draft, the base plan read, the preview and the calls. */
export function BalanceShocksPage(props: { ws: string; query: Record<string, string>; bookId: string | null }) {
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<BalanceShockDraft>(emptyBalanceShockDraft);
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState<ShockNote | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const list = useLoad<BalancePlanListItem[]>(() => listBalancePlans(), [refresh]);
  // A re-read after a save keeps the last list on screen until the new one lands.
  const [kept, setKept] = useState<BalancePlanListItem[] | null>(null);
  if (list.state === "ok" && list.value !== kept) setKept(list.value);
  const baseLoad = useLoad<BalancePlan | null>(() => (draft.baseId === null ? Promise.resolve(null) : getBalancePlan(draft.baseId)), [draft.baseId]);
  const base = baseLoad.state === "ok" && baseLoad.value !== null && baseLoad.value.id === draft.baseId ? baseLoad.value : null;
  const baseNote = draft.baseId === null ? null : baseLoad.state === "loading" ? `Reading plan ${draft.baseId}` : baseLoad.state === "error" ? reasonOf(baseLoad.error) : null;
  const req = balanceRequestOf(draft, base, props.bookId);
  const key = "body" in req ? requestKey(req.body) : null;
  const preview = shown !== null && previewShown(shown.key, key) ? shown.value : null;
  // Any edit of the form drops the last note: it described the request as it was.
  const edit = (next: (d: BalanceShockDraft) => BalanceShockDraft) => { setDraft(next); setNote(null); };
  const run = async (what: string, save: boolean) => {
    if (working !== null || !("body" in req)) return;
    const body = req.body;
    setWorking(what);
    setNote(null);
    try {
      if (save) {
        const reply = await saveDerivedBalancePlan(body);
        setShown({ key: requestKey(body), value: { plan: reply.plan, changes: reply.changes, rules: reply.rules } });
        setNote(balanceSaveNoteOf(reply));
        setRefresh((n) => n + 1);
      } else {
        setShown({ key: requestKey(body), value: await previewDerivedBalancePlan(body) });
      }
    } catch (e) {
      setShown(null);
      setNote(balanceSaveNoteOf(e));
    } finally {
      setWorking(null);
    }
  };
  if (list.state === "error") return <div className="card" role="alert">{reasonOf(list.error)}</div>;
  const plans = list.state === "ok" ? list.value : kept;
  if (plans === null) return <div className="card muted">Reading the balance plans</div>;
  return (
    <BalanceShocksView
      plans={plans} base={base} baseNote={baseNote} bookId={props.bookId} draft={draft} block={"block" in req ? req.block : null} preview={preview} note={note} busy={working}
      setsLink={note !== null && note.savedId !== null ? setsLinkFor(props.ws, props.query) : null}
      onBase={(id) => { edit((d) => setBalanceBase(d, id)); setShown(null); }}
      onAddOp={() => edit(addBalanceOp)}
      onRemoveOp={(k) => edit((d) => removeBalanceOp(d, k))}
      onOp={(k, patch) => edit((d) => setBalanceOpField(d, k, patch))}
      onLabel={(label) => edit((d) => ({ ...d, label }))}
      onId={(id) => edit((d) => ({ ...d, id }))}
      onPreview={() => void run("Previewing", false)}
      onSave={() => void run("Saving", true)}
    />
  );
}
