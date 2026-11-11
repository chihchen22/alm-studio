// apps/studio/src/pages/market/CurveBuilderPage.tsx
/**
 * Market > Curve setups. The workspace's saved curve setups and the editor behind them:
 * a settings form with menus for interpolation, day count and compounding, a typed grid of quotes, a paste box, a fill
 * from the attached base snapshot, a preview of the built curve at its quote nodes, and Save, Make active and the
 * platform default. The server validates every setup and builds every curve; the page converts text to the engine's
 * block (market/curveSetupModel.ts) and prints the server's refusals as they stand.
 *
 * Preview reads nothing stored and writes nothing, so it stays open on a locked workspace; Save, Make active and the
 * platform default are the writes, and a locked, archived or superseded workspace turns them off with its sentence.
 */
import "../../styles/curve-builder.css";
import { useId, useRef, useState } from "react";
import type { CurveCompounding, CurveDayCount, CurveInstrument, CurveInterpolation, CurveQuoteType, CurveSetupBlock } from "@alm/engine";
import {
  ApiError, activateCurveSetup, deactivateCurveSetup, getCurveSetup, getMarket, getMarketCurve, listCurveSetups, previewCurveSetup, saveCurveSetup,
  type CurveSetupListRow, type CurveSetupPreview, type CurveSetupsReply, type WorkspaceManifest,
} from "@alm/reader";
import { ByField, useBy } from "../../controls/ByName";
import { writeBlock } from "../../controls/attachBodies";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { rememberCurveSetupLabels } from "../../rows/curveSetupLabels";
import {
  blockFromState, compoundingOptionsFor, COMPOUNDING_OPTIONS, CONVENTION_NOTE, DAY_COUNT_OPTIONS, defaultSetup, FUTURES_NOTE, INSTRUMENT_OPTIONS,
  INTERPOLATION_OPTIONS, labelFor, LINEAR_ZERO_PRESET, parsePaste, QUOTE_TYPE_OPTIONS, rowsFromQuotes, tenorTextOf, unmappedPairNote,
  type CurveSetupOption, type CurveSetupProblem, type GridRow, type PasteUnit,
} from "../../market/curveSetupModel";
import { defaultButtonText, marketDefaultOf, marketDefaultSentence, type MarketCurveRead } from "../../market/marketCurve";

// ---------------------------------------------------------------------------
// Copy

export const APPROX_SENTENCE = "Between month points the curve is a straight line in zero rate; values at month points follow the method you chose.";
export const NO_COMPOUNDING_SENTENCE = "Compounding does not apply to the rows entered.";
const INTRO =
  "A curve setup names the quotes a run's base curve is built from and the method that joins them. Save a setup under its own name, then make it active: the next run of this workspace builds its curve from it. An active setup always wins. With none active, runs use the platform default curve: version 2, log-linear on discount factor, built from the market's own quotes. A market pinned to the older default keeps version 1, linear in zero.";
const PASTE_HELP = "Paste two columns from Excel: tenor (3M, 1Y or a number of months) and value. Pasted rows come in as OIS swap par rates; change the instrument of a cash row in the grid. Futures rows are typed in the grid.";

// ---------------------------------------------------------------------------
// Editor state: the grid rows carry a key of their own, from a counter held in the state

export interface KeyedRow extends GridRow {
  key: number;
}

export interface EditorState {
  id: string;
  label: string;
  baseCurve: string;
  interpolation: CurveInterpolation;
  dayCount: CurveDayCount;
  compounding: CurveCompounding;
  rows: KeyedRow[];
  /** The key the next added row takes. */
  nextKey: number;
  /**
   * Moves on every change to the rows or to a menu setting (interpolation, day count, compounding), so a snapshot read
   * or a stored setup read that lands after such a change can tell (menus since the B1 follow-up, so a
   * settings-only edit is never overwritten). The name, label and curve family do not move it: a fill never writes
   * them, so typing a name while a fill reads must not cancel the fill.
   */
  version: number;
}

export type EditorFields = Partial<Pick<EditorState, "id" | "label" | "baseCurve" | "interpolation" | "dayCount" | "compounding">>;

/** A new setup: the model's defaults and no rows. */
export function emptyEditor(): EditorState {
  const d = defaultSetup();
  return { id: d.id, label: d.label, baseCurve: d.baseCurve, interpolation: d.interpolation, dayCount: d.dayCount, compounding: d.compounding, rows: [], nextKey: 0, version: 0 };
}

/** Rows appended at the end, each with the next key. */
export function appendRows(ed: EditorState, rows: readonly GridRow[]): EditorState {
  const keyed = rows.map((r, i) => ({ ...r, key: ed.nextKey + i }));
  return { ...ed, rows: [...ed.rows, ...keyed], nextKey: ed.nextKey + rows.length, version: ed.version + 1 };
}

/** One blank OIS par-rate row at the end. */
export function addRow(ed: EditorState): EditorState {
  return appendRows(ed, [{ instrument: "ois-swap", tenorText: "", quoteType: "par-rate", valueText: "", convexityText: "" }]);
}

const MENU_FIELDS = ["interpolation", "dayCount", "compounding"] as const;

/**
 * The settings changed. A menu change (interpolation, day count, compounding) moves the version as a row change
 * does; a name, label or curve family change does not (see EditorState.version).
 */
export function setFields(ed: EditorState, patch: EditorFields): EditorState {
  const menu = MENU_FIELDS.some((k) => patch[k] !== undefined && patch[k] !== ed[k]);
  return { ...ed, ...patch, version: menu ? ed.version + 1 : ed.version };
}

export function removeRow(ed: EditorState, key: number): EditorState {
  return { ...ed, rows: ed.rows.filter((r) => r.key !== key), version: ed.version + 1 };
}

/**
 * One row changed. A row that leaves futures drops its convexity (it applies to futures only); a row that becomes
 * futures reads par-rate, the one quote type a futures row takes.
 */
export function setRow(ed: EditorState, key: number, patch: Partial<GridRow>): EditorState {
  return {
    ...ed,
    version: ed.version + 1,
    rows: ed.rows.map((r) => {
      if (r.key !== key) return r;
      const next = { ...r, ...patch };
      if (next.instrument === "futures") next.quoteType = "par-rate";
      else next.convexityText = "";
      return next;
    }),
  };
}

/** A stored setup in the editor, rows keyed from 0. */
export function editorFromBlock(b: CurveSetupBlock): EditorState {
  const rows: GridRow[] = b.inputs.map((x) => ({
    instrument: x.instrument,
    tenorText: tenorTextOf(x.tenorMonths),
    quoteType: x.quoteType,
    valueText: String(x.value),
    convexityText: x.convexityBp === undefined ? "" : String(x.convexityBp),
  }));
  return appendRows({ id: b.id, label: b.label, baseCurve: b.baseCurve, interpolation: b.interpolation, dayCount: b.dayCount, compounding: b.compounding, rows: [], nextKey: 0, version: 0 }, rows);
}

const replacedLine = (n: number): string[] => (n === 0 ? [] : [`Replaced ${n} ${n === 1 ? "row" : "rows"}.`]);

/** A stored setup read that lands after the editor changed: nothing is replaced. */
export const loadRaceSentence = (id: string): string => `The editor changed while ${id} was loading; nothing was replaced.`;

/**
 * What a stored setup read compares when it lands: the version (rows and menus) plus the name, label and curve family,
 * which do not move the version (see EditorState.version) but which a load would overwrite.
 */
export type EditorMark = Pick<EditorState, "version" | "id" | "label" | "baseCurve">;

export function markOf(ed: EditorState): EditorMark {
  return { version: ed.version, id: ed.id, label: ed.label, baseCurve: ed.baseCurve };
}

/**
 * A stored setup loaded over the editor: the new editor (its version moved past the old one) and the lines to print.
 * `started` is the editor's mark (markOf) when the read began, when there was a read. An editor that changed since in
 * any field the load replaces (a cell, a menu, the name, the label or the curve family) is left alone and the screen
 * says so.
 */
export function loadOutcome(ed: EditorState, b: CurveSetupBlock, started?: EditorMark): { editor: EditorState; lines: string[] } {
  if (started !== undefined) {
    const now = markOf(ed);
    const moved = (Object.keys(now) as Array<keyof EditorMark>).some((k) => now[k] !== started[k]);
    if (moved) return { editor: ed, lines: [loadRaceSentence(b.id)] };
  }
  const loaded = editorFromBlock(b);
  return {
    editor: { ...loaded, version: ed.version + 1 },
    lines: [`Editing ${b.id}. Save under the same name to replace it.`, ...replacedLine(ed.rows.length)],
  };
}

export const FILL_RACE_SENTENCE = "The quotes or settings changed while the snapshot was loading; nothing was replaced.";

/**
 * A snapshot fill landing on the editor. `started` is the editor's version when the read began: a grid changed since
 * (a paste, a typed cell) is left alone and the screen says so. A fill with no rows leaves the grid as it is.
 */
export function fillOutcome(ed: EditorState, started: number, f: SnapshotFill): { editor: EditorState; lines: string[] } {
  if (ed.version !== started) return { editor: ed, lines: [FILL_RACE_SENTENCE] };
  if (f.rows.length === 0) return { editor: ed, lines: [f.note] };
  const next = appendRows({ ...ed, rows: [] }, f.rows);
  const withConvention = f.convention === null ? next : { ...next, dayCount: f.convention.dayCount, compounding: f.convention.compounding };
  return { editor: withConvention, lines: [f.note, ...replacedLine(ed.rows.length)] };
}

/**
 * The lines a successful save prints. `now` is the editor when the save lands: when the block it describes is no longer
 * the one sent (any setting, name or cell changed while the save was in flight), the screen says the change is not
 * saved yet. The block is compared, not the version, so a name or label change counts.
 */
export function saveLines(sent: CurveSetupBlock, now: EditorState): string[] {
  const shown = blockFromState(now).block;
  if (shown !== null && JSON.stringify(shown) === JSON.stringify(sent)) return [`Saved ${sent.id}.`];
  return [`Saved ${sent.id} as it stood when Save was pressed. The editor changed after the save started; save again to keep the change.`];
}

/** A stored reply shown only while the request it answered is the one on screen. */
export function shownFor<T>(shown: { key: string; value: T } | null, key: string | null): T | null {
  return shown !== null && key !== null && shown.key === key ? shown.value : null;
}

/**
 * The block a preview sends. Preview needs no name, so a name that cannot name a slot is replaced by "preview" and a
 * blank label by the name; Save sends the block as typed and stays off until the name is valid.
 */
export function previewBlock(b: CurveSetupBlock): CurveSetupBlock {
  const id = setupNameProblem(b.id) === null ? b.id : "preview";
  return { ...b, id, label: b.label !== "" ? b.label : b.id !== "" ? b.id : "preview" };
}

// ---------------------------------------------------------------------------
// Pure readings for the screen

const SETUP_NAME_PATTERN = /^[A-Za-z0-9._-]{1,70}$/;

/** The id derived curves use for the platform's own curve, restated; the server refuses it as a setup id. */
const RESERVED_SETUP_ID = "platform-default";

/** Why the setup name cannot name a slot (the server's lineage rule and reserved id, restated); null when it can. */
export function setupNameProblem(id: string): string | null {
  if (!SETUP_NAME_PATTERN.test(id)) return "Name the setup: 1 to 70 letters, digits, dots, underscores or hyphens.";
  if (id === RESERVED_SETUP_ID) return `The curve setup id "${RESERVED_SETUP_ID}" is reserved for the platform's own curve; pick another id.`;
  return null;
}

/**
 * The compounding choices the rows allow: the options every row that reads compounding accepts. A discount-factor
 * row and a futures row read none, so they do not narrow the menu. No rows: every option. Rows of which none reads
 * compounding: an empty list (the screen says compounding does not apply).
 */
export function compoundingChoices(rows: readonly GridRow[]): CurveSetupOption<CurveCompounding>[] {
  if (rows.length === 0) return [...COMPOUNDING_OPTIONS];
  const lists = rows.map((r) => compoundingOptionsFor(r.quoteType, r.instrument)).filter((l) => l.length > 0);
  if (lists.length === 0) return [];
  return COMPOUNDING_OPTIONS.filter((o) => lists.every((l) => l.some((x) => x.value === o.value)));
}

/** A cell that cannot be read, as the screen prints it. */
export function problemText(p: CurveSetupProblem): string {
  return `Row ${p.row}, ${p.field}: ${p.why}`;
}

/** The menu options plus the current value verbatim when the list does not hold it (a value the server sent). */
function withCurrent(options: readonly CurveSetupOption<string>[], value: string): CurveSetupOption<string>[] {
  return options.some((o) => o.value === value) ? [...options] : [...options, { value, label: labelFor(options, value) }];
}

/** The snapshot's curve convention as the menus read it; null for a convention this screen does not map. */
export function conventionOf(curveConvention: string): { dayCount: CurveDayCount; compounding: CurveCompounding } | null {
  if (curveConvention === "annual_act360") return { dayCount: "ACT/360", compounding: "annual" };
  if (curveConvention === "semiannual_bond") return { dayCount: "ACT/365", compounding: "semi-annual" };
  return null;
}

export interface SnapshotFill {
  rows: GridRow[];
  dropped: string[];
  convention: { dayCount: CurveDayCount; compounding: CurveCompounding } | null;
  note: string;
}

/** The grid and the convention menus from the attached snapshot's curve quotes. */
export function fillFromSnapshot(snap: { curveQuotes?: readonly { term?: string; tYears: number; instrumentType: string; rate: number }[]; curveConvention?: string }): SnapshotFill {
  if (snap.curveQuotes === undefined || snap.curveQuotes.length === 0) {
    return { rows: [], dropped: [], convention: null, note: "The attached snapshot carries no curve quotes." };
  }
  const { rows, dropped } = rowsFromQuotes(snap.curveQuotes);
  const raw = snap.curveConvention ?? "";
  const convention = conventionOf(raw);
  const note = convention === null
    ? `The snapshot's curve convention ${raw === "" ? "(none given)" : raw} is not one this screen maps; day count and compounding are unchanged.`
    : `Day count and compounding follow the snapshot: ${labelFor(DAY_COUNT_OPTIONS, convention.dayCount)}, ${labelFor(COMPOUNDING_OPTIONS, convention.compounding)}.`;
  return { rows, dropped, convention, note };
}

export const PRESET_LOADED_SENTENCE = `Loaded the preset ${LINEAR_ZERO_PRESET.label} from the attached snapshot. Save it, then make it active to run on it.`;

/**
 * The curve family label the platform default gives the fill's convention (fromSnapshot.ts: semiannual_bond is UST,
 * annual_act360 is SOFR); null for a convention this screen does not map.
 */
function familyOf(convention: SnapshotFill["convention"]): string | null {
  if (convention?.dayCount === "ACT/365" && convention.compounding === "semi-annual") return "UST";
  if (convention?.dayCount === "ACT/360" && convention.compounding === "annual") return "SOFR";
  return null;
}

/**
 * The "Linear in zero (month grid)" preset landing on the editor: the snapshot fill as Fill
 * from attached snapshot makes it, then the preset's name, label and interpolation, linear in zero rate. A grid that
 * changed while the snapshot was read, or a snapshot with no quotes, leaves the editor as it is, as a fill does.
 */
export function presetOutcome(ed: EditorState, started: number, f: SnapshotFill): { editor: EditorState; lines: string[] } {
  const out = fillOutcome(ed, started, f);
  if (out.editor === ed) return out;
  const family = familyOf(f.convention);
  const editor = setFields(out.editor, {
    id: LINEAR_ZERO_PRESET.id,
    label: LINEAR_ZERO_PRESET.label,
    interpolation: LINEAR_ZERO_PRESET.interpolation,
    ...(family === null ? {} : { baseCurve: family }),
  });
  return { editor, lines: [PRESET_LOADED_SENTENCE, ...out.lines] };
}

/** Pasted text as grid rows: OIS swap par rates, the skipped lines as the parser words them, and the unit it read. */
export function pastedRows(text: string, unit: PasteUnit): { rows: GridRow[]; skipped: string[]; unitUsed: "decimal" | "percent" } {
  const r = parsePaste(text, { unit });
  return {
    rows: r.rows.map((x) => ({ instrument: "ois-swap", tenorText: tenorTextOf(x.tenorMonths), quoteType: "par-rate", valueText: String(x.value), convexityText: "" })),
    skipped: r.skipped.map((s) => s.why),
    unitUsed: r.unitUsed,
  };
}

const pct4 = (z: number): string => (z * 100).toFixed(4);
const df6 = (d: number): string => d.toFixed(6);
const rowsWord = (n: number): string => `${n} ${n === 1 ? "row" : "rows"}`;

const UNIT_OPTIONS: readonly { value: PasteUnit; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "percent", label: "Percent" },
  { value: "decimal", label: "Decimal" },
];

// ---------------------------------------------------------------------------
// The view: props only

export interface PasteView {
  text: string;
  unit: PasteUnit;
  /** The last "Add pasted rows": how many rows came in, every skipped line verbatim, and the unit the values were read in. */
  result: { added: number; skipped: string[]; unitUsed: "decimal" | "percent" } | null;
}

export interface ResultNote {
  ok: boolean;
  /** One line each: a sentence, or the server's refusals verbatim. */
  lines: string[];
}

export interface CurveBuilderViewProps {
  /** The saved setups; null while the list is first read. */
  setups: CurveSetupListRow[] | null;
  /** Slots whose document is gone, as the server names them. */
  missing: { id: string; problem: string }[];
  listError: string | null;
  editor: EditorState;
  /** The head's active curve setup pointer (a document id); null when the workspace runs on the platform default. */
  activeId: string | null;
  /** Why this workspace takes no write (writeBlock); null when it does. */
  blocked: string | null;
  /** The setup list is being read again (after a write): Edit waits for it, so it never opens a document the list has moved past. */
  listReloading?: boolean;
  /** The workspace has a base snapshot to fill from. */
  hasSnapshot: boolean;
  /** The default the base snapshot builds with no setup on it (market/marketCurve.ts); absent or null while it is read. */
  marketDefault?: MarketCurveRead | null;
  /** What the last preset load did, shown under the preset; absent or null when none ran. */
  preset?: { lines: string[]; dropped: string[] } | null;
  onPreset?(): void;
  by: string;
  /** What the page is waiting for; null when idle. */
  busy: string | null;
  note: ResultNote | null;
  paste: PasteView;
  fill: { lines: string[]; dropped: string[] } | null;
  /** The preview of the editor as it stands; null when none was made or the editor changed since. */
  preview: CurveSetupPreview | null;
  previewError: string | null;
  onBy(v: string): void;
  onEdit(docId: string): void;
  onActivate(docId: string): void;
  onDeactivate(): void;
  onNew(): void;
  onField(patch: EditorFields): void;
  onRow(key: number, patch: Partial<GridRow>): void;
  onAddRow(): void;
  onRemoveRow(key: number): void;
  onPasteText(v: string): void;
  onPasteUnit(v: PasteUnit): void;
  onPasteAdd(): void;
  onFill(): void;
  onPreview(): void;
  onSave(): void;
}

/**
 * The presets under the saved setups: one, "Linear in zero (month grid)", which loads the
 * attached snapshot's quotes into the editor joined linear in zero rate. Loading writes nothing; Save and Make active do.
 */
function PresetList(p: CurveBuilderViewProps) {
  const fillWhy = p.hasSnapshot ? null : "Attach a base snapshot on Yield curves first.";
  const name = LINEAR_ZERO_PRESET.label;
  return (
    <div className="cb-presets" role="group" aria-label="Presets">
      <div className="cb-presets-title">Presets</div>
      <ul className="cb-list">
        <li className="cb-item">
          <div className="cb-item-head">
            <span className="cb-item-label">{name}</span>
            <span className="chip">Preset</span>
          </div>
          <span className="muted">{LINEAR_ZERO_PRESET.note}</span>
          <div className="cb-item-actions">
            <button type="button" className="btn" aria-label={`Load ${name} into the editor`} disabled={p.busy !== null || fillWhy !== null} onClick={p.onPreset}>Load into the editor</button>
            {fillWhy !== null ? <span className="muted">{fillWhy}</span> : null}
          </div>
          {p.preset === undefined || p.preset === null ? null : (
            <div className="cb-result" role="status">
              {p.preset.lines.map((line, i) => <p key={i}>{line}</p>)}
              {p.preset.dropped.length > 0 ? <p className="field-help">{`Not filled (shorter than one month): ${p.preset.dropped.join(", ")}`}</p> : null}
            </div>
          )}
        </li>
      </ul>
    </div>
  );
}

function SetupList(p: CurveBuilderViewProps) {
  const off = p.busy !== null;
  const writeOff = p.blocked !== null;
  // The head's pointer decides, not the list: an active document missing from the store is listed under `missing`, and
  // the way back to the platform default must stay open.
  const anyActive = p.activeId !== null;
  const activeGone = p.activeId !== null && p.setups !== null && !p.setups.some((s) => s.id === p.activeId);
  const md = p.marketDefault ?? null;
  const mdSentence = md === null ? null : marketDefaultSentence(md);
  return (
    <section className="card" aria-label="Saved curve setups">
      <div className="card-title">Saved curve setups</div>
      {p.listError !== null ? <p role="alert">{p.listError}</p> : null}
      {p.setups === null && p.listError === null ? <p className="muted">Reading the curve setups</p> : null}
      {activeGone ? <p className="card-desc">The active curve setup is missing from the store. Runs are refused until you use the platform default curve.</p>
        : p.setups !== null && p.setups.length === 0 ? <p className="card-desc">This workspace holds no curve setup. Runs use the platform default curve.{mdSentence === null ? null : ` ${mdSentence}`}</p> : null}
      {p.setups !== null && p.setups.length > 0 ? (
        <ul className="cb-list">
          {p.setups.map((s) => (
            <li key={s.id} className={s.active ? "cb-item cb-item-on" : "cb-item"}>
              <div className="cb-item-head">
                <span className="cb-item-label">{s.label === "" ? s.id : s.label}</span>
                {s.active ? <span className="chip cb-active">Active</span> : null}
              </div>
              <span className="mono muted cb-item-id">{s.id}</span>
              <span className="muted">
                {`${labelFor(INTERPOLATION_OPTIONS, s.interpolation)}, ${labelFor(DAY_COUNT_OPTIONS, s.dayCount)}, ${labelFor(COMPOUNDING_OPTIONS, s.compounding)}, ${rowsWord((s.rows ?? []).length)}`}
              </span>
              <div className="cb-item-actions">
                <button type="button" className="btn" aria-label={`Edit ${s.label === "" ? s.id : s.label}`} disabled={off || p.listReloading === true} onClick={() => p.onEdit(s.id)}>Edit</button>
                {s.active ? null : (
                  <button type="button" className="btn" aria-label={`Make ${s.label === "" ? s.id : s.label} active`} disabled={off || writeOff || p.by.trim() === ""} onClick={() => p.onActivate(s.id)}>Make active</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {/* The active document's own missing line is the readiness sentence below; it is not said twice. */}
      {p.missing.filter((m) => !(activeGone && m.id === p.activeId)).map((m) => <p key={m.id} className="field-help field-error" role="alert">{`${m.id}: ${m.problem}`}</p>)}
      {activeGone ? <p className="field-help field-error" role="alert">{`The active curve setup ${p.activeId} is not in the store.`}</p> : null}
      {anyActive ? (
        <>
          <div className="sheet-actions">
            <button type="button" className="btn" disabled={off || writeOff || p.by.trim() === ""} onClick={p.onDeactivate}>{defaultButtonText(md)}</button>
          </div>
          {mdSentence === null ? null : <p className="field-help">{mdSentence}</p>}
        </>
      ) : null}
      <PresetList {...p} />
      {p.blocked !== null ? <p className="field-help" role="status">{p.blocked}</p> : null}
      {/* The same hint on an empty list: a write still needs the name (B1 follow-up). */}
      {p.blocked === null && p.by.trim() === "" && p.setups !== null ? <p className="field-help">Type your name below to save a setup or make one active.</p> : null}
    </section>
  );
}

function SettingsForm(p: CurveBuilderViewProps & { choices: CurveSetupOption<CurveCompounding>[]; nameProblem: string | null }) {
  const ed = p.editor;
  const offered = p.choices.some((o) => o.value === ed.compounding);
  const known = COMPOUNDING_OPTIONS.some((o) => o.value === ed.compounding);
  const compounding = offered ? p.choices : [...p.choices, { value: ed.compounding, label: known ? `${labelFor(COMPOUNDING_OPTIONS, ed.compounding)} (not offered)` : ed.compounding }];
  const notOffered = offered ? null : `${labelFor(COMPOUNDING_OPTIONS, ed.compounding)} is not offered for the rows entered.`;
  const unmappedNote = unmappedPairNote(ed.dayCount, ed.compounding);
  return (
    <section className="card" aria-label="Settings">
      <div className="card-title">Settings</div>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Setup name</span>
          <input className="input" aria-label="Setup name" aria-invalid={ed.id !== "" && p.nameProblem !== null ? true : undefined} value={ed.id} onChange={(e) => p.onField({ id: e.target.value })} />
          <span className="field-help">Saving under the same name replaces that setup; a new name adds one</span>
        </label>
        <label className="field">
          <span className="field-label">Label</span>
          <input className="input" aria-label="Label" value={ed.label} onChange={(e) => p.onField({ label: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Curve family</span>
          <input className="input" aria-label="Curve family" value={ed.baseCurve} onChange={(e) => p.onField({ baseCurve: e.target.value })} />
          <span className="field-help">A label, for example SOFR or UST</span>
        </label>
        <label className="field">
          <span className="field-label">Interpolation</span>
          <select aria-label="Interpolation" value={ed.interpolation} onChange={(e) => p.onField({ interpolation: e.target.value as CurveInterpolation })}>
            {withCurrent(INTERPOLATION_OPTIONS, ed.interpolation).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Day count</span>
          <select aria-label="Day count" value={ed.dayCount} onChange={(e) => p.onField({ dayCount: e.target.value as CurveDayCount })}>
            {withCurrent(DAY_COUNT_OPTIONS, ed.dayCount).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Compounding</span>
          {p.choices.length === 0 ? <p className="field-help">{NO_COMPOUNDING_SENTENCE}</p> : (
            <>
              <select aria-label="Compounding" title={notOffered ?? undefined} value={ed.compounding} onChange={(e) => p.onField({ compounding: e.target.value as CurveCompounding })}>
                {compounding.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {notOffered !== null ? <span className="field-help field-error">{notOffered}</span> : null}
            </>
          )}
        </div>
      </div>
      {ed.id !== "" && p.nameProblem !== null ? <p className="field-help field-error" role="alert">{p.nameProblem}</p> : null}
      <p className="field-help cb-note">{CONVENTION_NOTE}</p>
      {unmappedNote === undefined ? null : <p className="field-help cb-note">{unmappedNote}</p>}
    </section>
  );
}

function GridCard(p: CurveBuilderViewProps & { problems: CurveSetupProblem[] }) {
  const rows = p.editor.rows;
  const futures = rows.some((r) => r.instrument === "futures");
  return (
    <section className="card table-card" aria-label="Quotes">
      <div className="card-title">Quotes</div>
      <p className="card-desc">One row per quote. Type the tenor as 3M, 1Y or a number of months, and a rate as a decimal (0.0431) or with a percent sign (4.31%).</p>
      {rows.length === 0 ? <p className="muted">No rows yet. Add a row, paste from Excel, or fill from the attached snapshot.</p> : (
        <div className="table-wrap cb-grid">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Row</th><th scope="col">Instrument</th><th scope="col">Tenor</th><th scope="col">Quote type</th><th scope="col">Value</th>
                {futures ? <th scope="col">Convexity, bp</th> : null}<th scope="col">Remove</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const n = i + 1;
                const fut = r.instrument === "futures";
                return (
                  <tr key={r.key}>
                    <th scope="row" className="num">{n}</th>
                    <td>
                      <select aria-label={`Instrument, row ${n}`} value={r.instrument} onChange={(e) => p.onRow(r.key, { instrument: e.target.value as CurveInstrument })}>
                        {withCurrent(INSTRUMENT_OPTIONS, r.instrument).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                    <td><input className="input cb-tenor" aria-label={`Tenor, row ${n}`} value={r.tenorText} onChange={(e) => p.onRow(r.key, { tenorText: e.target.value })} /></td>
                    <td>
                      {fut ? <span className="muted">Price</span> : (
                        <select aria-label={`Quote type, row ${n}`} value={r.quoteType} onChange={(e) => p.onRow(r.key, { quoteType: e.target.value as CurveQuoteType })}>
                          {withCurrent(QUOTE_TYPE_OPTIONS, r.quoteType).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      )}
                    </td>
                    <td><input className="input cb-value" aria-label={`Value, row ${n}`} inputMode="decimal" value={r.valueText} onChange={(e) => p.onRow(r.key, { valueText: e.target.value })} /></td>
                    {futures ? (
                      <td>
                        {fut ? <input className="input cb-value" aria-label={`Convexity, row ${n}`} inputMode="decimal" value={r.convexityText} onChange={(e) => p.onRow(r.key, { convexityText: e.target.value })} />
                          : <span className="muted">Not used</span>}
                      </td>
                    ) : null}
                    <td><button type="button" className="btn btn-quiet" aria-label={`Remove row ${n}`} onClick={() => p.onRemoveRow(r.key)}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={p.onAddRow}>Add a row</button>
      </div>
      {futures ? <p className="field-help cb-note">{FUTURES_NOTE}</p> : null}
      {p.problems.length > 0 ? <ul className="diff-list cb-lines" aria-label="Cells that cannot be read">{p.problems.map((x, i) => <li key={i}>{problemText(x)}</li>)}</ul> : null}
    </section>
  );
}

function PasteCard(p: CurveBuilderViewProps) {
  const off = p.busy !== null;
  const fillWhy = p.hasSnapshot ? null : "Attach a base snapshot on Yield curves first.";
  const r = p.paste.result;
  return (
    <section className="card" aria-label="Paste or fill">
      <div className="card-title">Paste or fill</div>
      <p className="card-desc">{PASTE_HELP}</p>
      <div className="cb-paste-row">
        <label className="field cb-paste-field">
          <span className="field-label">Pasted rows</span>
          <textarea className="input cb-paste" aria-label="Pasted rows" rows={6} value={p.paste.text} onChange={(e) => p.onPasteText(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Unit</span>
          <select aria-label="Paste unit" value={p.paste.unit} onChange={(e) => p.onPasteUnit(e.target.value as PasteUnit)}>
            {UNIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span className="field-help">Auto reads every value as a percent when any value is above 1</span>
        </label>
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" disabled={p.paste.text.trim() === ""} onClick={p.onPasteAdd}>Add pasted rows</button>
        <button type="button" className="btn" disabled={off || fillWhy !== null} onClick={p.onFill}>Fill from attached snapshot</button>
        {fillWhy !== null ? <span className="muted">{fillWhy}</span> : null}
      </div>
      {r === null ? null : (
        <div className="cb-result" role="status">
          <p>{`${r.unitUsed === "percent" ? "Read as percent" : "Read as decimal"}. ${r.added} ${r.added === 1 ? "row" : "rows"} added.`}</p>
          {r.skipped.length > 0 ? <ul className="diff-list cb-lines" aria-label="Skipped lines">{r.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
        </div>
      )}
      {p.fill === null ? null : (
        <div className="cb-result" role="status">
          {p.fill.lines.map((line, i) => <p key={i}>{line}</p>)}
          {p.fill.dropped.length > 0 ? <p className="field-help">{`Not filled (shorter than one month): ${p.fill.dropped.join(", ")}`}</p> : null}
        </div>
      )}
    </section>
  );
}

function PreviewCard(p: CurveBuilderViewProps & { buildable: boolean }) {
  const reasonId = useId();
  const off = p.busy !== null || !p.buildable;
  const pv = p.preview;
  const last = pv !== null && pv.ok && pv.quoteNodes.length > 0 ? pv.quoteNodes[pv.quoteNodes.length - 1]! : null;
  return (
    <section className="card table-card" aria-label="Preview">
      <div className="card-title">Preview</div>
      <p className="card-desc">Builds the curve from the setup as it stands, without saving it.</p>
      {p.editor.interpolation !== "linear-zero" ? <p className="card-desc">{APPROX_SENTENCE}</p> : null}
      <div className="sheet-actions">
        <button type="button" className="btn" aria-disabled={off ? true : undefined} aria-describedby={!p.buildable ? reasonId : undefined} onClick={off ? undefined : p.onPreview}>Preview</button>
        {!p.buildable ? <span className="muted" id={reasonId}>Every cell must read before a preview.</span> : null}
      </div>
      {p.previewError !== null ? <p role="alert">{p.previewError}</p> : null}
      {pv !== null && !pv.ok ? (
        <ul className="diff-list cb-lines" role="alert" aria-label="Refusals">{pv.refusals.map((s, i) => <li key={i}>{s}</li>)}</ul>
      ) : null}
      {pv !== null && pv.ok ? (
        <>
          <div className="table-wrap cb-preview-wrap">
            <table className="table cb-preview">
              <thead><tr><th scope="col">Tenor</th><th scope="col" className="num">Zero rate %</th><th scope="col" className="num">Discount factor</th></tr></thead>
              <tbody>
                {pv.quoteNodes.map((q) => (
                  <tr key={q.tenorMonths}>
                    <th scope="row">{tenorTextOf(q.tenorMonths)}</th>
                    <td className="num">{pct4(q.zeroRate)}</td>
                    <td className="num">{df6(q.discountFactor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {last !== null ? <p className="card-foot">{`The zero rate is flat before the first quote and flat beyond the last quote at ${tenorTextOf(last.tenorMonths)}.`}</p> : null}
          {pv.warnings.length > 0 ? <ul className="diff-list cb-lines" aria-label="Warnings">{pv.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
        </>
      ) : null}
      <p className="card-foot">Source: POST /api/curve-setups/preview</p>
    </section>
  );
}

function SaveCard(p: CurveBuilderViewProps & { why: string | null }) {
  const reasonId = useId();
  const writeOff = p.blocked !== null;
  const off = p.busy !== null || p.why !== null;
  return (
    <section className="card" aria-label="Save">
      <div className="card-title">Save</div>
      <div className="param-grid">
        <ByField value={p.by} onChange={p.onBy} disabled={writeOff} />
      </div>
      <div className="sheet-actions">
        <button
          type="button" className="btn btn-primary" disabled={writeOff} aria-disabled={!writeOff && off ? true : undefined}
          aria-describedby={p.why !== null ? reasonId : undefined} onClick={writeOff || off ? undefined : p.onSave}
        >Save</button>
        <button type="button" className="btn" disabled={p.busy !== null} onClick={p.onNew}>Start a new setup</button>
        {p.blocked !== null ? <span className="muted" role="status">{p.blocked}</span> : p.why !== null ? <span className="muted" id={reasonId}>{p.why}</span> : null}
        {p.busy !== null ? <span className="muted" role="status">{p.busy}</span> : null}
      </div>
      {p.note === null ? null : (
        <ul className={p.note.ok ? "cb-lines cb-note-ok" : "diff-list cb-lines"} role={p.note.ok ? "status" : "alert"} aria-label="Result">
          {p.note.lines.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}
    </section>
  );
}

export function CurveBuilderView(p: CurveBuilderViewProps) {
  const choices = compoundingChoices(p.editor.rows);
  const built = blockFromState(p.editor);
  const nameProblem = setupNameProblem(p.editor.id);
  const why = p.blocked !== null ? null
    : nameProblem !== null ? nameProblem
    : p.editor.rows.length === 0 ? "Add at least one row."
    : built.block === null ? "Every cell must read before a save."
    : p.by.trim() === "" ? "Type your name first."
    : null;
  return (
    <div className="cb-page">
      <section className="card" aria-label="About curve setups">
        <div className="card-title">Curve setups</div>
        <p className="card-desc">{INTRO}</p>
      </section>
      <SetupList {...p} />
      <SettingsForm {...p} choices={choices} nameProblem={nameProblem} />
      <GridCard {...p} problems={built.problems} />
      <PasteCard {...p} />
      <PreviewCard {...p} buildable={built.block !== null && p.editor.rows.length > 0} />
      <SaveCard {...p} why={why} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page: the reads, the editor state and the calls

interface Shown { key: string; value: CurveSetupPreview }

const keyOf = (b: CurveSetupBlock | null): string | null => (b === null ? null : JSON.stringify(b));

/** A write's failure in words: a 409 adds the reload prompt the run setups page gives. */
function writeError(e: unknown): string {
  return e instanceof ApiError && e.status === 409 ? `${errText(e)} Reload the page to read the workspace's current head.` : errText(e);
}

export function CurveBuilderPage(props: { ws: string; head?: WorkspaceManifest | null; onChanged?: () => void }) {
  const head = props.head ?? null;
  const onChanged = props.onChanged ?? (() => {});
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  // The editor as last rendered, for a snapshot read to compare its starting version against when it lands.
  const latest = useRef(editor);
  latest.current = editor;
  const [by, setBy] = useBy();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<ResultNote | null>(null);
  const [paste, setPaste] = useState<PasteView>({ text: "", unit: "auto", result: null });
  const [fill, setFill] = useState<{ lines: string[]; dropped: string[] } | null>(null);
  const [preset, setPreset] = useState<{ lines: string[]; dropped: string[] } | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [shownError, setShownError] = useState<{ key: string; value: string } | null>(null);
  const list = useLoad<CurveSetupsReply>(() => listCurveSetups(props.ws), [props.ws, refresh, head?.revision]);
  const [kept, setKept] = useState<CurveSetupsReply | null>(null);
  if (list.state === "ok" && list.value !== kept) {
    setKept(list.value);
    // The list already names each current document: history lines read these labels without a GET.
    rememberCurveSetupLabels(list.value.setups);
  }

  // The base snapshot: its id names the default read here and the snapshot Fill and the preset read. The default it
  // builds with no setup on it (the server's GET /api/market/:id/curve-default) feeds the platform default button and
  // the empty list.
  const snapshotId = head?.blocks.market.snapshot?.id ?? null;
  const baseDefault = useLoad<MarketCurveRead | null>(
    () => (snapshotId === null ? Promise.resolve(null) : getMarketCurve(snapshotId).then(marketDefaultOf, (e: unknown): MarketCurveRead => ({ kind: "problem", problem: errText(e) }))),
    [snapshotId ?? ""],
  );

  if (head === null) return <div className="card muted">Reading the workspace</div>;

  const shownList = list.state === "ok" ? list.value : kept;
  const built = blockFromState(editor);
  const currentKey = keyOf(built.block);
  // Both the preview and its error belong to the block they were made for; any edit hides them.
  const preview = shownFor(shown, currentKey);
  const previewError = shownFor(shownError, currentKey);
  const edit = (next: (ed: EditorState) => EditorState) => { setEditor(next); setNote(null); };

  // One call at a time. The result note is left alone here: a write sets its own, and a preview or a fill keeps the last.
  const call = async (what: string, fn: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const onEdit = (docId: string) => {
    // The editor's mark when the read begins (version, name, label, curve family): a cell, menu or name field typed
    // while it reads is never overwritten.
    const started = markOf(latest.current);
    void call(`Reading ${docId}`, async () => {
      setNote(null);
      try {
        const block = await getCurveSetup(docId);
        const out = loadOutcome(latest.current, block, started);
        if (out.editor === latest.current) {
          setNote({ ok: false, lines: out.lines });
          return;
        }
        setEditor(out.editor);
        setShown(null);
        setShownError(null);
        setFill(null);
        setPreset(null);
        setNote({ ok: true, lines: out.lines });
      } catch (e) {
        setNote({ ok: false, lines: [errText(e)] });
      }
    });
  };

  const onActivate = (docId: string) => void call("Making it active", async () => {
    setNote(null);
    try {
      await activateCurveSetup(head.id, docId, head.revision, by.trim());
      const label = shownList?.setups.find((s) => s.id === docId)?.label ?? "";
      setNote({ ok: true, lines: [`Made ${label === "" ? docId : `${label} (${docId})`} active. The next run of this workspace builds its curve from it.`] });
      setRefresh((n) => n + 1);
      onChanged();
    } catch (e) {
      setNote({ ok: false, lines: [writeError(e)] });
    }
  });

  const onDeactivate = () => void call("Returning to the platform default curve", async () => {
    setNote(null);
    try {
      await deactivateCurveSetup(head.id, head.revision, by.trim());
      setNote({ ok: true, lines: ["Returned to the platform default curve."] });
      setRefresh((n) => n + 1);
      onChanged();
    } catch (e) {
      setNote({ ok: false, lines: [writeError(e)] });
    }
  });

  const onSave = () => {
    const block = built.block;
    if (block === null) return;
    void call(`Saving ${block.id}`, async () => {
      setNote(null);
      try {
        const r = await saveCurveSetup(head.id, block, head.revision, by.trim());
        if (r.ok) {
          setNote({ ok: true, lines: saveLines(block, latest.current) });
          setRefresh((n) => n + 1);
          onChanged();
        } else {
          setNote({ ok: false, lines: r.refusals.length > 0 ? r.refusals : ["The server refused the setup and gave no reason."] });
        }
      } catch (e) {
        setNote({ ok: false, lines: [writeError(e)] });
      }
    });
  };

  const onPreview = () => {
    const block = built.block;
    if (block === null) return;
    const key = JSON.stringify(block);
    void call("Previewing", async () => {
      setShownError(null);
      try {
        setShown({ key, value: await previewCurveSetup(previewBlock(block)) });
      } catch (e) {
        setShown(null);
        setShownError({ key, value: errText(e) });
      }
    });
  };

  const onFill = () => {
    if (snapshotId === null) return;
    const started = latest.current.version;
    void call(`Reading ${snapshotId}`, async () => {
      try {
        const snap = await getMarket(snapshotId);
        const f = fillFromSnapshot(snap);
        const out = fillOutcome(latest.current, started, f);
        if (out.editor !== latest.current) setEditor(out.editor);
        // A fill that replaced nothing because the grid moved names no dropped quotes: none were read into it.
        setFill({ lines: out.lines, dropped: out.lines[0] === FILL_RACE_SENTENCE ? [] : f.dropped });
      } catch (e) {
        setFill({ lines: [errText(e)], dropped: [] });
      }
    });
  };

  const onPreset = () => {
    if (snapshotId === null) return;
    const started = latest.current.version;
    void call(`Reading ${snapshotId}`, async () => {
      try {
        const f = fillFromSnapshot(await getMarket(snapshotId));
        const out = presetOutcome(latest.current, started, f);
        if (out.editor !== latest.current) {
          setEditor(out.editor);
          setNote(null);
        }
        setPreset({ lines: out.lines, dropped: out.lines[0] === PRESET_LOADED_SENTENCE ? f.dropped : [] });
      } catch (e) {
        setPreset({ lines: [errText(e)], dropped: [] });
      }
    });
  };

  const onPasteAdd = () => {
    const r = pastedRows(paste.text, paste.unit);
    edit((ed) => appendRows(ed, r.rows));
    // The box empties so a second press cannot add the same rows twice; what it read stays listed under it.
    setPaste({ ...paste, text: "", result: { added: r.rows.length, skipped: r.skipped, unitUsed: r.unitUsed } });
  };

  return (
    <CurveBuilderView
      setups={shownList === null ? null : shownList.setups}
      missing={shownList?.missing ?? []}
      listError={list.state === "error" ? errText(list.error) : null}
      editor={editor}
      activeId={head.blocks.market.curveSetups?.active ?? null}
      blocked={writeBlock(head, "its curve setups")}
      listReloading={list.state === "loading" && kept !== null}
      hasSnapshot={snapshotId !== null}
      marketDefault={baseDefault.state === "ok" ? baseDefault.value : baseDefault.state === "error" ? { kind: "problem", problem: errText(baseDefault.error) } : null}
      preset={preset}
      onPreset={onPreset}
      by={by}
      busy={busy}
      note={note}
      paste={paste}
      fill={fill}
      preview={preview}
      previewError={previewError}
      onBy={setBy}
      onEdit={onEdit}
      onActivate={onActivate}
      onDeactivate={onDeactivate}
      onNew={() => { setEditor((ed) => ({ ...emptyEditor(), version: ed.version + 1 })); setShown(null); setShownError(null); setFill(null); setPreset(null); setNote(null); }}
      onField={(patch) => edit((ed) => setFields(ed, patch))}
      onRow={(key, patch) => edit((ed) => setRow(ed, key, patch))}
      onAddRow={() => edit(addRow)}
      onRemoveRow={(key) => edit((ed) => removeRow(ed, key))}
      onPasteText={(text) => setPaste({ ...paste, text })}
      onPasteUnit={(unit) => setPaste({ ...paste, unit })}
      onPasteAdd={onPasteAdd}
      onFill={onFill}
      onPreview={onPreview}
      onSave={onSave}
    />
  );
}
