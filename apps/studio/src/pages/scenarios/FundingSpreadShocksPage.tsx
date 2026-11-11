// apps/studio/src/pages/scenarios/FundingSpreadShocksPage.tsx
/**
 * Data > Scenarios > Funding spread shocks. Pick a stored
 * market, add ops (add basis points to, or scale, its term liquidity premium
 * nodes, at every node or at one tenor), preview the derived market, and save it
 * under its own id. The server derives the snapshot and computes every number
 * printed here (the base and derived spreads and the change in basis points);
 * the page adds, scales and rounds nothing. Nothing runs: the saved market is
 * attached on Market > Yield curves and named as a run setup's Market on
 * Run > Setups.
 */
import { useId, useState } from "react";
import { getMarket, listMarket, previewDerivedMarket, saveDerivedMarket, type DerivedMarketPreview, type MarketListItem } from "@alm/reader";
import type { MarketShockOpKind } from "@alm/engine";
import { reasonOf } from "../../errText";
import { tenorLabel } from "../../format/tenor";
import { useLoad } from "../../useLoad";
import { previewShown, requestKey, type ShockNote } from "../../scenarios/behavioralShockModel";
import {
  addFundingOp, emptyFundingShockDraft, FUNDING_OP_CHOICES, fundingRequestOf, fundingSaveNoteOf, nodeChoices, removeFundingOp,
  setFundingBase, setFundingOpField, spreadText, ATTACH_SAVED_MARKET, attachLinkFor,
  type FundingBase, type FundingOpDraft, type FundingShockDraft,
} from "../../scenarios/fundingSpreadShockModel";

export const FUNDING_SPREAD_COPY = {
  intro: "Derive a new market snapshot from a stored one: pick a base market, then add basis points to, or scale, its term liquidity premium (TLP) nodes, at every node or at one tenor. The server derives the snapshot and stores it under its own id with a record of its base and its ops. Nothing runs here: attach the derived market on Market > Yield curves and name it as a run setup's Market on Run > Setups.",
  units: "Add is in basis points: 50 adds 0.50 percentage points to each node it reaches. Scale multiplies the stored spread by a factor greater than 0: 1.5 is fifty percent wider. Results are kept to 12 significant digits. The node at t = 0 stays pinned at 0 and no op reaches it, so the curve still rises from 0 to the first tenor. Every other node must stay greater than 0, the rule the workbook import applies. No op adds or removes a node.",
  copied: "The risk-free curve and the volatility surfaces are copied unchanged. The term-funding quotes are not carried: their tie to the TLP depends on how the base was built, which the stored snapshot does not record, and no run reads them, so a funding spread shock stores none rather than quotes that disagree with its TLP. Rate indices the base carries are copied unchanged.",
  measures: "A TLP shock moves EVE on the all-in discount basis (risk-free plus TLP) and FTP: the all-in transfer rate and the liquidity premium charge and credit. It does not move NII, the cash flows or the gaps, which read no TLP. Swap legs discount on the risk-free curve alone, so their present value does not move.",
  static: "The TLP stays static across the rate scenarios inside one run. Base against shock is two runs, one on each market, compared on Compare runs; attribution inside a run has no funding driver and cannot split out the TLP move.",
  elsewhere: "Volatility shocks are derived markets too, on Volatility shocks; they move stochastic runs only, and no deterministic result reads a volatility.",
  demonstration: "Every value entered here is a demonstration value, calibrated to nothing. The derived market label says so.",
} as const;

export interface FundingSpreadShocksViewProps {
  /** Every stored market: the base options, and the derived ones listed at the foot. */
  markets: MarketListItem[];
  /** The picked base market's TLP nodes as stored; null for none or while it is read. */
  base: FundingBase | null;
  /** Why there is no base on screen for a picked id: "Reading market <id>" or the read error; null otherwise. */
  baseNote: string | null;
  draft: FundingShockDraft;
  /** Why Preview and Save are off; null when the request is complete. */
  block: string | null;
  /** The preview of the request on the form; null when none was made or the form has changed since. */
  preview: DerivedMarketPreview | null;
  note: ShockNote | null;
  /** What the page is waiting for; null when idle. */
  busy: string | null;
  /** Market > Yield curves, where the saved market is attached; null when nothing was saved. */
  planLink: string | null;
  onBase(id: string | null): void;
  onAddOp(): void;
  onRemoveOp(key: number): void;
  onOp(key: number, patch: Partial<Omit<FundingOpDraft, "key">>): void;
  onLabel(label: string): void;
  onId(id: string): void;
  onPreview(): void;
  onSave(): void;
}

function OpRow(p: { n: number; row: FundingOpDraft; base: FundingBase; off: boolean; onOp: FundingSpreadShocksViewProps["onOp"]; onRemoveOp: FundingSpreadShocksViewProps["onRemoveOp"] }) {
  const { row, base } = p;
  return (
    <section className="card" aria-label={`Op ${p.n}`}>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Node</span>
          <select aria-label={`Node of op ${p.n}`} disabled={p.off} value={row.tYears === null ? "" : String(row.tYears)}
            onChange={(e) => p.onOp(row.key, { tYears: e.target.value === "" ? null : Number(e.target.value) })}>
            {nodeChoices(base).map((c) => (
              <option key={c.tYears === null ? "all" : c.tYears} value={c.tYears === null ? "" : String(c.tYears)}>{c.text}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Op</span>
          <select aria-label={`Op ${p.n} kind`} disabled={p.off} value={row.op} onChange={(e) => p.onOp(row.key, { op: e.target.value as MarketShockOpKind })}>
            {FUNDING_OP_CHOICES.map((c) => <option key={c.op} value={c.op}>{c.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Value</span>
          <input className="input" inputMode="decimal" aria-label={`Value of op ${p.n}`} disabled={p.off} value={row.valueText} onChange={(e) => p.onOp(row.key, { valueText: e.target.value })} />
          <span className="field-help">Basis points for Add, a factor above 0 for Scale by</span>
        </label>
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" aria-label={`Remove op ${p.n}`} disabled={p.off} onClick={() => p.onRemoveOp(row.key)}>Remove</button>
      </div>
    </section>
  );
}

export function FundingSpreadShocksView(p: FundingSpreadShocksViewProps) {
  const reasonId = useId();
  const baseId = useId();
  const off = p.busy !== null;
  const blocked = p.block !== null || off;
  const stored = p.markets.filter((m) => m.derivedFromMarketId !== undefined);
  const { note, preview } = p;
  return (
    <>
      <section className="card" aria-label="About funding spread shocks">
        <div className="card-title">Funding spread shocks</div>
        <p className="card-desc">{FUNDING_SPREAD_COPY.intro}</p>
        <p className="card-desc">{FUNDING_SPREAD_COPY.units}</p>
        <p className="card-desc">{FUNDING_SPREAD_COPY.copied}</p>
        <p className="card-desc">{FUNDING_SPREAD_COPY.measures}</p>
        <p className="card-desc">{FUNDING_SPREAD_COPY.static}</p>
        <p className="card-desc">{FUNDING_SPREAD_COPY.demonstration}</p>
        <p className="card-desc">{FUNDING_SPREAD_COPY.elsewhere}</p>
      </section>
      <section className="card stack" aria-label="Derive a market">
        <div className="card-title">Derive a market</div>
        <label className="field">
          <span className="field-label">Base market</span>
          <select id={baseId} aria-label="Base market" disabled={off} value={p.draft.baseId ?? ""} onChange={(e) => p.onBase(e.target.value === "" ? null : e.target.value)}>
            <option value="">Pick a base market</option>
            {p.markets.map((m) => <option key={m.id} value={m.id}>{m.id}: {m.label ?? "no label"} (as of {m.calibrationDate ?? "none"})</option>)}
          </select>
        </label>
        {p.baseNote !== null ? <p className="muted" role="status">{p.baseNote}</p> : null}
        {p.base !== null ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Tenor</th><th scope="col" className="num">Stored spread</th></tr></thead>
              <tbody>
                {p.base.tlpNodes.map((n) => (
                  <tr key={n.tYears}>
                    <th scope="row">{tenorLabel(n.tYears)}</th>
                    <td className="num">{n.tYears === 0 ? "pinned at 0" : spreadText(n.spread)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {p.base !== null ? p.draft.ops.map((row, i) => <OpRow key={row.key} n={i + 1} row={row} base={p.base!} off={off} onOp={p.onOp} onRemoveOp={p.onRemoveOp} />) : null}
        {p.base !== null ? <div className="sheet-actions"><button type="button" className="btn" disabled={off} onClick={p.onAddOp}>Add an op</button></div> : null}
        <div className="param-grid">
          <label className="field">
            <span className="field-label">Label</span>
            <input className="input" aria-label="Label" disabled={off} value={p.draft.label} onChange={(e) => p.onLabel(e.target.value)} />
            <span className="field-help">Leave empty for a label that names the base market</span>
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
          {note.savedId !== null && p.planLink !== null ? <p className="card-desc"><a href={p.planLink}>{ATTACH_SAVED_MARKET}</a></p> : null}
        </section>
      )}
      {preview === null ? null : (
        <section className="card table-card" aria-label="Preview">
          <div className="card-title">Preview: <span className="mono">{preview.id}</span></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Tenor</th><th scope="col" className="num">Base spread</th><th scope="col" className="num">Derived spread</th><th scope="col" className="num">Change (bp)</th></tr></thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.nodeIndex}>
                    <th scope="row">{tenorLabel(c.tYears)}</th>
                    <td className="num">{spreadText(c.from)}</td>
                    <td className="num">{spreadText(c.to)}</td>
                    <td className="num">{c.changeBp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="card-foot">Term-funding quotes: {preview.termFundingQuotesDropped} not carried. Source: /api/market/derive/preview</p>
        </section>
      )}
      <section className="card table-card" aria-label="Stored funding spread shocks">
        <div className="card-title">Stored funding spread shocks</div>
        {stored.length === 0 ? <p className="muted">None stored</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Market</th><th scope="col">Label</th><th scope="col">Base market</th><th scope="col">As of</th></tr></thead>
              <tbody>
                {stored.map((m) => (
                  <tr key={m.id}>
                    <th scope="row" className="mono">{m.id}</th>
                    <td>{m.label ?? ""}</td>
                    <td className="mono">{m.derivedFromMarketId}</td>
                    <td>{m.calibrationDate ?? ""}</td>
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

interface Shown { key: string; value: DerivedMarketPreview }

/** The page: holds the draft, the base market read, the preview and the calls. */
export function FundingSpreadShocksPage(props: { ws: string; query: Record<string, string> }) {
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<FundingShockDraft>(emptyFundingShockDraft);
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState<ShockNote | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const list = useLoad<MarketListItem[]>(() => listMarket(), [refresh]);
  // A re-read after a save keeps the last list on screen until the new one lands.
  const [kept, setKept] = useState<MarketListItem[] | null>(null);
  if (list.state === "ok" && list.value !== kept) setKept(list.value);
  const baseLoad = useLoad<{ id: string; nodes: FundingBase } | null>(
    () => (draft.baseId === null ? Promise.resolve(null) : getMarket(draft.baseId).then((s) => ({ id: draft.baseId!, nodes: { tlpNodes: s.tlpNodes } }))),
    [draft.baseId],
  );
  const base = baseLoad.state === "ok" && baseLoad.value !== null && baseLoad.value.id === draft.baseId ? baseLoad.value.nodes : null;
  const baseNote = draft.baseId === null ? null : baseLoad.state === "loading" ? `Reading market ${draft.baseId}` : baseLoad.state === "error" ? reasonOf(baseLoad.error) : null;
  const req = fundingRequestOf(draft, base);
  const key = "body" in req ? requestKey(req.body) : null;
  const preview = shown !== null && previewShown(shown.key, key) ? shown.value : null;
  // Any edit of the form drops the last note: it described the request as it was.
  const edit = (next: (d: FundingShockDraft) => FundingShockDraft) => { setDraft(next); setNote(null); };
  const run = async (what: string, save: boolean) => {
    if (working !== null || !("body" in req)) return;
    const body = req.body;
    setWorking(what);
    setNote(null);
    try {
      if (save) {
        const reply = await saveDerivedMarket(body);
        setShown({ key: requestKey(body), value: reply });
        setNote(fundingSaveNoteOf(reply));
        setRefresh((n) => n + 1);
      } else {
        setShown({ key: requestKey(body), value: await previewDerivedMarket(body) });
      }
    } catch (e) {
      setShown(null);
      setNote(fundingSaveNoteOf(e));
    } finally {
      setWorking(null);
    }
  };
  if (list.state === "error") return <div className="card" role="alert">{reasonOf(list.error)}</div>;
  const markets = list.state === "ok" ? list.value : kept;
  if (markets === null) return <div className="card muted">Reading the markets</div>;
  return (
    <FundingSpreadShocksView
      markets={markets} base={base} baseNote={baseNote} draft={draft} block={"block" in req ? req.block : null} preview={preview} note={note} busy={working}
      planLink={note !== null && note.savedId !== null ? attachLinkFor(props.ws) : null}
      onBase={(id) => { edit((d) => setFundingBase(d, id)); setShown(null); }}
      onAddOp={() => edit(addFundingOp)}
      onRemoveOp={(k) => edit((d) => removeFundingOp(d, k))}
      onOp={(k, patch) => edit((d) => setFundingOpField(d, k, patch))}
      onLabel={(label) => edit((d) => ({ ...d, label }))}
      onId={(id) => edit((d) => ({ ...d, id }))}
      onPreview={() => void run("Previewing", false)}
      onSave={() => void run("Saving", true)}
    />
  );
}
