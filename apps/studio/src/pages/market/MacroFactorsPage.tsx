// apps/studio/src/pages/market/MacroFactorsPage.tsx
/**
 * Data > Market > Macro factors. Pick a stored market and
 * read the macro series it carries: a table of each series with its source
 * record, the validator's problems when there are any, and a chart per series
 * in which a month the provider did not publish is a gap. A load panel pastes or
 * uploads one authored house-price projection and saves it through the Piece 6c
 * derive routes as a market of its own. The server derives the snapshot; the
 * page adds, scales, rounds and fills nothing. The readers card names the one
 * feeder and the stored sets that map a series.
 */
import { useId, useState } from "react";
import { getMarket, listAssumptionSets, listMarket, previewDerivedMarket, saveDerivedMarket, type AssumptionSetListItem, type DerivedMarketPreview, type MarketDeriveRequest, type MarketListItem } from "@alm/reader";
import type { DerivedMarketSnapshot, MacroSeries } from "@alm/engine";
import { asOfMonthOf, monthAdd } from "@alm/engine/src/macro/macroFactors";
import { LinePlot } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import { reasonOf } from "../../errText";
import { useLoad } from "../../useLoad";
import { previewShown, requestKey, type ShockNote } from "../../scenarios/behavioralShockModel";
import { fundingSaveNoteOf } from "../../scenarios/fundingSpreadShockModel";
import { MACRO_COPY, macroProblems, macroRows, projectionRequestOf, readersText, seriesPoints, vintageText, type ProjectionDraft } from "../../market/macroModel";

export { MACRO_COPY } from "../../market/macroModel";

/** The About card, in reading order. */
const ABOUT_ORDER = ["intro", "history", "projection", "unemployment", "vintage", "gap", "demonstration"] as const;

/** The part of a stored market the page reads: its macro series, its as-of and the record of its base. */
export type MacroSource = Pick<DerivedMarketSnapshot, "macroFactors" | "derivedFrom" | "calibrationDate">;

export interface MacroFactorsViewProps {
  /** Every stored market: the picker options. */
  markets: MarketListItem[];
  /** The picked market as stored; null for none or while it is read. */
  chosen: { id: string; source: MacroSource } | null;
  /** Why there is no market on screen for a picked id: "Reading market <id>" or the read error; null otherwise. */
  chosenNote: string | null;
  /** The readers card lines (readersText of the stored sets). */
  readers: string[];
  draft: ProjectionDraft;
  /** The preview of the request on the form; null when none was made or the form has changed since. */
  preview: DerivedMarketPreview | null;
  note: ShockNote | null;
  /** What the page is waiting for; null when idle. */
  busy: string | null;
  onMarket(id: string | null): void;
  onDraft(patch: Partial<Omit<ProjectionDraft, "marketId">>): void;
  onPreview(): void;
  onSave(): void;
  /** An uploaded file that could not be read (Slice 1 M7): the page sets its note from the reason. */
  onUploadError(e: unknown): void;
}

/** The page note for an upload whose file could not be read, so the failure is said, not an unhandled rejection (Slice 1 M7, mfu-3). */
export function uploadNoteOf(e: unknown): ShockNote {
  return { kind: "error", text: `The file was not read: ${reasonOf(e)}`, problems: [], savedId: null };
}

/** The chosen market's as-of month, or null when the stored market carries no readable calibration date. */
function asOfOf(source: MacroSource): string | null {
  return typeof source.calibrationDate === "string" && /^\d{4}-\d{2}/.test(source.calibrationDate) ? asOfMonthOf(source) : null;
}

/** The derive request for the form, or why there is none yet. */
export function macroRequestFor(draft: ProjectionDraft, chosen: MacroFactorsViewProps["chosen"]): MarketDeriveRequest | { block: string } {
  if (draft.marketId === null) return { block: "Pick a market" };
  if (chosen === null || chosen.id !== draft.marketId) return { block: "Reading the market" };
  const asOf = asOfOf(chosen.source);
  if (asOf === null) return { block: "The market carries no as-of date" };
  return projectionRequestOf(draft, chosen, asOf);
}

const valueText = (v: number): string => String(v);
const tickText = (v: number, step: number): string => v.toFixed(Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)))));

function SeriesChart(p: { s: MacroSeries }) {
  const { s } = p;
  const points = seriesPoints(s) as Point[];
  return (
    <figure className="card viz">
      <div className="viz-head">
        <div className="card-title"><span className="mono">{s.id}</span>: {s.label}</div>
        <p className="viz-sub">{s.role === "history" ? "History" : "Authored projection"}, {s.unit}, from {s.firstMonth}, one point per month.</p>
      </div>
      <LinePlot
        series={[{ id: s.id, label: s.label, tone: s.role === "history" ? "muted" : "accent", points }]}
        xScale="linear"
        xTicks={(lo, hi) => monthTicks(lo, hi).map((t) => ({ value: t.value, label: monthAdd(s.firstMonth, t.value) }))}
        xLabel={(x) => monthAdd(s.firstMonth, x)}
        yTick={tickText}
        format={valueText}
        unit={s.unit}
        legend={false}
        markers={false}
        zoom
      />
      <figcaption>Source: /api/market</figcaption>
    </figure>
  );
}

export function MacroFactorsView(p: MacroFactorsViewProps) {
  const reasonId = useId();
  const marketId = useId();
  const off = p.busy !== null;
  const req = macroRequestFor(p.draft, p.chosen);
  const block = "block" in req ? req.block : null;
  const blocked = block !== null || off;
  const { note, preview, chosen } = p;
  const asOf = chosen === null ? null : asOfOf(chosen.source);
  const problems = chosen === null ? [] : macroProblems(chosen.source.macroFactors, asOf ?? "");
  // A block the validator refuses is listed, not drawn.
  const series = chosen === null || problems.length > 0 ? [] : chosen.source.macroFactors ?? [];
  const rows = macroRows(series);
  const readers = p.readers.length === 0 ? [MACRO_COPY.none] : p.readers;
  return (
    <>
      <section className="card" aria-label="About macro factors">
        <div className="card-title">Macro factors</div>
        {ABOUT_ORDER.map((k) => <p key={k} className="card-desc">{k === "vintage" ? vintageText(series) : MACRO_COPY[k]}</p>)}
      </section>
      <section className="card" aria-label="Readers">
        <div className="card-title">Readers</div>
        <p className="card-desc">{MACRO_COPY.readers}</p>
        <p className="card-desc">{MACRO_COPY.housing}</p>
        <ul className="diff-list">{readers.map((r, i) => <li key={i}>{r}</li>)}</ul>
        <p className="card-foot">Source: /api/assumption-sets</p>
      </section>
      <section className="card stack" aria-label="Pick a market">
        <div className="card-title">Market</div>
        <label className="field">
          <span className="field-label">Market</span>
          <select id={marketId} aria-label="Market" disabled={off} value={p.draft.marketId ?? ""} onChange={(e) => p.onMarket(e.target.value === "" ? null : e.target.value)}>
            <option value="">Pick a market</option>
            {p.markets.map((m) => <option key={m.id} value={m.id}>{m.id}: {m.label ?? "no label"} (as of {m.calibrationDate ?? "none"})</option>)}
          </select>
        </label>
        {p.chosenNote !== null ? <p className="muted" role="status">{p.chosenNote}</p> : null}
      </section>
      {chosen === null || problems.length === 0 ? null : (
        <section className="card" role="alert" aria-label="Problems">
          <span className="status status-breach">The macro series on {chosen.id} do not validate</span>
          <ul className="diff-list">{problems.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </section>
      )}
      {chosen === null ? null : (
        <section className="card table-card" aria-label="Series of the chosen market">
          <div className="card-title">Macro series on <span className="mono">{chosen.id}</span></div>
          {rows.length === 0 ? <p className="muted">This market carries no macro series.</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Series</th><th scope="col">Label</th><th scope="col">Kind</th><th scope="col">Role</th><th scope="col">Unit</th>
                    <th scope="col">First month</th><th scope="col">End month</th><th scope="col">Source</th><th scope="col">Gaps</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <th scope="row" className="mono">{r.id}</th>
                      <td>{r.label}</td>
                      <td>{r.kind}</td>
                      <td>{r.role}</td>
                      <td>{r.unit}</td>
                      <td className="mono">{r.firstMonth}</td>
                      <td className="mono">{r.endMonth}</td>
                      <td>{r.sourceText}</td>
                      <td>{r.gapsText ?? "none"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.some((r) => r.gapsText !== null) ? <p className="card-foot">{MACRO_COPY.gap}</p> : null}
        </section>
      )}
      {series.map((s) => <SeriesChart key={s.id} s={s} />)}
      {chosen === null ? null : (
        <section className="card stack" aria-label="Load a projection">
          <div className="card-title">Load an authored house-price projection</div>
          <p className="card-desc">
            One value per month from {asOf === null ? "the month after the as-of" : monthAdd(asOf, 1)}, as a ratio to the as-of month, one per line or separated by commas.
            The derived market is labelled an authored projection with demonstration values.
          </p>
          <div className="param-grid">
            <label className="field">
              <span className="field-label">Series id</span>
              <input className="input" aria-label="Series id" disabled={off} value={p.draft.id} onChange={(e) => p.onDraft({ id: e.target.value })} />
              <span className="field-help">Lowercase letters, digits and single hyphens, starting with a letter</span>
            </label>
            <label className="field">
              <span className="field-label">Label</span>
              <input className="input" aria-label="Label" disabled={off} value={p.draft.label} onChange={(e) => p.onDraft({ label: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Monthly values</span>
            <textarea className="input" aria-label="Monthly values" rows={6} disabled={off} value={p.draft.valuesText} onChange={(e) => p.onDraft({ valuesText: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Or upload a text file</span>
            <input type="file" aria-label="Upload values" accept=".csv,.txt,text/plain,text/csv" disabled={off}
              onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void f.text().then((t) => p.onDraft({ valuesText: t })).catch((err: unknown) => p.onUploadError(err)); }} />
          </label>
          <div className="sheet-actions">
            {/* Off by aria-disabled, not disabled, so a focused button keeps focus through a call (the Polish 1 rule). */}
            <button type="button" className="btn" aria-disabled={blocked ? true : undefined} aria-describedby={block !== null ? reasonId : undefined}
              onClick={blocked ? undefined : p.onPreview}>Preview</button>
            <button type="button" className="btn btn-primary" aria-disabled={blocked ? true : undefined} aria-describedby={block !== null ? reasonId : undefined}
              onClick={blocked ? undefined : p.onSave}>Save</button>
            {block !== null ? <span className="muted" id={reasonId} role="status">{block}</span> : null}
            {p.busy !== null ? <span className="muted" role="status">{p.busy}</span> : null}
          </div>
        </section>
      )}
      {note === null ? null : (
        <section className="card" role={note.kind === "created" || note.kind === "unchanged" ? "status" : "alert"} aria-label="Result">
          <span className={note.kind === "created" || note.kind === "unchanged" ? "status status-pass" : "status status-breach"}>{note.text}</span>
          {note.problems.length > 0 ? <ul className="diff-list">{note.problems.map((m, i) => <li key={i}>{m}</li>)}</ul> : null}
        </section>
      )}
      {preview === null ? null : (
        <section className="card table-card" aria-label="Preview">
          <div className="card-title">Preview: <span className="mono">{preview.id}</span></div>
          <p className="card-desc">{preview.label}</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Series</th><th scope="col">Change</th></tr></thead>
              <tbody>
                {(preview.macroChanges ?? []).map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className="mono">{c.id}</th>
                    <td>{c.change}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="card-foot">Source: /api/market/derive/preview</p>
        </section>
      )}
    </>
  );
}

interface Shown { key: string; value: DerivedMarketPreview }

const EMPTY_DRAFT: ProjectionDraft = { marketId: null, id: "", label: "", valuesText: "" };

/** The page: holds the draft, the chosen market read, the stored sets, the preview and the calls. */
export function MacroFactorsPage(_props: { query: Record<string, string> }) {
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<ProjectionDraft>(EMPTY_DRAFT);
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState<ShockNote | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const list = useLoad<MarketListItem[]>(() => listMarket(), [refresh]);
  // A re-read after a save keeps the last list on screen until the new one lands.
  const [kept, setKept] = useState<MarketListItem[] | null>(null);
  if (list.state === "ok" && list.value !== kept) setKept(list.value);
  const sets = useLoad<AssumptionSetListItem[]>(() => listAssumptionSets(), []);
  const marketLoad = useLoad<{ id: string; source: MacroSource } | null>(
    () => (draft.marketId === null ? Promise.resolve(null) : getMarket(draft.marketId).then((s) => ({
      id: draft.marketId!,
      source: { macroFactors: s.macroFactors, derivedFrom: s.derivedFrom, calibrationDate: s.calibrationDate },
    }))),
    [draft.marketId],
  );
  const chosen = marketLoad.state === "ok" && marketLoad.value !== null && marketLoad.value.id === draft.marketId ? marketLoad.value : null;
  const chosenNote = draft.marketId === null ? null : marketLoad.state === "loading" && chosen === null ? `Reading market ${draft.marketId}` : marketLoad.state === "error" ? reasonOf(marketLoad.error) : null;
  const req = macroRequestFor(draft, chosen);
  const key = "block" in req ? null : requestKey(req);
  const preview = shown !== null && previewShown(shown.key, key) ? shown.value : null;
  const readers = sets.state === "ok" ? readersText(sets.value) : sets.state === "error" ? [reasonOf(sets.error)] : ["Reading the assumption sets"];
  const run = async (what: string, save: boolean) => {
    if (working !== null || "block" in req) return;
    const body = req;
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
    <MacroFactorsView
      markets={markets} chosen={chosen} chosenNote={chosenNote} readers={readers} draft={draft} preview={preview} note={note} busy={working}
      onMarket={(id) => { setDraft({ ...EMPTY_DRAFT, marketId: id }); setNote(null); setShown(null); }}
      onDraft={(patch) => { setDraft((d) => ({ ...d, ...patch })); setNote(null); }}
      onPreview={() => void run("Previewing", false)}
      onSave={() => void run("Saving", true)}
      onUploadError={(err) => { setShown(null); setNote(uploadNoteOf(err)); }}
    />
  );
}
