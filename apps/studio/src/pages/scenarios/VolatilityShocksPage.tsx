// apps/studio/src/pages/scenarios/VolatilityShocksPage.tsx
/**
 * Data > Scenarios > Volatility shocks. Pick a stored
 * market, add ops (scale, or add basis points of normal volatility to, its
 * constructed short-rate volatilities, at every expiry or at one), preview the
 * derived market, and save it under its own id. The server derives the snapshot
 * and computes every number printed here (the base and derived at-the-money
 * volatilities, the change in basis points, the quotes moved); the page adds,
 * scales and rounds nothing. Nothing runs here, and no stochastic run or
 * distribution is shown: the effect is read from the stochastic envelopes of a
 * run on the base and on the derived market, both run on the workbench Run
 * page; Stochastic distributions shows each envelope and Compare sets the two
 * side by side.
 */
import { useId, useState } from "react";
import { getMarket, listMarket, previewDerivedMarket, saveDerivedMarket, volBpText, type DerivedMarketPreview, type MarketListItem } from "@alm/reader";
import type { ShortRateVolOpKind } from "@alm/engine";
import { reasonOf } from "../../errText";
import { tenorLabel } from "../../format/tenor";
import { useLoad } from "../../useLoad";
import { previewShown, requestKey, type ShockNote } from "../../scenarios/behavioralShockModel";
import {
  addVolOp, atmRows, emptyVolShockDraft, expiryChoices, fundingSaveNoteOf, removeVolOp, setVolBase, setVolOpField,
  VOL_OP_CHOICES, volRequestOf,
  type VolBase, type VolOpDraft, type VolShockDraft,
} from "../../scenarios/volatilityShockModel";
import { ATTACH_SAVED_MARKET, attachLinkFor } from "../../scenarios/fundingSpreadShockModel";

export const VOLATILITY_SHOCK_COPY = {
  intro: "Derive a new market snapshot from a stored one: pick a base market, then scale, or add basis points to, its constructed short-rate volatilities, at every expiry or at one. The server derives the snapshot and stores it under its own id with a record of its base and its ops. Nothing runs here.",
  units: "Scale multiplies every stored volatility in an expiry row by a factor from 0.25 to 4: 1.5 is fifty percent higher. Add is in basis points of normal volatility: 10 adds 10 bp to every strike in the row. Results are kept to 12 significant digits. Every volatility must stay above 0 and below 500 bp (0.05), the ceiling of the Hull-White sigma the calibration fits. No op adds or removes an expiry or a strike.",
  source: "These volatilities are a constructed illustrative analog on the short rate (realized Treasury yield volatility times a stated premium), for education. They are not market quotes. The long-yield volatility surface is copied unchanged; no op here shocks it.",
  measures: "Stochastic runs only. A Hull-White stochastic run calibrates the mean reversion a and volatility sigma to the at-the-money column, so a shock moves a, sigma and the fit error, and through them the width of the EVE distribution. The 12-month NII distribution widens only where the book carries income that depends on the rate path within the 12-month horizon; on the seeded vanilla book that income is path independent and its distribution does not move. The strike wings move with the at-the-money column and no run reads them. A uniform scale multiplies sigma by the same factor and leaves a unchanged; an add, or a change at one expiry, reshapes the term structure and moves a as well.",
  deterministic: "Deterministic results do not move: rate scenarios still shift the zero curve only, and no deterministic number reads a volatility. A plan run on a volatility-shocked market returns the base market's numbers.",
  where: "Studio does not run stochastic runs. Run the derived market and its base market in stochastic mode on the workbench Run page with the same seed and path count. Stochastic distributions shows each run's envelope: the calibrated a and sigma, the fit error against the 5 bp gate, and the EVE and 12-month NII distributions. Compare runs then sets the two envelopes side by side: the calibrated a and sigma, the fit error against the 5 bp gate, and each statistic of the EVE and 12-month NII distributions with B - A labelled derived. Both pages download a CSV. A stochastic run that supplies its own Hull-White parameters (modelParams) on a volatility-shocked market is refused, because it would skip the calibration and ignore the shock. A BGM run on a volatility-shocked market is refused: BGM calibrates to the long-yield volatility surface, which no op here shocks, so the shock would be silently ignored. Run Hull-White on the derived market, or BGM on its unshocked base.",
  copied: "The risk-free curve, the TLP nodes, the term-funding quotes and any rate indices are copied unchanged.",
  demonstration: "Every value entered here is a demonstration value, calibrated to nothing. The derived market label says so.",
} as const;

export interface VolatilityShocksViewProps {
  /** Every stored market: the base options, and the derived ones listed at the foot. */
  markets: MarketListItem[];
  /** The picked base market's volatility quotes as stored; null for none or while it is read. */
  base: VolBase | null;
  /** Why there is no base on screen for a picked id: "Reading market <id>" or the read error; null otherwise. */
  baseNote: string | null;
  draft: VolShockDraft;
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
  onOp(key: number, patch: Partial<Omit<VolOpDraft, "key">>): void;
  onLabel(label: string): void;
  onId(id: string): void;
  onPreview(): void;
  onSave(): void;
}

function OpRow(p: { n: number; row: VolOpDraft; base: VolBase; off: boolean; onOp: VolatilityShocksViewProps["onOp"]; onRemoveOp: VolatilityShocksViewProps["onRemoveOp"] }) {
  const { row, base } = p;
  return (
    <section className="card" aria-label={`Op ${p.n}`}>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Expiry</span>
          <select aria-label={`Expiry of op ${p.n}`} disabled={p.off} value={row.expiryYears === null ? "" : String(row.expiryYears)}
            onChange={(e) => p.onOp(row.key, { expiryYears: e.target.value === "" ? null : Number(e.target.value) })}>
            {expiryChoices(base).map((c) => (
              <option key={c.expiryYears === null ? "all" : c.expiryYears} value={c.expiryYears === null ? "" : String(c.expiryYears)}>{c.text}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Op</span>
          <select aria-label={`Op ${p.n} kind`} disabled={p.off} value={row.op} onChange={(e) => p.onOp(row.key, { op: e.target.value as ShortRateVolOpKind })}>
            {VOL_OP_CHOICES.map((c) => <option key={c.op} value={c.op}>{c.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Value</span>
          <input className="input" inputMode="decimal" aria-label={`Value of op ${p.n}`} disabled={p.off} value={row.valueText} onChange={(e) => p.onOp(row.key, { valueText: e.target.value })} />
          <span className="field-help">A factor from 0.25 to 4 for Scale by, basis points for Add</span>
        </label>
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" aria-label={`Remove op ${p.n}`} disabled={p.off} onClick={() => p.onRemoveOp(row.key)}>Remove</button>
      </div>
    </section>
  );
}

export function VolatilityShocksView(p: VolatilityShocksViewProps) {
  const reasonId = useId();
  const baseId = useId();
  const off = p.busy !== null;
  const blocked = p.block !== null || off;
  const stored = p.markets.filter((m) => m.derivedFromMarketId !== undefined);
  const { note, preview } = p;
  return (
    <>
      <section className="card" aria-label="About volatility shocks">
        <div className="card-title">Volatility shocks</div>
        {(["intro", "units", "source", "measures", "deterministic", "where", "copied", "demonstration"] as const).map((k) => (
          <p key={k} className="card-desc">{VOLATILITY_SHOCK_COPY[k]}</p>
        ))}
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
              <thead><tr><th scope="col">Expiry</th><th scope="col" className="num">Stored ATM vol (bp)</th></tr></thead>
              <tbody>
                {atmRows(p.base).map((r) => (
                  <tr key={r.expiryYears}>
                    <th scope="row">{tenorLabel(r.expiryYears)}</th>
                    <td className="num">{volBpText(r.normalVol)}</td>
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
              <thead><tr><th scope="col">Expiry</th><th scope="col" className="num">Base ATM vol (bp)</th><th scope="col" className="num">Derived ATM vol (bp)</th><th scope="col" className="num">Change (bp)</th><th scope="col" className="num">Quotes moved</th></tr></thead>
              <tbody>
                {preview.volChanges.map((c) => (
                  <tr key={c.expiryYears}>
                    <th scope="row">{tenorLabel(c.expiryYears)}</th>
                    <td className="num">{c.atmFrom === null ? "none" : volBpText(c.atmFrom)}</td>
                    <td className="num">{c.atmTo === null ? "none" : volBpText(c.atmTo)}</td>
                    <td className="num">{c.atmChangeBp === null ? "none" : c.atmChangeBp}</td>
                    <td className="num">{c.quotesChanged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="card-foot">Long-yield grid copied unchanged. Source: /api/market/derive/preview</p>
        </section>
      )}
      <section className="card table-card" aria-label="Stored derived markets">
        <div className="card-title">Stored derived markets</div>
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
export function VolatilityShocksPage(props: { ws: string; query: Record<string, string> }) {
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<VolShockDraft>(emptyVolShockDraft);
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState<ShockNote | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const list = useLoad<MarketListItem[]>(() => listMarket(), [refresh]);
  // A re-read after a save keeps the last list on screen until the new one lands.
  const [kept, setKept] = useState<MarketListItem[] | null>(null);
  if (list.state === "ok" && list.value !== kept) setKept(list.value);
  const baseLoad = useLoad<{ id: string; caps: VolBase } | null>(
    () => (draft.baseId === null ? Promise.resolve(null) : getMarket(draft.baseId).then((s) => ({ id: draft.baseId!, caps: { capQuotes: s.capQuotes } }))),
    [draft.baseId],
  );
  const base = baseLoad.state === "ok" && baseLoad.value !== null && baseLoad.value.id === draft.baseId ? baseLoad.value.caps : null;
  const baseNote = draft.baseId === null ? null : baseLoad.state === "loading" ? `Reading market ${draft.baseId}` : baseLoad.state === "error" ? reasonOf(baseLoad.error) : null;
  const req = volRequestOf(draft, base);
  const key = "body" in req ? requestKey(req.body) : null;
  const preview = shown !== null && previewShown(shown.key, key) ? shown.value : null;
  // Any edit of the form drops the last note: it described the request as it was.
  const edit = (next: (d: VolShockDraft) => VolShockDraft) => { setDraft(next); setNote(null); };
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
    <VolatilityShocksView
      markets={markets} base={base} baseNote={baseNote} draft={draft} block={"block" in req ? req.block : null} preview={preview} note={note} busy={working}
      planLink={note !== null && note.savedId !== null ? attachLinkFor(props.ws) : null}
      onBase={(id) => { edit((d) => setVolBase(d, id)); setShown(null); }}
      onAddOp={() => edit(addVolOp)}
      onRemoveOp={(k) => edit((d) => removeVolOp(d, k))}
      onOp={(k, patch) => edit((d) => setVolOpField(d, k, patch))}
      onLabel={(label) => edit((d) => ({ ...d, label }))}
      onId={(id) => edit((d) => ({ ...d, id }))}
      onPreview={() => void run("Previewing", false)}
      onSave={() => void run("Saving", true)}
    />
  );
}
