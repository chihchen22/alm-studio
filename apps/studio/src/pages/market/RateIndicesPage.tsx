// apps/studio/src/pages/market/RateIndicesPage.tsx
/**
 * Data > Market > Rate indices. Pick a stored market and
 * read the rate indices it carries; set an index of one of three kinds (a
 * compounded window, a constant-maturity swap or a formula on a parent index) or shift the basis of one, preview the derived market, and
 * save it under its own id. The page reuses the derive routes. The
 * server derives the snapshot and computes every number printed here as a result
 * (the change in basis points included); the page adds, scales and rounds none
 * of them. The percent read-back beside a typed formula level is input help
 * (levelEcho), not a result. Nothing runs: the saved market is attached to the
 * workspace, below the page or on Market > Yield curves, and named as a run
 * setup's Market on Run > Setups.
 */
import { useId, useState } from "react";
import { flushSync } from "react-dom";
import {
  getIndexHistory, getMarket, listDerivedCurves, listMarket, previewDerivedMarket, reapplyMarket, saveDerivedMarket,
  type DerivedCurvesReply, type DerivedMarketPreview, type MarketListItem, type WorkspaceManifest,
} from "@alm/reader";
import type { RateIndexKind, RateIndexTenor, SwapTenorYears } from "@alm/engine";
import { ByField, useBy } from "../../controls/ByName";
import { errText, reasonOf } from "../../errText";
import { useLoad } from "../../useLoad";
import { awaitingCount, definitionRows, reapplyBody, stateText, type DefinitionRowView } from "../../market/definitionsModel";
import { previewShown, requestKey, type ShockNote } from "../../scenarios/behavioralShockModel";
import { ATTACH_SAVED_MARKET, attachLinkFor } from "../../scenarios/fundingSpreadShockModel";
import { DerivedAttach } from "./MarketPage";
import { IndexHistoryPanel } from "./IndexHistoryPanel";
import { landStartFill, startFillFor, startFillSourceOf } from "../../market/indexHistoryModel";
import {
  addHistoryOp, addRateIndexOp, baseOf, basisText, emptyRateIndexDraft, FORMULA_FORM_CHOICES, indexRows, indexTenorText, kindDefaults, levelEcho, parentChoices,
  RATE_INDEX_KIND_CHOICES, RATE_INDEX_TENOR_CHOICES, rateIndexRequestOf, rateIndexSaveNoteOf, NO_SPREAD_CURVE, removeRateIndexOp, setRateIndexMarket,
  setRateIndexOpField, shiftChoices, spreadCurveChoices, spreadCurveText, SWAP_TENOR_CHOICES,
  type FormulaForm, type RateIndexDraft, type RateIndexOpDraft, type RateIndexRowKind, type RateIndexSource, type ShiftChoice, type SpreadCurveChoice,
} from "../../market/rateIndexModel";

export const RATE_INDEX_COPY = {
  intro: "Name a rate index on a market so that a floating loan can reset on it. Pick a market to see the indices it carries, then set an index or shift the basis of one, preview the derived market, and save it under its own id. Nothing runs here: attach the saved market to this workspace, below or on Market > Yield curves, and name it as a run setup's Market on Run > Setups.",
  model: "An index is one of three kinds. A compounded window reads the run's one benchmark curve over 1, 3, 6 or 12 months with simple compounding, plus a constant basis; a one-month window with no basis is the one-month benchmark itself. A constant-maturity swap reads the path's forward par swap rate at 1 to 30 years on the curve's quoted basis, plus its basis; on a Treasury curve it is the CMT par yield. A formula reads another index on the same market, its parent: a coefficient (level) multiplies the parent's rate, and a beta (change) passes a share of each month's change in the parent through from a typed start value. Derived curves are built: a compounded window or a swap index may name one, saved on the Derived curves screen, and the curve's spread at the index tenor is added as one more constant.",
  formulas: "A formula's basis is its spread: on the level form it is added every month; on the change form it is added once, to the start. Shift a basis moves it. A lag, in whole months, reads the parent that many months back; before the cut-off it reads the parent's history where the parent has one, and the parent's value at the cut-off where it has none. A floor and a cap clip the index rate before the loan's margin, and a beta index carries the clipped rate into the next month. Formulas on formulas run in dependency order, at most five deep; a loop is refused.",
  history: "An index may carry a history: monthly fixings imported from a CSV or Excel file of dates and values, with the unit stated. A daily file keeps each month's last fixing. A formula with a lag reads its parent's history for the parent's months before the cut-off: a level formula from its own month 0, a beta formula from month 1, since its month 0 is its start plus basis. The parent's own months read the curve, and the history is never shocked. Open History on an index to import, see the series and the gap to the cut-off; the import adds a row that points the index at the history, saved with the market.",
  moves: "Rate scenarios and stochastic paths move every index through the benchmark curve. The basis stays static inside a run, as the TLP does. A basis shock is a second market, derived here, and compared with the first on Compare runs.",
  stochastic: "On a stochastic path a compounded window compounds the path's own one-month rates over its tenor, so it is read in arrears, and a swap index reads the path's own swap rate.",
  derivesFrom: "A new market derives from the chosen market's base, carrying the ops that built the chosen market first and then yours. The chosen market itself is never changed.",
  readers: "Floating-loan positions that name an index read it, floating term funding included. A floating loan that names none resets on the one-month benchmark plus its margin. A position that names an index the market does not carry is refused before any number is produced.",
  unchanged: "Swap floating legs stay on the one-month benchmark. Deposits, the deposit beta, the mortgage refinancing driver and new business read no index. A derived curve reaches index resets only: mortgages, client rates, new business and discounting read the base curve.",
  measures: "Coupons, NII and cash flows move with the index. EVE moves through the cash flows only, since discounting is unchanged. The FTP margin absorbs the basis. The repricing gap reads as before.",
  notBuilt: "Not built: fixings, which wait for seasoned floaters; averaging indices such as MTA or COFI-style; a convexity adjustment on swap indices; a separately bootstrapped curve for each index, since a derived curve is a spread over the run's one curve; daily-compounded forms; a basis or a spread that moves inside a run.",
  books: "A position names its index with rateIndexId in its JSON terms; the CSV import does not carry it. The seeded book synthetic-2500-indexed-v1 and the plan plan-synthetic-2500-indexed-v1 run on rate-indices-demo-v1.",
  demonstration: "Every value entered here is a demonstration value, calibrated to nothing. The derived market label says so.",
  none: "This market carries no rate indices.",
} as const;

/** The About card, in reading order; none is the empty state of the table, not a paragraph. */
const ABOUT_ORDER = ["intro", "model", "formulas", "history", "moves", "stochastic", "derivesFrom", "readers", "unchanged", "measures", "books", "demonstration", "notBuilt"] as const;

export interface RateIndicesViewProps {
  /** Every stored market: the picker options. */
  markets: MarketListItem[];
  /** The picked market as stored; null for none or while it is read. */
  chosen: { id: string; source: RateIndexSource } | null;
  /** Why there is no market on screen for a picked id: "Reading market <id>" or the read error; null otherwise. */
  chosenNote: string | null;
  draft: RateIndexDraft;
  /** Why Preview and Save are off; null when the request is complete. */
  block: string | null;
  /** The preview of the request on the form; null when none was made or the form has changed since. */
  preview: DerivedMarketPreview | null;
  note: ShockNote | null;
  /** What the page is waiting for; null when idle. */
  busy: string | null;
  /** Market > Yield curves, where the saved market is attached; null when nothing was saved. */
  planLink: string | null;
  /** The definitions the workspace holds, parents first (ruling 4); absent outside a workspace. */
  definitions?: DefinitionRowView[];
  /** The Re-apply control of carried definitions; null or absent when nothing is carried. */
  reapply?: ReapplyView | null;
  /** The derived curves a set row may name, by the curve's own id; absent or empty offers the base curve alone. */
  derivedCurves?: SpreadCurveChoice[];
  /** Why the derived curves are not listed: the read error; null or absent otherwise. */
  derivedCurvesNote?: string | null;
  /** The index whose History panel is open; null for none. */
  historyOpen: string | null;
  onHistory(indexId: string | null): void;
  /** An import landed: the page adds the row that points the index at the new history. */
  onImported(indexId: string, historyId: string): void;
  /** Clear the history: the page adds the row that clears it. */
  onClearHistory(indexId: string): void;
  /** The start fill's sentence (decision 53), shown beside the button of the row it names; null for none. */
  startFillNote: { key: number; text: string } | null;
  /** Fill a beta row's start from its index's history at the cut-off month. */
  /** The row whose fill is reading its history; null for none. Its button is off until the read lands. */
  startFilling: number | null;
  onFillStart(key: number): void;
  onMarket(id: string | null): void;
  onAddOp(kind: RateIndexRowKind): void;
  onRemoveOp(key: number): void;
  onOp(key: number, patch: Partial<Omit<RateIndexOpDraft, "key">>): void;
  onLabel(label: string): void;
  onId(id: string): void;
  onPreview(): void;
  onSave(): void;
}

export interface ReapplyView {
  /** Carried entries still waiting. */
  awaiting: number;
  busy: boolean;
  /** The sentence of the last call; null before one. */
  note: string | null;
  /** Why the button is off; null when it can act. */
  block: string | null;
  /** The typed name field, when the page asks for one. */
  by?: string;
  onBy?(v: string): void;
  onReapply(): void;
}

/** The definitions list: each row indented by its dependency level, with its status and the engine's refusal text. */
function DefinitionsCard(props: { rows: DefinitionRowView[]; reapply: ReapplyView | null }) {
  const { rows, reapply } = props;
  const reasonId = useId();
  if (rows.length === 0 && reapply === null) return null;
  const off = reapply !== null && (reapply.block !== null || reapply.busy);
  return (
    <section className="card table-card" aria-label="Definitions of this workspace">
      <div className="card-title">Definitions of this workspace</div>
      <p className="card-desc">Each definition is listed after the one it is derived from. A definition carried from the previous workspace waits until it is re-applied on this workspace's base snapshot; the engine's refusal is printed as it stands.</p>
      {rows.length === 0 ? null : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Definition</th><th scope="col">Depends on</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="def-row">
                  <th scope="row" className="mono" style={{ paddingLeft: `calc(var(--sp-3) + ${r.level} * var(--sp-5))` }}>{r.key}</th>
                  <td className="mono">{r.parentKey ?? "base snapshot"}</td>
                  <td>{stateText(r)}</td>
                  <td>{r.refusal ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reapply === null ? null : (
        <div className="sheet-actions">
          {reapply.onBy !== undefined ? <ByField value={reapply.by ?? ""} onChange={reapply.onBy} disabled={reapply.busy} /> : null}
          <button type="button" className="btn btn-primary" aria-disabled={off ? true : undefined} aria-describedby={reapply.block !== null ? reasonId : undefined}
            onClick={off ? undefined : reapply.onReapply}>Re-apply carried definitions</button>
          {reapply.block !== null ? <span className="muted" id={reasonId} role="status">{reapply.block}</span> : null}
          {reapply.busy ? <span className="muted" role="status">Re-applying</span> : null}
          {reapply.note !== null ? <span role="status">{reapply.note}</span> : null}
        </div>
      )}
      <p className="card-foot">Source: /api/workspaces/{"<id>"} blocks.market.derived and carried; POST /api/workspaces/{"<id>"}/market/reapply</p>
    </section>
  );
}

/** The settings of a formula row: the parent, the form, the coefficient or beta, the start value of a beta, the lag, the floor and the cap. */
function FormulaFields(p: {
  n: number; row: RateIndexOpDraft; off: boolean; parents: ShiftChoice[]; onOp: RateIndicesViewProps["onOp"];
  startFillNote: RateIndicesViewProps["startFillNote"]; startFilling: RateIndicesViewProps["startFilling"]; onFillStart: RateIndicesViewProps["onFillStart"];
}) {
  const { row } = p;
  const fillReasonId = useId();
  // Off by aria-disabled while its own read runs, so the focused button keeps focus (the Polish 1 rule).
  const filling = p.startFilling === row.key;
  const change = row.form === "change";
  const factor = change ? "Beta" : "Coefficient";
  const patchOf = (field: "startText" | "floorText" | "capText", v: string): Partial<Omit<RateIndexOpDraft, "key">> =>
    field === "startText" ? { startText: v } : field === "floorText" ? { floorText: v } : { capText: v };
  // A level is typed in basis points, like the basis; its help reads the typed value back as a percent.
  const level = (field: "startText" | "floorText" | "capText", name: string, help: string) => (
    <label className="field">
      <span className="field-label">{`${name} (bp)`}</span>
      <input className="input" inputMode="decimal" aria-label={`${name} of op ${p.n}`} disabled={p.off} value={row[field] ?? ""} onChange={(e) => p.onOp(row.key, patchOf(field, e.target.value))} />
      <span className="field-help">{levelEcho(row[field]) ?? help}</span>
    </label>
  );
  return (
    <>
      <label className="field">
        <span className="field-label">Parent</span>
        <select aria-label={`Parent of op ${p.n}`} disabled={p.off} value={row.parent ?? ""} onChange={(e) => p.onOp(row.key, { parent: e.target.value })}>
          <option value="">Pick a parent index</option>
          {p.parents.map((c) => <option key={c.id} value={c.id}>{c.text}</option>)}
        </select>
        <span className="field-help">The formula reads the parent's full rate, its basis and derived curve included</span>
      </label>
      <label className="field">
        <span className="field-label">Form</span>
        <select aria-label={`Form of op ${p.n}`} disabled={p.off} value={change ? "change" : "level"} onChange={(e) => p.onOp(row.key, { form: e.target.value as FormulaForm })}>
          {FORMULA_FORM_CHOICES.map((c) => <option key={c.form} value={c.form}>{c.text}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="field-label">{change ? "Beta (change)" : "Coefficient (level)"}</span>
        <input className="input" inputMode="decimal" aria-label={`${factor} of op ${p.n}`} disabled={p.off} value={row.factorText ?? ""} onChange={(e) => p.onOp(row.key, { factorText: e.target.value })} />
        <span className="field-help">{change ? "The share of each month's change in the parent that passes through, 0 to 2: 0.4 is 40 percent" : "The multiple of the parent's rate, -3 to 3, not 0"}</span>
      </label>
      {change ? level("startText", "Start value", "The published fixing at the cut-off, in basis points, spread included: 433 is 4.33 percent. The index starts at this value plus the basis, so leave the basis at 0 unless you are shocking it. Fill from history reads the index's own history at the cut-off month, minus the basis; the number written here is of record.") : null}
      {/* The start helper (decision 53): it writes the Start field and nothing else; the market is saved as usual. */}
      {change ? (
        <div className="field">
          <span className="field-label">From history</span>
          <button type="button" className="btn" style={{ justifySelf: "start" }} aria-label={`Fill the start of op ${p.n} from history`} disabled={p.off}
            aria-disabled={filling ? true : undefined} aria-describedby={filling ? fillReasonId : undefined}
            onClick={filling ? undefined : () => p.onFillStart(row.key)}>Fill start from history</button>
          {filling ? <span className="field-help" id={fillReasonId} role="status">Reading the index&apos;s history</span> : null}
          {p.startFillNote !== null && p.startFillNote.key === row.key ? <span className="field-help" role="status">{p.startFillNote.text}</span> : null}
        </div>
      ) : null}
      <label className="field">
        <span className="field-label">Lag (months)</span>
        <input className="input" inputMode="numeric" aria-label={`Lag of op ${p.n}`} disabled={p.off} value={row.lagText ?? ""} onChange={(e) => p.onOp(row.key, { lagText: e.target.value })} />
        <span className="field-help">Whole months, 0 to 12; the months before the cut-off read the parent's history where it has one, else its value at the cut-off</span>
      </label>
      {level("floorText", "Floor", "Leave empty for none; applies to the index rate before the loan's margin")}
      {level("capText", "Cap", "Leave empty for none; applies to the index rate before the loan's margin")}
    </>
  );
}

function OpRow(p: {
  n: number; row: RateIndexOpDraft; source: RateIndexSource; draft: RateIndexDraft; off: boolean; curves: SpreadCurveChoice[];
  onOp: RateIndicesViewProps["onOp"]; onRemoveOp: RateIndicesViewProps["onRemoveOp"];
  startFillNote: RateIndicesViewProps["startFillNote"]; startFilling: RateIndicesViewProps["startFilling"]; onFillStart: RateIndicesViewProps["onFillStart"];
}) {
  const { row } = p;
  const set = row.kind === "set";
  // A history row names an index and a history id, or null to clear; it has no basis field.
  const history = row.kind === "history";
  // The kind of a set row; a row with none is a compounded window.
  const indexKind: RateIndexKind = row.indexKind ?? "compounded-window";
  const formula = indexKind === "formula";
  const title = set ? "Set an index" : !history ? "Shift a basis" : row.historyId === null ? "Clear an index's history" : "Point an index at a history";
  return (
    <section className="card" aria-label={`Op ${p.n}`}>
      <div className="card-title">{title}</div>
      <div className="param-grid">
        {set ? (
          <>
            <label className="field">
              <span className="field-label">Kind</span>
              <select aria-label={`Kind of op ${p.n}`} disabled={p.off} value={indexKind} onChange={(e) => p.onOp(row.key, kindDefaults(e.target.value as RateIndexKind))}>
                {RATE_INDEX_KIND_CHOICES.map((c) => <option key={c.kind} value={c.kind}>{c.text}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Index id</span>
              <input className="input" aria-label={`Index id of op ${p.n}`} disabled={p.off} value={row.indexId} onChange={(e) => p.onOp(row.key, { indexId: e.target.value })} />
              <span className="field-help">Lowercase letters, digits and single hyphens, starting with a letter</span>
            </label>
            <label className="field">
              <span className="field-label">Label</span>
              <input className="input" aria-label={`Label of op ${p.n}`} disabled={p.off} value={row.label} onChange={(e) => p.onOp(row.key, { label: e.target.value })} />
            </label>
            {indexKind === "compounded-window" ? (
              <label className="field">
                <span className="field-label">Tenor</span>
                <select aria-label={`Tenor of op ${p.n}`} disabled={p.off} value={String(row.tenorMonths)}
                  onChange={(e) => p.onOp(row.key, { tenorMonths: Number(e.target.value) as RateIndexTenor })}>
                  {RATE_INDEX_TENOR_CHOICES.map((c) => <option key={c.tenorMonths} value={String(c.tenorMonths)}>{c.text}</option>)}
                </select>
              </label>
            ) : null}
            {indexKind === "constant-maturity-swap" ? (
              <label className="field">
                <span className="field-label">Swap tenor</span>
                <select aria-label={`Swap tenor of op ${p.n}`} disabled={p.off} value={String(row.tenorYears ?? 10)}
                  onChange={(e) => p.onOp(row.key, { tenorYears: Number(e.target.value) as SwapTenorYears })}>
                  {SWAP_TENOR_CHOICES.map((c) => <option key={c.tenorYears} value={String(c.tenorYears)}>{c.text}</option>)}
                </select>
                <span className="field-help">The path's forward par swap rate at this tenor, on the curve's quoted basis, with no convexity adjustment</span>
              </label>
            ) : null}
            {formula ? (
              <FormulaFields n={p.n} row={row} off={p.off} parents={parentChoices(p.source, p.draft, row.key)} onOp={p.onOp}
                startFillNote={p.startFillNote} startFilling={p.startFilling} onFillStart={p.onFillStart} />
            ) : null}
            {formula ? null : (
              <label className="field">
                <span className="field-label">Derived curve</span>
                <select aria-label={`Derived curve of op ${p.n}`} disabled={p.off} value={row.spreadCurve ?? ""}
                  onChange={(e) => p.onOp(row.key, { spreadCurve: e.target.value === "" ? undefined : e.target.value })}>
                  <option value="">{NO_SPREAD_CURVE}</option>
                  {p.curves.map((c) => <option key={c.id} value={c.id}>{c.text}</option>)}
                  {/* A chosen curve the list lacks is still what the request sends, so the select names it. */}
                  {row.spreadCurve !== undefined && row.spreadCurve !== "" && !p.curves.some((c) => c.id === row.spreadCurve)
                    ? <option value={row.spreadCurve}>{`${row.spreadCurve} (not listed)`}</option>
                    : null}
                </select>
                <span className="field-help">
                  {indexKind === "constant-maturity-swap"
                    ? "Its spread at the swap tenor, in months (12 x the years), is added to the reset; saved on the Derived curves screen"
                    : "Its spread at this tenor is added to the reset; saved on the Derived curves screen"}
                </span>
              </label>
            )}
          </>
        ) : (
          <label className="field">
            <span className="field-label">Index</span>
            <select aria-label={`Index of op ${p.n}`} disabled={p.off} value={row.indexId} onChange={(e) => p.onOp(row.key, { indexId: e.target.value })}>
              <option value="">Pick an index</option>
              {shiftChoices(p.source, p.draft, row.key).map((c) => <option key={c.id} value={c.id}>{c.text}</option>)}
            </select>
            {/* A history row's id sits under its Index select, in the same field. */}
            {history ? (
              <span className="field-help">
                {row.historyId === null ? "Clears the history" : <>History <span className="mono">{row.historyId}</span></>}
              </span>
            ) : null}
          </label>
        )}
        {history ? null : <label className="field">
          <span className="field-label">{set ? "Basis (bp)" : "Shift (bp)"}</span>
          <input className="input" inputMode="decimal" aria-label={`Value of op ${p.n}`} disabled={p.off} value={row.valueText} onChange={(e) => p.onOp(row.key, { valueText: e.target.value })} />
          <span className="field-help">
            {!set
              ? "Basis points added to the stored basis"
              : !formula
                ? "Basis in basis points: 300 is 3.00 percentage points"
                : row.form === "change"
                  ? "Added once to the start, so it moves the whole path; Shift a basis moves it. Leave it at 0 when the start is the published fixing."
                  : "The formula's spread in basis points; Shift a basis moves it"}
          </span>
        </label>}
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" aria-label={`Remove op ${p.n}`} disabled={p.off} onClick={() => p.onRemoveOp(row.key)}>Remove</button>
      </div>
    </section>
  );
}

export function RateIndicesView(p: RateIndicesViewProps) {
  const reasonId = useId();
  const marketId = useId();
  const historyId = useId();
  const off = p.busy !== null;
  const blocked = p.block !== null || off;
  const { note, preview, chosen } = p;
  const rows = chosen === null ? [] : indexRows(chosen.source);
  // The index whose History panel is open, when the chosen market carries it.
  const openRow = p.historyOpen === null ? undefined : rows.find((r) => r.id === p.historyOpen);
  const builds = chosen === null || chosen.source.derivedFrom === undefined ? null : baseOf(chosen.id, chosen.source).baseId;
  return (
    <>
      <section className="card" aria-label="About rate indices">
        <div className="card-title">Rate indices</div>
        {ABOUT_ORDER.map((k) => <p key={k} className="card-desc">{RATE_INDEX_COPY[k]}</p>)}
      </section>
      {p.definitions === undefined ? null : <DefinitionsCard rows={p.definitions} reapply={p.reapply ?? null} />}
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
      {chosen === null ? null : (
        <section className="card table-card" aria-label="Indices of the chosen market">
          <div className="card-title">Indices on <span className="mono">{chosen.id}</span></div>
          {rows.length === 0 ? <p className="muted">{RATE_INDEX_COPY.none}</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Index</th><th scope="col">Label</th><th scope="col">Settings</th><th scope="col" className="num">Basis</th><th scope="col">Derived curve</th><th scope="col">History</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    // aria-controls names the panel only while it is rendered, so it never points at a missing id.
                    const open = openRow !== undefined && openRow.id === r.id;
                    return (
                      <tr key={r.id}>
                        <th scope="row" className="mono">{r.id}</th>
                        <td>{r.label}</td>
                        <td>{r.tenorText}</td>
                        <td className="num">{r.basisText}</td>
                        <td className={r.spreadCurve === undefined ? undefined : "mono"}>{spreadCurveText(r.spreadCurve)}</td>
                        <td>
                          {r.historyId === undefined ? "None" : <span className="mono">{r.historyId}</span>}{" "}
                          <button type="button" className="btn btn-quiet btn-flush" aria-expanded={open} aria-controls={open ? historyId : undefined}
                            onClick={() => p.onHistory(open ? null : r.id)}>History</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* The open History panel (one at a time) is its own card after the table, outside .table-wrap, so it takes
              the card's width and none of the table's cell styles (review fix). */}
          {openRow === undefined ? null : (
            <div id={historyId} className="history-slot">
              <IndexHistoryPanel key={openRow.id} indexId={openRow.id} historyId={openRow.historyId} calibrationDate={chosen.source.calibrationDate} off={off}
                onImported={(id) => p.onImported(openRow.id, id)} onClear={() => p.onClearHistory(openRow.id)} />
            </div>
          )}
          {builds !== null ? <p className="card-foot">Builds on {builds}, the chosen market&apos;s base. Its own ops are carried first.</p> : null}
        </section>
      )}
      {chosen === null ? null : (
        <section className="card stack" aria-label="Derive a market">
          <div className="card-title">Derive a market</div>
          {p.draft.ops.map((row, i) => <OpRow key={row.key} n={i + 1} row={row} source={chosen.source} draft={p.draft} off={off} curves={p.derivedCurves ?? []} onOp={p.onOp} onRemoveOp={p.onRemoveOp}
            startFillNote={p.startFillNote} startFilling={p.startFilling} onFillStart={p.onFillStart} />)}
          {p.derivedCurvesNote != null ? <p className="muted" role="status">{p.derivedCurvesNote}</p> : null}
          <div className="sheet-actions">
            <button type="button" className="btn" disabled={off} onClick={() => p.onAddOp("set")}>Set an index</button>
            <button type="button" className="btn" disabled={off} onClick={() => p.onAddOp("shift")}>Shift a basis</button>
          </div>
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
      )}
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
              <thead><tr><th scope="col">Index</th><th scope="col">Settings</th><th scope="col" className="num">Base basis</th><th scope="col" className="num">Derived basis</th><th scope="col" className="num">Change (bp)</th><th scope="col">Derived curve</th><th scope="col">History</th></tr></thead>
              <tbody>
                {preview.indexChanges.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className="mono">{c.id}</th>
                    <td>{indexTenorText(c.to)}</td>
                    <td className="num">{c.from === null ? "not in the base" : basisText(c.from.basis)}</td>
                    <td className="num">{basisText(c.to.basis)}</td>
                    <td className="num">{c.basisChangeBp === null ? "none" : c.basisChangeBp}</td>
                    <td className={c.to.spreadCurve === undefined ? undefined : "mono"}>{spreadCurveText(c.to.spreadCurve)}</td>
                    <td className={c.to.historyId === undefined ? undefined : "mono"}>{c.to.historyId ?? "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.termFundingQuotesDropped > 0 ? <p className="card-foot">Term-funding quotes: {preview.termFundingQuotesDropped} not carried.</p> : null}
          <p className="card-foot">Source: /api/market/derive/preview</p>
        </section>
      )}
    </>
  );
}

interface Shown { key: string; value: DerivedMarketPreview }

/**
 * The page: holds the draft, the chosen market read, the preview and the calls. Inside a workspace it opens on the
 * base snapshot, lists the workspace's definitions and re-applies carried ones through the market block.
 */
export function RateIndicesPage(props: { ws: string; head?: WorkspaceManifest | null; onChanged?: () => void; query: Record<string, string> }) {
  const { ws, head = null } = props;
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<RateIndexDraft>(() => setRateIndexMarket(emptyRateIndexDraft(), head?.blocks.market.snapshot?.id ?? null));
  const [by, setBy] = useBy();
  const [reapplying, setReapplying] = useState(false);
  const [reapplyNote, setReapplyNote] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState<ShockNote | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  // The index whose History panel is open; another market closes it.
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  // The start fill's sentence (decision 53), by the row it names; any edit of the form drops it.
  const [startFillNote, setStartFillNote] = useState<{ key: number; text: string } | null>(null);
  const [startFilling, setStartFilling] = useState<number | null>(null);
  const list = useLoad<MarketListItem[]>(() => listMarket(), [refresh]);
  // A re-read after a save keeps the last list on screen until the new one lands.
  const [kept, setKept] = useState<MarketListItem[] | null>(null);
  if (list.state === "ok" && list.value !== kept) setKept(list.value);
  const marketLoad = useLoad<{ id: string; source: RateIndexSource } | null>(
    () => (draft.marketId === null ? Promise.resolve(null) : getMarket(draft.marketId).then((s) => ({ id: draft.marketId!, source: { rateIndices: s.rateIndices, derivedFrom: s.derivedFrom, calibrationDate: s.calibrationDate } }))),
    [draft.marketId],
  );
  const chosen = marketLoad.state === "ok" && marketLoad.value !== null && marketLoad.value.id === draft.marketId ? marketLoad.value : null;
  // The workspace's derived curves, offered on a set row by the curve's own id.
  const curvesLoad = useLoad<DerivedCurvesReply>(() => listDerivedCurves(ws), [ws, head?.revision]);
  const derivedCurves = curvesLoad.state === "ok" ? spreadCurveChoices(curvesLoad.value.curves) : [];
  const derivedCurvesNote = curvesLoad.state === "error" ? `Derived curves could not be read: ${reasonOf(curvesLoad.error)}` : null;
  const chosenNote = draft.marketId === null ? null : marketLoad.state === "loading" && chosen === null ? `Reading market ${draft.marketId}` : marketLoad.state === "error" ? reasonOf(marketLoad.error) : null;
  const req = rateIndexRequestOf(draft, chosen === null ? null : chosen.source);
  const key = "body" in req ? requestKey(req.body) : null;
  const preview = shown !== null && previewShown(shown.key, key) ? shown.value : null;
  // Any edit of the form drops the last note: it described the request as it was.
  const edit = (next: (d: RateIndexDraft) => RateIndexDraft) => { setDraft(next); setNote(null); setStartFillNote(null); };
  // The start helper (decision 53, ruling D2): the index's own history at the market's cut-off month, minus the typed
  // basis, written into the Start field. Nothing is stored until the market is saved (the B2 spread-helper pattern).
  // The fill lands on the draft as it stands at the write, never on the click-time copy: a row edited or removed
  // during the read is left alone (startFillLanding, the B2 race rule). The note is decided inside that same update,
  // run synchronously by flushSync, so it says "Filled from" only when the draft changed (B3b follow-up item 3).
  const onFillStart = async (rowKey: number) => {
    const row = draft.ops.find((o) => o.key === rowKey);
    if (row === undefined || chosen === null || startFilling === rowKey) return;
    const from = startFillSourceOf(draft, chosen.source, row.indexId);
    if ("refusal" in from) { setStartFillNote({ key: rowKey, text: from.refusal }); return; }
    const sent = { ...row };
    const calibrationDate = chosen.source.calibrationDate;
    setStartFilling(rowKey);
    setStartFillNote(null);
    try {
      const fill = startFillFor(await getIndexHistory(from.historyId), from.historyId, calibrationDate, sent);
      const out = landStartFill((fn) => flushSync(() => setDraft(fn)), rowKey, sent, fill);
      // The last save's note no longer describes the form once the fill wrote, so it goes.
      if (out.changed) setNote(null);
      setStartFillNote({ key: rowKey, text: out.note });
    } catch (e) {
      setStartFillNote({ key: rowKey, text: errText(e) });
    } finally {
      // Only this row's read is over; a read started on another row meanwhile keeps its button off.
      setStartFilling((k) => (k === rowKey ? null : k));
    }
  };
  const run = async (what: string, save: boolean) => {
    if (working !== null || !("body" in req)) return;
    const body = req.body;
    setWorking(what);
    setNote(null);
    try {
      if (save) {
        const reply = await saveDerivedMarket(body);
        setShown({ key: requestKey(body), value: reply });
        setNote(rateIndexSaveNoteOf(reply));
        setRefresh((n) => n + 1);
      } else {
        setShown({ key: requestKey(body), value: await previewDerivedMarket(body) });
      }
    } catch (e) {
      setShown(null);
      setNote(rateIndexSaveNoteOf(e));
    } finally {
      setWorking(null);
    }
  };
  if (list.state === "error") return <div className="card" role="alert">{reasonOf(list.error)}</div>;
  const markets = list.state === "ok" ? list.value : kept;
  if (markets === null) return <div className="card muted">Reading the markets</div>;
  const waiting = head === null ? 0 : awaitingCount(head.blocks.market);
  const onReapply = async () => {
    if (head === null || reapplying) return;
    setReapplying(true);
    setReapplyNote(null);
    try {
      const after = await reapplyMarket(head.id, reapplyBody(head, by.trim()));
      const left = awaitingCount(after.blocks.market);
      setReapplyNote(left === 0 ? "Every carried definition is re-applied." : `${left} carried ${left === 1 ? "definition is" : "definitions are"} still waiting or refused.`);
      props.onChanged?.();
    } catch (e) {
      setReapplyNote(errText(e));
    } finally {
      setReapplying(false);
    }
  };
  const reapplyBlock = head === null ? null : head.blocks.market.snapshot === null ? "Set the base snapshot first." : by.trim() === "" ? "Type your name to re-apply." : null;
  return (
    <>
      <RateIndicesView
        markets={markets} chosen={chosen} chosenNote={chosenNote} draft={draft} block={"block" in req ? req.block : null} preview={preview} note={note} busy={working}
        planLink={note !== null && note.savedId !== null ? attachLinkFor(ws) : null}
        definitions={head === null ? undefined : definitionRows(head.blocks.market)}
        derivedCurves={derivedCurves} derivedCurvesNote={derivedCurvesNote}
        reapply={head === null || waiting === 0 ? null : { awaiting: waiting, busy: reapplying, note: reapplyNote, block: reapplyBlock, by, onBy: setBy, onReapply: () => void onReapply() }}
        historyOpen={historyOpen}
        startFillNote={startFillNote}
        startFilling={startFilling}
        onFillStart={(k) => void onFillStart(k)}
        onHistory={setHistoryOpen}
        onImported={(indexId, id) => edit((d) => addHistoryOp(d, indexId, id))}
        onClearHistory={(indexId) => edit((d) => addHistoryOp(d, indexId, null))}
        onMarket={(id) => { edit((d) => setRateIndexMarket(d, id)); setShown(null); setHistoryOpen(null); }}
        onAddOp={(kind) => edit((d) => addRateIndexOp(d, kind))}
        onRemoveOp={(k) => edit((d) => removeRateIndexOp(d, k))}
        onOp={(k, patch) => edit((d) => setRateIndexOpField(d, k, patch))}
        onLabel={(label) => edit((d) => ({ ...d, label }))}
        onId={(id) => edit((d) => ({ ...d, id }))}
        onPreview={() => void run("Previewing", false)}
        onSave={() => void run("Saving", true)}
      />
      {/* The saved market is attached below (decision 42). A save bumps `refresh`, so the card re-reads the store and lists it. */}
      {head !== null && head.blocks.market.snapshot !== null ? <DerivedAttach key={refresh} head={head} onChanged={props.onChanged ?? (() => {})} /> : null}
    </>
  );
}
