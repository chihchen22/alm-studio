// apps/studio/src/assumptions/setEditModel.ts
/**
 * Data > Assumptions > Edit a set (ALM Studio Pieces 4a and 4b). A stored set opens as one draft per binding, read from the engine's
 * parameter schema: number fields as typed text, the decay buckets and the draw
 * ramp as keyed rows. Piece 4b adds, removes and model-switches bindings: a new
 * or switched binding starts blank or copied from a stored binding the viewer
 * picks, never from the kernel defaults. Pure functions over the draft; the
 * page holds the state. Values are edited exactly as stored and units are
 * shown, never converted. The one figure the page prints that is not stored,
 * the bucket share sum, is the engine schema's own columnSum, the figure its
 * table rule judges.
 */
import type { AssumptionSet, BehavioralOverlay, BuiltinOverlayKind, DimensionPredicate, MacroBinding, OverlayBinding, PortfolioSpec } from "@alm/engine";
// The schema and compatibility modules by path, not the engine barrel: the barrel pulls node:crypto into the browser build.
import {
  checkOverlayParams, columnSum, formCombinationIssues, formGroupsOf, PARAM_SCHEMAS, schemaKeyOf, valueAt,
  type FormField, type FormGroup, type ListField, type NumberField, type ParamGroup, type ParamIssue, type SchemaKey, type TableField,
} from "@alm/engine/src/contracts/paramSchema";
import { macroTargetIdentity } from "@alm/engine/src/macro/targetKey";
import { OVERLAY_INSTRUMENT_COMPATIBILITY } from "@alm/engine/src/contracts/overlayCompatibility";
import { ApiError, createAssumptionSet, getAssumptionSet, isStackId, listAssumptionSets, type AssumptionSetListItem } from "@alm/reader";
import { usd } from "../balance/targetsModel";
import { pageErrText } from "../errText";
import { nextEditId } from "../plan/planEdits";
import { screenHref } from "../pageLinks";
import type { LoadState } from "../useLoad";
import { selectorText, valuesOf } from "./selectorText";

/** One table or list row: an identity key and its cells as typed text. A list row has the one cell "value". */
export interface RowDraft { key: number; cells: Record<string, string> }

export interface BindingDraft {
  /** The card's identity in this draft: kept through removals, so React keys and focus follow the card. */
  key: number;
  /** Where the binding sits in the source set; null for a binding added in this draft. */
  sourceIndex: number | null;
  /**
   * A stored binding as stored: family, selector and, unless the model is
   * switched, model version are carried unchanged, and the changes list
   * compares against it. An added binding as picked: its family, its selector,
   * and `base` as its overlay.
   */
  stored: OverlayBinding;
  /** What overlayOf writes the typed values into: the stored overlay, a copied binding's overlay, or a bare kind and model on a blank start. */
  base: BehavioralOverlay;
  /** The model version as typed. A stored binding whose model was never switched keeps its stored version, read-only. */
  modelVersion: string;
  /** True for an added binding and after a model switch: the model version is then required text the viewer edits. */
  versionOpen: boolean;
  /** null for a registered overlay, which Studio does not edit. */
  schemaKey: SchemaKey | null;
  /** Number field path to its typed text. */
  values: Record<string, string>;
  /** Table or list path to its rows. */
  rows: Record<string, RowDraft[]>;
  nextKey: number;
  /**
   * An optional parameter group's root key to whether the draft carries it (the housing group of
   * the four-factor CPR). Opened as the root's presence in the overlay; a group that is off writes no key.
   * Its number fields sit in `values` under their full paths, kept while the group is off.
   */
  groupOn: Record<string, boolean>;
  /**
   * An optional form's root key (fullForm, componentDecay, replicatingPortfolio) to whether the
   * draft carries it. Its numbers, texts and choices sit in `values` and its lists in `rows`, under full paths, kept
   * while the form is off.
   */
  formOn: Record<string, boolean>;
}

export interface SetDraft {
  source: AssumptionSet;
  label: string;
  bindings: BindingDraft[];
  /** The key the next added binding card takes. */
  nextKey: number;
  /** Removed stored bindings, edits and all, in the order removed: Restore puts one back (Polish 2 M5). Never posted. */
  removed: BindingDraft[];
}

export const ENTER_A_NUMBER = "Enter a number";
export const ENTER_A_MODEL_VERSION = "Enter a model version";

/** A plain decimal, optionally signed, with an optional exponent: every String(number) of a finite number matches. */
const DRAFT_NUMBER = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** The typed text as a number, or null when it is not one. Never a coerced 0. */
export function readDraft(text: string): number | null {
  const t = text.trim();
  return DRAFT_NUMBER.test(t) ? Number(t) : null;
}

/**
 * A USD draft read back grouped ("= 1,100,000"), so a dropped zero shows at a
 * glance; null for any other unit or a draft that does not parse. The rule is
 * the unit, not the field name. Display formatting of the typed value only, in
 * the Targets page's form (targetsModel usd), not a computed figure.
 */
export function usdReadBack(unit: string, text: string): string | null {
  if (unit !== "USD") return null;
  const v = readDraft(text);
  return v === null ? null : `= ${usd(v)}`;
}

/** A stored leaf as the text an input starts with: a number as JavaScript prints it, text as is, anything else empty. */
export function textOf(v: unknown): string {
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v : "";
}

/** The optional parameter groups of a schema; [] for a schema with none. */
export function schemaGroups(key: SchemaKey): ParamGroup[] {
  return PARAM_SCHEMAS[key].groups ?? [];
}

/** The optional forms of a schema (the full beta form, component decay, the credit); [] for none. */
export function schemaForms(key: SchemaKey): readonly FormGroup[] {
  return formGroupsOf(key);
}

/** A form field's value as the draft holds it: a choice or text as typed, "" when it holds none. */
function draftChoice(d: Pick<BindingDraft, "values">, path: string): string {
  return d.values[path] ?? "";
}

/** Whether a form field is shown (and written): always, or while the choice it names holds one of its values. */
export function formFieldShown(d: Pick<BindingDraft, "values">, f: FormField): boolean {
  return f.when === undefined || f.when.in.includes(draftChoice(d, f.when.path));
}

/**
 * The typed text and rows one schema's fields open as, read from `overlay`; with no overlay (a blank start) every
 * field is empty and every table has no rows. An optional group's fields open from the overlay, empty when its root
 * is absent, and the group is on exactly when the root is present.
 */
function openFields(overlay: BehavioralOverlay | null, key: SchemaKey): Pick<BindingDraft, "values" | "rows" | "nextKey" | "groupOn" | "formOn"> {
  const out: Pick<BindingDraft, "values" | "rows" | "nextKey" | "groupOn" | "formOn"> = { values: {}, rows: {}, nextKey: 0, groupOn: {}, formOn: {} };
  // Each form is on exactly when its root is present; its fields open from the overlay, empty when absent.
  for (const g of schemaForms(key)) {
    out.formOn[g.key] = overlay !== null && valueAt(overlay, g.key) !== undefined;
    for (const f of g.fields) {
      const v = overlay === null ? undefined : valueAt(overlay, f.path);
      if (f.shape !== "list") { out.values[f.path] = textOf(v); continue; }
      const stored = Array.isArray(v) ? v : [];
      out.rows[f.path] = stored.map((x: unknown, i) => ({ key: i, cells: { value: textOf(x) } }));
      out.nextKey = Math.max(out.nextKey, stored.length);
    }
  }
  for (const g of schemaGroups(key)) {
    out.groupOn[g.key] = overlay !== null && valueAt(overlay, g.key) !== undefined;
    for (const f of g.fields) out.values[f.path] = textOf(overlay === null ? undefined : valueAt(overlay, f.path));
  }
  for (const f of PARAM_SCHEMAS[key].fields) {
    const v = overlay === null ? undefined : valueAt(overlay, f.path);
    if (f.shape === "number") { out.values[f.path] = textOf(v); continue; }
    const stored = Array.isArray(v) ? v : [];
    out.rows[f.path] = stored.map((row: unknown, i) => ({
      key: i,
      cells: f.shape === "list"
        ? { value: textOf(row) }
        : Object.fromEntries(f.columns.map((c) => [c.key, textOf(row !== null && typeof row === "object" ? (row as Record<string, unknown>)[c.key] : undefined)])),
    }));
    out.nextKey = Math.max(out.nextKey, stored.length);
  }
  return out;
}

/** The draft a stored binding opens as: card `key`, at `sourceIndex` in its set. */
export function draftOf(b: OverlayBinding, key: number, sourceIndex: number): BindingDraft {
  const schemaKey = schemaKeyOf(b.overlay) ?? null;
  const head = { key, sourceIndex, stored: b, base: b.overlay, modelVersion: b.modelVersion, versionOpen: false, schemaKey };
  return schemaKey === null ? { ...head, values: {}, rows: {}, nextKey: 0, groupOn: {}, formOn: {} } : { ...head, ...openFields(b.overlay, schemaKey) };
}

export function draftSet(set: AssumptionSet): SetDraft {
  return { source: set, label: set.label, bindings: set.bindings.map((b, i) => draftOf(b, i, i)), nextKey: set.bindings.length, removed: [] };
}

/** Set `value` at a dotted path, creating objects on the way; the input object is a fresh clone owned by the caller. */
function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const steps = path.split(".");
  let at = root;
  for (const step of steps.slice(0, -1)) {
    const next = at[step];
    if (next === null || typeof next !== "object" || Array.isArray(next)) at[step] = {};
    at = at[step] as Record<string, unknown>;
  }
  at[steps[steps.length - 1]!] = value;
}

/**
 * The overlay the draft stands for: a clone of its base with every typed
 * number read, and an "Enter a number" issue for each text that is not one
 * (its slot holds NaN, so the schema check still judges every other field). A
 * registered overlay comes back as stored.
 */
export function overlayOf(d: BindingDraft): { overlay: BehavioralOverlay; unparsed: ParamIssue[] } {
  if (d.schemaKey === null) return { overlay: d.stored.overlay, unparsed: [] };
  const overlay = structuredClone(d.base) as unknown as Record<string, unknown>;
  const unparsed: ParamIssue[] = [];
  const read = (text: string, path: string, label: string): number => {
    const v = readDraft(text);
    if (v === null) unparsed.push({ path, label, message: ENTER_A_NUMBER });
    return v ?? Number.NaN;
  };
  for (const f of PARAM_SCHEMAS[d.schemaKey].fields) {
    if (f.shape === "number") { setAt(overlay, f.path, read(d.values[f.path] ?? "", f.path, f.label)); continue; }
    const rows = d.rows[f.path] ?? [];
    if (f.shape === "list") {
      setAt(overlay, f.path, rows.map((r, i) => read(r.cells.value ?? "", `${f.path}[${i}]`, `${f.label}, month ${i + 1}`)));
      continue;
    }
    // Row keys index the base's rows, so a copied bucket keeps any key the schema does not declare.
    const baseRows = valueAt(d.base, f.path);
    setAt(overlay, f.path, rows.map((r, i) => {
      const was = Array.isArray(baseRows) ? baseRows[r.key] : undefined;
      const out: Record<string, unknown> = was !== null && typeof was === "object" ? { ...(was as Record<string, unknown>) } : {};
      for (const c of f.columns) {
        const text = r.cells[c.key] ?? "";
        out[c.key] = "text" in c ? text : read(text, `${f.path}[${i}].${c.key}`, `${c.label}, row ${i + 1}`);
      }
      return out;
    }));
  }
  // A group that is on writes every one of its fields; a group that is off writes no key at all.
  for (const g of schemaGroups(d.schemaKey)) {
    if (d.groupOn[g.key] === true) for (const f of g.fields) setAt(overlay, f.path, read(d.values[f.path] ?? "", f.path, f.label));
    else delete overlay[g.key];
  }
  // A form that is on is written afresh from its shown fields (an empty optional field writes no
  // key, a choice left empty writes none, a text as typed, a list as its rows); a form that is off writes no key.
  for (const g of schemaForms(d.schemaKey)) {
    delete overlay[g.key];
    if (d.formOn[g.key] !== true) continue;
    overlay[g.key] = {};
    for (const f of g.fields) {
      if (!formFieldShown(d, f)) continue;
      if (f.shape === "list") {
        setAt(overlay, f.path, (d.rows[f.path] ?? []).map((r, i) => read(r.cells.value ?? "", `${f.path}[${i}]`, `${f.label}, month ${i + 1}`)));
        continue;
      }
      const text = d.values[f.path] ?? "";
      if (f.shape === "number") {
        if (f.optional === true && text.trim() === "") continue;
        setAt(overlay, f.path, read(text, f.path, f.label));
        continue;
      }
      if (f.shape === "choice" && f.optional === true && text === "") continue;
      setAt(overlay, f.path, text);
    }
  }
  return { overlay: overlay as unknown as BehavioralOverlay, unparsed };
}

/**
 * Every open issue of one binding: an empty model version where one is
 * required, its unparsed texts, then the engine schema's issues on the paths
 * that did parse.
 */
export function issuesOf(d: BindingDraft): ParamIssue[] {
  if (d.schemaKey === null) return [];
  const { overlay, unparsed } = overlayOf(d);
  const taken = new Set(unparsed.map((i) => i.path));
  const version: ParamIssue[] = d.versionOpen && d.modelVersion.trim() === "" ? [{ path: "modelVersion", label: "Model version", message: ENTER_A_MODEL_VERSION }] : [];
  // The combinations of forms the run's overlay merge refuses, in its words.
  const schema = [...checkOverlayParams(overlay), ...formCombinationIssues(overlay)];
  return [...version, ...unparsed, ...schema.filter((i) => !taken.has(i.path))];
}

/** Binding `index` with form `key` on (Add) or off (Remove). Typed values are kept either way. */
export function setForm(s: SetDraft, index: number, key: string, on: boolean): SetDraft {
  return mapBinding(s, index, (d) => (d.schemaKey === null || !schemaForms(d.schemaKey).some((g) => g.key === key) ? d : { ...d, formOn: { ...d.formOn, [key]: on } }));
}

/** The shipped deposit history as a form's picker reads it (GET /api/guided/deposit-history's series). */
export interface HistorySeries { label: string; firstMonth: string; valuesPct: readonly number[] }

/**
 * Binding `index` with form `key`'s series filled from the shipped history: its label, its first
 * month and every value, as served. The window is left as typed. A form with no picker is left as it is.
 */
export function fillSeries(s: SetDraft, index: number, key: string, h: HistorySeries): SetDraft {
  return mapBinding(s, index, (d) => {
    const g = d.schemaKey === null ? undefined : schemaForms(d.schemaKey).find((x) => x.key === key);
    if (g?.fill === undefined) return d;
    const rows = h.valuesPct.map((v, i) => ({ key: d.nextKey + i, cells: { value: String(v) } }));
    return {
      ...d,
      values: { ...d.values, [g.fill.labelPath]: h.label, [g.fill.firstMonthPath]: h.firstMonth },
      rows: { ...d.rows, [g.fill.valuesPath]: rows },
      nextKey: d.nextKey + h.valuesPct.length,
    };
  });
}

/** The line a form that is off shows, and what Add opens. */
export function formOffLine(g: FormGroup): string {
  return g.needs !== undefined
    ? `Not carried. Add opens the credit's fields; it rides beside the ${g.needs === "fullForm" ? "full beta form" : g.needs}, which must be on too.`
    : "Not carried. Add opens its fields to fill.";
}

/** The messages to show under the field, table or row cell at `path`. */
export function messagesAt(issues: ParamIssue[], path: string): string[] {
  return issues.filter((i) => i.path === path).map((i) => i.message);
}

/**
 * The line under a table with a sum rule (the decay buckets): the engine's own
 * columnSum, printed to twelve significant digits so a float sum of typed
 * shares reads 1, not 0.9999999999999999. Null for a table with no sum rule.
 */
export function shareSumText(d: BindingDraft, table: TableField): string | null {
  if (table.positiveSum === undefined) return null;
  const sum = columnSum(valueAt(overlayOf(d).overlay, table.path), table.positiveSum.key);
  return sum === null ? "Share sum: shown once every share is a number" : `Share sum: ${String(Number(sum.toPrecision(12)))}`;
}

/** An issue's message as a sentence under its field ("must be above 0" reads "Must be above 0"). */
export function issueText(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

/** The one line a binding Studio cannot edit shows (a registered overlay: its plugin kind). */
export function readOnlyLine(overlay: BehavioralOverlay): string {
  if (overlay.kind === "registered") return `Plugin kind ${overlay.registeredKind}. Studio cannot edit it.`;
  return `Kind ${overlay.kind}. Studio cannot edit it.`;
}

/** The draft to show for the set the address names: none while another set's draft is still held. */
export function draftShown(draft: SetDraft | null, selected: string | null): SetDraft | null {
  return draft !== null && draft.source.id === selected ? draft : null;
}

/**
 * The set the editor shows: the just-saved id while the address has not caught
 * up with it, else the set the address names. A save sets the pending id in the
 * same render as the saved draft, so draftShown keeps the form (and a focused
 * Save) mounted between the save and the hashchange.
 */
export function editSelected(pendingId: string | null, query: Record<string, string>): string | null {
  return pendingId ?? query.set ?? null;
}

/**
 * What a save reply may do when it lands. "adopt": the page is mounted and still
 * on the set the save started from, so it shows the saved set and moves the
 * address to it. "note": the page is mounted but the viewer has picked another
 * set (or none), so only the outcome line is shown and nothing is navigated or
 * overwritten. "none": the page has gone, so nothing is done.
 */
export function saveOutcome(from: string, current: string | null, mounted: boolean): "adopt" | "note" | "none" {
  if (!mounted) return "none";
  return current === from ? "adopt" : "note";
}

/**
 * A save's outcome line, stamped at the Save click with what it was made
 * against: the draft's edit count and the book in the Book pill. "Saved <id>"
 * is a status, a refusal an alert (Polish 2 A1).
 */
export interface SaveNote { text: string; error: boolean; edits: number; bookId: string | null }

/**
 * The save note to show: only while the draft has had no edit since the Save
 * click and the Book pill names the book it named then. The page also drops
 * the note on every Book change (Polish 3 T4), so Book b1 to b2 to b1 does not
 * bring it back; this check still hides a reply that lands under another book
 * until that drop. The note reports one past attempt on one draft; pressing
 * Save again reproduces a refusal verbatim, so hiding it costs nothing
 * (Polish 2 A1, the Targets precedent).
 */
export function noteShown(note: SaveNote | null, edits: number, bookId: string | null): SaveNote | null {
  return note !== null && note.edits === edits && note.bookId === bookId ? note : null;
}

/**
 * The ids a save must not take: the last set list the page read (kept while a
 * new read is in flight), the set on screen, and every id this page has saved.
 * Critic M5 (Piece 4a Task 7): the list reload after a save used to empty the
 * list for a moment, so the Save label named an id already stored.
 */
export function takenIds(listed: ReadonlyArray<{ id: string }> | null, selected: string | null, saved: ReadonlySet<string>): Set<string> {
  return new Set([...(listed ?? []).map((s) => s.id), ...(selected !== null ? [selected] : []), ...saved]);
}

/** The id the next save takes; null with no set picked, or before the set list has been read once. */
export function saveIdFor(selected: string | null, listed: ReadonlyArray<{ id: string }> | null, saved: ReadonlySet<string>): string | null {
  return selected === null || listed === null ? null : nextEditId(selected, takenIds(listed, selected, saved));
}

/** A failed read of the set list: the page's error before any list was read, a note over the held list after. */
export type ListFailure = { kind: "page"; text: string } | { kind: "note"; text: string };

/**
 * A failed read of the set list (Polish 2 A2). With no list ever read the page
 * has nothing to edit against, so the error is the page. With one held, the
 * editor, the draft and the Save id all stand on it, so the page keeps them and
 * shows a note with a way to read the list again.
 */
export function listFailure(list: LoadState<unknown>, held: readonly unknown[] | null): ListFailure | null {
  if (list.state !== "error") return null;
  const why = pageErrText(list.error);
  return held === null ? { kind: "page", text: why } : { kind: "note", text: `The set list was not read again; the list shown is the last one read. ${why}` };
}

/** A picker option's text: the id, the label when it adds something, and "document missing" when the listing marks the stored file gone (mfu2-b). */
export function setOptionText(s: Pick<AssumptionSetListItem, "id" | "label" | "documentMissing">): string {
  const text = s.label !== "" && s.label !== s.id ? `${s.id}: ${s.label}` : s.id;
  return s.documentMissing === true ? `${text} (document missing)` : text;
}

/** The editor's address for a set: Assumption sets with the set in the query, keeping the rest of the page state; no set drops the key. */
export function editHref(ws: string, query: Record<string, string>, setId: string | null): string {
  const q = { ...query };
  if (setId === null) delete q.set;
  else q.set = setId;
  return screenHref({ ws, section: "assumptions", screen: "sets" }, q);
}

const mapBinding = (s: SetDraft, index: number, fn: (d: BindingDraft) => BindingDraft): SetDraft =>
  ({ ...s, bindings: s.bindings.map((d, i) => (i === index ? fn(d) : d)) });

export function setLabel(s: SetDraft, label: string): SetDraft {
  return { ...s, label };
}

export function setValue(s: SetDraft, index: number, path: string, text: string): SetDraft {
  return mapBinding(s, index, (d) => ({ ...d, values: { ...d.values, [path]: text } }));
}

/** Binding `index` with optional group `key` on (Add) or off (Remove). Typed values are kept either way. */
export function setGroup(s: SetDraft, index: number, key: string, on: boolean): SetDraft {
  return mapBinding(s, index, (d) => (d.schemaKey === null || !schemaGroups(d.schemaKey).some((g) => g.key === key) ? d : { ...d, groupOn: { ...d.groupOn, [key]: on } }));
}

/**
 * Why Remove is off on binding `index`'s group `key`, or null when Remove is allowed. The engine's bind
 * check (scenario/macroBindings.ts) refuses a set that maps a series to a family and selector whose four-factor
 * binding carries no housing group, so Remove on that group would only be refused on save. Here it is refused
 * before: the group is on and the source set maps a series to the binding's family and selector. Family and
 * selector are not edited on this page, so the stored binding's are the draft's.
 */
export function groupRemoveRefusal(s: SetDraft, index: number, key: string): string | null {
  const d = s.bindings[index];
  const m = d === undefined ? undefined : mappingFor(s, d.stored);
  if (d === undefined || m === undefined || key !== "housing" || d.groupOn[key] !== true) return null;
  const f = mappedTargetText(m);
  return `This group cannot be removed while the set maps a series to ${f}. The mapping must be removed first; Studio does not edit the mapping.`;
}

/** The source set's mapping that names the target of `b`, by the engine's target identity (macro/targetKey), or undefined. */
function mappingFor(s: SetDraft, b: Pick<OverlayBinding, "familyId" | "selector">): MacroBinding | undefined {
  const at = macroTargetIdentity(b.familyId, b.selector);
  return (s.source.macroBindings ?? []).find((m) => macroTargetIdentity(m.familyId, m.selector) === at);
}

/** The mapped target in refusal copy: the family, then the mapping's selector in words when it carries one; the family alone otherwise. */
function mappedTargetText(m: MacroBinding): string {
  return Object.keys(m.selector ?? {}).length === 0 ? m.familyId : `${m.familyId} (${selectorText(m.selector)})`;
}

/**
 * Piece 7b follow-up (mfu-3): why Switch model and Remove are off on binding card `index`, or null when both are
 * allowed. Either edit leaves a mapped family with no four-factor binding carrying the housing group, which the
 * engine's bind check (scenario/macroBindings.ts) refuses on save. Only a stored prepay binding the source set maps
 * is held: an added card is never the stored one, so Remove only discards it.
 */
export function bindingRefusal(s: SetDraft, index: number): string | null {
  const d = s.bindings[index];
  const m = d === undefined ? undefined : mappingFor(s, d.stored);
  if (d === undefined || m === undefined || d.sourceIndex === null || d.stored.overlay.kind !== "prepay") return null;
  const f = mappedTargetText(m);
  return `This binding cannot be removed or switched to another model while the set maps a series to ${f}: the engine refuses a mapped family whose four-factor prepay binding carries no housing group. The mapping must be removed first; Studio does not edit the mapping.`;
}

/**
 * Piece 7b follow-up (mfu-3): why Save is off because a mapped family lost what its mapping reads, or null. For each
 * macro binding of the source set, the page must hold a four-factor prepay card on its family and selector with the
 * housing group on; the engine refuses the save otherwise. The card's Switch model and Remove and the group's Remove
 * are held off for such a card (bindingRefusal, groupRemoveRefusal); this is the Save rule beneath them.
 */
export function mappedGap(s: SetDraft): string | null {
  for (const m of s.source.macroBindings ?? []) {
    const at = macroTargetIdentity(m.familyId, m.selector);
    const cards = s.bindings.filter((d) => d.schemaKey === "prepay/four-factor-cpr" && macroTargetIdentity(d.stored.familyId, d.stored.selector) === at);
    if (cards.length === 0) return `Off: the set maps a series to ${mappedTargetText(m)}, which has no four-factor prepay binding`;
    if (!cards.some((d) => d.groupOn.housing === true)) return `Off: the set maps a series to ${mappedTargetText(m)}, whose four-factor prepay binding carries no housing group`;
  }
  return null;
}

/** The read-only mapping row of Edit a set and By kind, one line per macro binding. */
export const MACRO_MAPPING_LABEL = "Macro mapping";

/** A set's macro bindings as "<seriesId> to <familyId> (house-price response)"; [] for an unmapped set. */
export function macroMappingLines(bindings: readonly MacroBinding[] | undefined): string[] {
  return (bindings ?? []).map((b) => `${b.seriesId} to ${b.familyId} (house-price response)`);
}

export function setModelVersion(s: SetDraft, index: number, text: string): SetDraft {
  return mapBinding(s, index, (d) => ({ ...d, modelVersion: text }));
}

export function setCell(s: SetDraft, index: number, path: string, row: number, cell: string, text: string): SetDraft {
  return mapBinding(s, index, (d) => ({
    ...d,
    rows: { ...d.rows, [path]: (d.rows[path] ?? []).map((r, i) => (i === row ? { ...r, cells: { ...r.cells, [cell]: text } } : r)) },
  }));
}

/** A new row at the end of the table or list at `path`; its cells are empty text, so Save stays off until each is filled. */
export function addRow(s: SetDraft, index: number, path: string): SetDraft {
  return mapBinding(s, index, (d) => {
    const own = d.schemaKey === null ? undefined : PARAM_SCHEMAS[d.schemaKey].fields.find((x) => x.path === path);
    // A form's list takes rows the same way.
    const formList = d.schemaKey === null ? undefined : schemaForms(d.schemaKey).flatMap((g) => g.fields).find((x) => x.path === path && x.shape === "list");
    const f = own ?? formList;
    if (f === undefined || f.shape === "number" || f.shape === "choice" || f.shape === "text") return d;
    const cells = f.shape === "list" ? ["value"] : f.columns.map((c) => c.key);
    return {
      ...d,
      rows: { ...d.rows, [path]: [...(d.rows[path] ?? []), { key: d.nextKey, cells: Object.fromEntries(cells.map((c) => [c, ""])) }] },
      nextKey: d.nextKey + 1,
    };
  });
}

export function removeRow(s: SetDraft, index: number, path: string, row: number): SetDraft {
  return mapBinding(s, index, (d) => ({ ...d, rows: { ...d.rows, [path]: (d.rows[path] ?? []).filter((_, i) => i !== row) } }));
}

/**
 * Where keyboard focus goes once row `index` is removed: the key of the row
 * that follows, whose Remove button then sits where the removed one was, or
 * "add" (the Add button) when none follows. The Polish 1 knot-row rule.
 */
export function focusAfterRemove(rows: readonly RowDraft[], index: number): number | "add" {
  return rows[index + 1]?.key ?? "add";
}

/** A selector in words: the one text Edit a set, By kind and Stack share (selectorText.ts, Polish 2 A5). */
export { selectorText };

/** The add form's live line under the chips: what the binding will cover. */
export function bindsText(selector: DimensionPredicate | undefined): string {
  return Object.keys(selector ?? {}).length === 0 ? "Binds the whole family" : `Binds positions with ${selectorText(selector)}`;
}

/** A binding's place in words: its family and its selector in words, or "whole family". */
export function whereOf(b: OverlayBinding): string {
  return `${b.familyId}, ${selectorText(b.selector)}`;
}

// ---- Adding, removing and model-switching a binding ----

/** A kind with one model, named in the add picker by the schema's model name: one name per model (Polish 2 A4). */
const oneModel = (key: "nmd-decay" | "deposit-beta" | "cd-rollover" | "commitment-draw" | "loan-client-rate") => ({ key, label: PARAM_SCHEMAS[key].label });

/** The models a binding can be added with, in page order: the kind and, for prepay, the model. */
export const ADD_MODELS: ReadonlyArray<{ key: SchemaKey; label: string }> = [
  { key: "prepay/four-factor-cpr", label: "Prepayment, four-factor CPR" },
  { key: "prepay/constant-cpr", label: "Prepayment, constant CPR" },
  oneModel("nmd-decay"),
  oneModel("deposit-beta"),
  oneModel("cd-rollover"),
  oneModel("commitment-draw"),
  oneModel("loan-client-rate"),
];

/** The overlay kind a schema key belongs to. */
export function kindOf(key: SchemaKey): BuiltinOverlayKind {
  return key === "prepay/four-factor-cpr" || key === "prepay/constant-cpr" ? "prepay" : key;
}

/** The overlay a blank start writes its typed values into: the kind, and for prepay the model, and nothing else. */
export function bareOverlay(key: SchemaKey): BehavioralOverlay {
  if (key === "prepay/four-factor-cpr") return { kind: "prepay", model: "four-factor-cpr" } as unknown as BehavioralOverlay;
  if (key === "prepay/constant-cpr") return { kind: "prepay", model: "constant-cpr" } as unknown as BehavioralOverlay;
  // The one public client-rate model is flat carry, so a blank start names it; the spread is typed.
  if (key === "loan-client-rate") return { kind: "loan-client-rate", model: "flat-carry" } as unknown as BehavioralOverlay;
  return { kind: key } as unknown as BehavioralOverlay;
}

/** One family the add form offers: from the book in the Book pill, and only where the kind fits its instrument type. */
export interface FamilyChoice { id: string; label: string; instrumentType: string }

/** The book's families a binding of `key` can bind, in the book's family order, filtered by the engine's compatibility table. */
export function familyChoices(book: PortfolioSpec, key: SchemaKey): FamilyChoice[] {
  const fits: readonly string[] = OVERLAY_INSTRUMENT_COMPATIBILITY[kindOf(key)];
  return book.coa.families.filter((f) => fits.includes(f.instrumentType)).map((f) => ({ id: f.id, label: f.label, instrumentType: f.instrumentType }));
}

/** One tag the selector picker offers, with its values as chips. */
export interface ChipGroup { tag: string; label: string; values: string[] }

/**
 * The selector chips for one family: each dimension the book's taxonomy
 * declares, in its order, with the values that family's positions carry (in
 * the declared order where the taxonomy lists values, else sorted). A tag or a
 * value no position of the family carries is left out: its chip would select
 * nothing. The book only fills the picker; the set stays book-independent.
 */
export function selectorChips(book: PortfolioSpec, familyId: string): ChipGroup[] {
  const carried = new Map<string, Set<string>>();
  for (const p of book.positions) {
    if (p.familyId !== familyId) continue;
    for (const [tag, v] of Object.entries(p.dimensions ?? {})) {
      const have = carried.get(tag) ?? new Set<string>();
      for (const x of Array.isArray(v) ? v : [v]) have.add(x);
      carried.set(tag, have);
    }
  }
  return (book.taxonomy?.dimensions ?? []).flatMap((d) => {
    const have = carried.get(d.id);
    if (have === undefined) return [];
    const values = d.values !== undefined ? d.values.filter((v) => have.has(v)) : [...have].sort();
    return values.length === 0 ? [] : [{ tag: d.id, label: d.label, values }];
  });
}

/** Whether a chip is on in the selector. */
export function chipOn(selector: DimensionPredicate | undefined, tag: string, value: string): boolean {
  return valuesOf(selector, tag).includes(value);
}

/**
 * The selector with one chip toggled. Values within a tag are any-of, tags are
 * all-of. One value is stored as text, several as a list; a tag with no value
 * left is dropped, and no chip at all is no selector: the whole family.
 */
export function toggleChip(selector: DimensionPredicate | undefined, tag: string, value: string): DimensionPredicate | undefined {
  const now = valuesOf(selector, tag);
  const values = now.includes(value) ? now.filter((v) => v !== value) : [...now, value];
  const next: DimensionPredicate = { ...(selector ?? {}) };
  if (values.length === 0) delete next[tag];
  else next[tag] = values.length === 1 ? values[0]! : values;
  return Object.keys(next).length === 0 ? undefined : next;
}

/** A stored binding a new or switched binding can copy its values from. */
export interface StartChoice { id: string; label: string; binding: OverlayBinding }

/**
 * Every binding of the model `key` in every stored set, as "<set>: <family>, <selector>"; the id is "<set>#<index>".
 * A stored stack is passed over (Polish 2 A6): each of its bindings is a copy of a base or layer binding, which is
 * offered under its own set's name.
 */
export function startChoices(sets: readonly AssumptionSet[], key: SchemaKey): StartChoice[] {
  return sets.filter((s) => !isStackId(s.id))
    .flatMap((s) => s.bindings.flatMap((b, i) => (schemaKeyOf(b.overlay) === key ? [{ id: `${s.id}#${i}`, label: `${s.id}: ${whereOf(b)}`, binding: b }] : [])));
}

/** The stored sets that were read in full, and how many could not be. */
export interface StoredRead { sets: AssumptionSet[]; unread: number }

/** One read of the store: the set list, and every listed set in full. */
export interface StoreRead { listed: AssumptionSetListItem[]; stored: StoredRead }

/**
 * Read the store once (Polish 2 A3): the list, then every listed set. A set
 * that cannot be read is left out and counted, never swallowed; a list that
 * cannot be read rejects the whole read, which listFailure then reports. The
 * two reads are parameters so a test can count them.
 */
export async function readStore(
  list: () => Promise<AssumptionSetListItem[]> = listAssumptionSets,
  get: (id: string) => Promise<AssumptionSet> = getAssumptionSet,
): Promise<StoreRead> {
  const listed = await list();
  const reads = await Promise.allSettled(listed.map((s) => get(s.id)));
  return {
    listed,
    stored: { sets: reads.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])), unread: reads.filter((r) => r.status === "rejected").length },
  };
}

/** The stored sets to offer: the last good read while the store is read again or could not be, so the start choices never empty (Polish 2 A3). */
export function storedShown(state: LoadState<StoredRead>, held: StoredRead | null): StoredRead | null {
  return state.state === "ok" ? state.value : held;
}

/** The start value of a blank start in the add form and the switch control. */
export const START_BLANK = "blank";

/** The add form's picks: a model, a family, a selector (none is the whole family), and where the values start. */
export interface AddDraft { key: SchemaKey | null; familyId: string | null; selector: DimensionPredicate | undefined; start: string }

export const EMPTY_ADD: AddDraft = { key: null, familyId: null, selector: undefined, start: START_BLANK };

/** The add form's commit: "Add <model> on <family>" once both are picked, the model named as on its card; else "Add binding" (Polish 2 M1). */
export function addLabel(a: AddDraft): string {
  return a.key !== null && a.familyId !== null ? `Add ${PARAM_SCHEMAS[a.key].label} on ${a.familyId}` : "Add binding";
}

/** A new model resets the family, the selector and the start: each depends on the model. */
export function pickAddModel(key: SchemaKey | null): AddDraft {
  return { key, familyId: null, selector: undefined, start: START_BLANK };
}

/** A new family resets the selector: its chips are that family's. */
export function pickAddFamily(a: AddDraft, familyId: string | null): AddDraft {
  return { ...a, familyId, selector: undefined };
}

/** The binding a start stands for: null for a blank start, or when the picked binding is no longer offered. */
export function startBinding(choices: readonly StartChoice[], start: string): OverlayBinding | null {
  return choices.find((c) => c.id === start)?.binding ?? null;
}

/** Why a start pick holds Add or Switch off: it names a stored binding no longer offered. Null for a blank or an offered start (Polish 2 A3). */
export function startBlock(start: string, starts: readonly StartChoice[]): string | null {
  return start !== START_BLANK && !starts.some((c) => c.id === start) ? "Pick where the values start" : null;
}

/**
 * Why the add form's Add is off, or null when it is on. `book` is the book in
 * the Book pill; `bookNote` says why there is none (no book picked, being read,
 * or not read).
 */
export function addBlock(a: AddDraft, book: PortfolioSpec | null, bookNote: string | null, starts: readonly StartChoice[]): string | null {
  if (a.key === null) return "Pick a model";
  if (book === null) return bookNote ?? "Pick a book in the Book pill to list its families";
  const families = familyChoices(book, a.key);
  if (families.length === 0) return `Book ${book.id} has no family this model fits`;
  if (a.familyId === null || !families.some((f) => f.id === a.familyId)) return "Pick a family";
  return startBlock(a.start, starts);
}

/**
 * The add form's line for a family whose positions carry no tag in the book:
 * shown whenever the family is picked and offered for the model and has no
 * chip, whatever else holds Add off (Polish 2 A7). Null otherwise.
 */
export function selectorNote(a: AddDraft, book: PortfolioSpec | null): string | null {
  if (book === null || a.key === null || a.familyId === null) return null;
  if (!familyChoices(book, a.key).some((f) => f.id === a.familyId)) return null;
  return selectorChips(book, a.familyId).length === 0 ? `This family's positions carry no tags in ${book.id}; the binding covers the whole family.` : null;
}

/**
 * A new binding's draft: blank fields and no rows, or the values of the stored
 * binding it copies. Never the kernel defaults: their source is
 * unverified, and cd-rollover and commitment-draw have none. The model version
 * is required text, prefilled from the copied binding.
 */
export function newBindingDraft(key: SchemaKey, familyId: string, selector: DimensionPredicate | undefined, copy: OverlayBinding | null, cardKey: number): BindingDraft {
  const base = copy === null ? bareOverlay(key) : copy.overlay;
  const modelVersion = copy === null ? "" : copy.modelVersion;
  const stored: OverlayBinding = { familyId, overlay: base, modelVersion, ...(selector !== undefined ? { selector } : {}) };
  return { key: cardKey, sourceIndex: null, stored, base, modelVersion, versionOpen: true, schemaKey: key, ...openFields(copy === null ? null : copy.overlay, key) };
}

/** The set with a new binding at the end: model `key` on `familyId`, narrowed by `selector`, started blank or from `copy`. */
export function addBinding(s: SetDraft, key: SchemaKey, familyId: string, selector: DimensionPredicate | undefined, copy: OverlayBinding | null): SetDraft {
  return { ...s, bindings: [...s.bindings, newBindingDraft(key, familyId, selector, copy, s.nextKey)], nextKey: s.nextKey + 1 };
}

/**
 * The set without binding `index`. A stored binding moves to `removed`, edits
 * and all, so Restore can put it back (Polish 2 M5), and reads "removed" in the
 * changes list; an added binding is discarded. The stored set is never changed.
 */
export function removeBinding(s: SetDraft, index: number): SetDraft {
  const d = s.bindings[index];
  if (d === undefined) return s;
  return { ...s, bindings: s.bindings.filter((_, i) => i !== index), removed: d.sourceIndex === null ? s.removed : [...s.removed, d] };
}

/** The set with removed stored binding `cardKey` back on the page as it was removed, in stored order, before any added binding (Polish 2 M5). */
export function restoreBinding(s: SetDraft, cardKey: number): SetDraft {
  const d = s.removed.find((x) => x.key === cardKey);
  if (d === undefined || d.sourceIndex === null) return s;
  const from = d.sourceIndex;
  const at = s.bindings.findIndex((x) => x.sourceIndex === null || x.sourceIndex > from);
  const bindings = at === -1 ? [...s.bindings, d] : [...s.bindings.slice(0, at), d, ...s.bindings.slice(at)];
  return { ...s, bindings, removed: s.removed.filter((x) => x !== d) };
}

/** The DOM id of a removed binding's Restore button, where focus goes after its Remove (Polish 2 M5). */
export function restoreBindingId(cardKey: number): string {
  return `restore-binding-${cardKey}`;
}

/** A removed stored binding's name, by its stored model and place: its placeholder reads "<name>: removed". */
export function removedName(d: BindingDraft): string {
  const key = schemaKeyOf(d.stored.overlay);
  return `${key === undefined ? overlayKindName(d.stored.overlay) : PARAM_SCHEMAS[key].label}, ${whereOf(d.stored)}`;
}

/** The models a binding can switch to: the other prepay model, for a prepay binding; nothing for any other kind. */
export function switchTargets(d: BindingDraft): SchemaKey[] {
  if (d.schemaKey === "prepay/four-factor-cpr") return ["prepay/constant-cpr"];
  if (d.schemaKey === "prepay/constant-cpr") return ["prepay/four-factor-cpr"];
  return [];
}

/**
 * The set with binding `index` switched to model `key`: the overlay is
 * replaced, its fields start blank or copied from `copy`, and its model version
 * is required text again, prefilled from the copy. Family and selector stay.
 * Only prepay has two models, so only a prepay binding switches. A stored
 * binding switched back to its own model keeps its stored version, read-only,
 * whatever the start: the version names the model's form, and value edits keep
 * it (Polish 2 M4).
 */
export function switchModel(s: SetDraft, index: number, key: SchemaKey, copy: OverlayBinding | null): SetDraft {
  return mapBinding(s, index, (d) => {
    const home = d.sourceIndex !== null && schemaKeyOf(d.stored.overlay) === key;
    return {
      ...d,
      base: copy === null ? bareOverlay(key) : copy.overlay,
      modelVersion: home ? d.stored.modelVersion : copy === null ? "" : copy.modelVersion,
      versionOpen: !home,
      schemaKey: key,
      ...openFields(copy === null ? null : copy.overlay, key),
    };
  });
}

/** The chip a card carries: "New binding" for an added card, "Model switched" while its model differs from the stored one (Polish 2 M4), else none. */
export function cardMarker(d: BindingDraft): "New binding" | "Model switched" | null {
  if (d.sourceIndex === null) return "New binding";
  return d.schemaKey !== null && schemaKeyOf(d.stored.overlay) !== d.schemaKey ? "Model switched" : null;
}

/** The DOM id of the Add a binding button, where focus goes when no card follows a removed one. */
export const ADD_BINDING_ID = "add-binding";

/** The DOM ids of the Save button and the Assumption set picker. */
export const SAVE_ID = "edit-set-save";
export const SET_PICK_ID = "edit-set-pick";

/**
 * Where keyboard focus goes from Read the list again, whose alert unmounts
 * once the list is read again (Task 8 drive X1): to Save, beside which the
 * alert sits, or to the set picker when no set is shown and there is no Save.
 */
export function focusAfterReread(setShown: boolean): string {
  return setShown ? SAVE_ID : SET_PICK_ID;
}

/** The DOM id of a binding card's Remove button. */
export function removeBindingId(cardKey: number): string {
  return `remove-binding-${cardKey}`;
}

/** The DOM id of a binding card's refusal copy (bindingRefusal), which its Switch model and Remove point at (mfu-3). */
export function bindingRefusalId(cardKey: number): string {
  return `binding-${cardKey}-refusal`;
}

/**
 * Where keyboard focus goes once binding `index` is removed. A stored binding
 * leaves a placeholder where its card was, so focus goes to its Restore
 * (Polish 2 M5, amending P4 spec Section 6). An added binding is discarded, so
 * focus goes to the Remove button of the card that follows it in page order
 * (kind groups, then set order), or to the Add a binding control when none
 * follows; a plugin card has no Remove button and a placeholder is no card, so
 * both are passed over (the Section 5.2 row rule).
 */
export function focusAfterRemoveBinding(s: SetDraft, index: number): string {
  const d = s.bindings[index];
  if (d !== undefined && d.sourceIndex !== null) return restoreBindingId(d.key);
  const order = groupsOf(s).flatMap((g) => g.items);
  const at = order.findIndex((x) => x.index === index);
  const next = order.slice(at + 1).find((x) => !x.removed && x.draft.schemaKey !== null);
  return next === undefined ? ADD_BINDING_ID : removeBindingId(next.draft.key);
}

/**
 * One changed field: the binding it sits in, its label, the stored text and the
 * typed text. An added row, month or binding has no stored text (from null)
 * and reads "added", once, whatever it holds; a removed binding reads
 * "removed" the same way.
 */
export interface Change { where: string; label: string; from: string | null; to: string }

/** A stored value that is truly absent. */
const NONE = "none";
/** A typed text left empty: the field is waiting for input, not being cleared. */
const blankOr = (text: string): string => (text.trim() === "" ? "blank" : text);

/** A change as the one line the Changes list prints: "where: label: old -> new", or "where: label: added". */
export function changeLine(c: Change): string {
  return c.from === null ? `${c.where}: ${c.label}: ${c.to}` : `${c.where}: ${c.label}: ${c.from} -> ${c.to}`;
}

/** A typed text changes a stored value unless it reads as the same number (0.750 does not change 0.75). */
function changed(stored: unknown, text: string): boolean {
  return typeof stored === "number" ? readDraft(text) !== stored : text !== textOf(stored);
}

/** A binding's model in words, for an added or removed line: "Deposit decay binding". */
function bindingName(overlay: BehavioralOverlay): string {
  const key = schemaKeyOf(overlay);
  return key === undefined ? `Plugin kind ${overlayKindName(overlay)} binding` : `${PARAM_SCHEMAS[key].label} binding`;
}
const overlayKindName = (overlay: BehavioralOverlay): string => (overlay.kind === "registered" ? overlay.registeredKind : overlay.kind);

/**
 * Every change, in order: the set label, each removed stored binding, then
 * each binding on the page in set order. An added binding is one "added" line.
 * A switched model is one "Model" line, then its fields against the stored
 * overlay (a field the old model did not have reads from "none"). A reopened
 * model version is one line when it differs from the stored one. List rows are
 * months, so they compare by position; table rows compare by identity, so
 * removing a bucket reads as one removal and not as every later bucket
 * changing. An added row or month is one "added" line, not one line per cell;
 * a field or cell left empty reads "blank", and "none" is kept for a stored
 * value that is truly absent.
 */
export function changesOf(s: SetDraft): Change[] {
  const out: Change[] = [];
  if (s.label !== s.source.label) out.push({ where: "Set", label: "Label", from: s.source.label, to: s.label });
  const kept = new Set(s.bindings.map((d) => d.sourceIndex));
  s.source.bindings.forEach((b, i) => {
    if (!kept.has(i)) out.push({ where: whereOf(b), label: bindingName(b.overlay), from: null, to: "removed" });
  });
  for (const d of s.bindings) {
    if (d.schemaKey === null) continue;
    const where = whereOf(d.stored);
    if (d.sourceIndex === null) { out.push({ where, label: `${PARAM_SCHEMAS[d.schemaKey].label} binding`, from: null, to: "added" }); continue; }
    const storedKey = schemaKeyOf(d.stored.overlay);
    if (storedKey !== undefined && storedKey !== d.schemaKey) out.push({ where, label: "Model", from: PARAM_SCHEMAS[storedKey].label, to: PARAM_SCHEMAS[d.schemaKey].label });
    if (d.versionOpen && d.modelVersion.trim() !== d.stored.modelVersion) out.push({ where, label: "Model version", from: d.stored.modelVersion, to: blankOr(d.modelVersion) });
    for (const f of PARAM_SCHEMAS[d.schemaKey].fields) {
      const stored = valueAt(d.stored.overlay, f.path);
      if (f.shape === "number") {
        const text = d.values[f.path] ?? "";
        if (changed(stored, text)) out.push({ where, label: f.label, from: textOf(stored) || NONE, to: blankOr(text) });
        continue;
      }
      const was = Array.isArray(stored) ? stored : [];
      const rows = d.rows[f.path] ?? [];
      if (f.shape === "list") {
        for (let i = 0; i < Math.max(was.length, rows.length); i += 1) {
          const text = rows[i]?.cells.value;
          if (i >= was.length) out.push({ where, label: `${f.label}, month ${i + 1}`, from: null, to: "added" });
          else if (text === undefined) out.push({ where, label: `${f.label}, month ${i + 1}`, from: textOf(was[i]), to: "removed" });
          else if (changed(was[i], text)) out.push({ where, label: `${f.label}, month ${i + 1}`, from: textOf(was[i]), to: blankOr(text) });
        }
        continue;
      }
      // Row keys index the stored rows here: only prepay switches model, and prepay has no table, so a stored
      // binding's base is its stored overlay wherever a table exists.
      const cellOf = (row: unknown, key: string): unknown => (row !== null && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined);
      rows.forEach((r, i) => {
        if (r.key >= was.length) { out.push({ where, label: `${f.label}, row ${i + 1}`, from: null, to: "added" }); return; }
        for (const c of f.columns) {
          const text = r.cells[c.key] ?? "";
          if (changed(cellOf(was[r.key], c.key), text)) out.push({ where, label: `${c.label}, row ${i + 1}`, from: textOf(cellOf(was[r.key], c.key)) || NONE, to: blankOr(text) });
        }
      });
      const keptRows = new Set(rows.map((r) => r.key));
      was.forEach((row, k) => {
        if (!keptRows.has(k)) out.push({ where, label: `${f.label}, stored row ${k + 1}`, from: textOf(cellOf(row, "label")) || `row ${k + 1}`, to: "removed" });
      });
    }
    // An optional group added or removed is one line; a group kept on compares field by field.
    for (const g of schemaGroups(d.schemaKey)) {
      const was = valueAt(d.stored.overlay, g.key) !== undefined;
      const on = d.groupOn[g.key] === true;
      if (on && !was) { out.push({ where, label: g.label, from: null, to: "added" }); continue; }
      if (!on && was) { out.push({ where, label: g.label, from: null, to: "removed" }); continue; }
      if (!on) continue;
      for (const f of g.fields) {
        const stored = valueAt(d.stored.overlay, f.path);
        const text = d.values[f.path] ?? "";
        if (changed(stored, text)) out.push({ where, label: f.label, from: textOf(stored) || NONE, to: blankOr(text) });
      }
    }
    // A form added or removed is one line; a form kept on compares its shown fields one by one.
    for (const g of schemaForms(d.schemaKey)) {
      const was = valueAt(d.stored.overlay, g.key) !== undefined;
      const on = d.formOn[g.key] === true;
      if (on && !was) { out.push({ where, label: g.label, from: null, to: "added" }); continue; }
      if (!on && was) { out.push({ where, label: g.label, from: null, to: "removed" }); continue; }
      if (!on) continue;
      for (const f of g.fields) {
        const stored = valueAt(d.stored.overlay, f.path);
        if (!formFieldShown(d, f)) {
          if (stored !== undefined) out.push({ where, label: f.label, from: Array.isArray(stored) ? `${stored.length} values` : textOf(stored) || NONE, to: "removed" });
          continue;
        }
        if (f.shape === "list") {
          const was2 = Array.isArray(stored) ? stored : [];
          const rows = d.rows[f.path] ?? [];
          const same = was2.length === rows.length && rows.every((r, i) => !changed(was2[i], r.cells.value ?? ""));
          if (!same) out.push({ where, label: f.label, from: `${was2.length} values`, to: `${rows.length} values` });
          continue;
        }
        const text = d.values[f.path] ?? "";
        if (changed(stored, text)) out.push({ where, label: f.label, from: textOf(stored) || NONE, to: blankOr(text) });
      }
    }
  }
  return out;
}

/** The DOM id of the input at `path` in binding `index`; at a table or list path, its Add button; at "modelVersion", the model version input. */
export function inputId(index: number, path: string): string {
  return `edit-${index}-${path}`;
}

/** One field Save waits on: "<where>: <label>", and the id of the input a click moves focus to. */
export interface FixTarget { label: string; target: string }

/** Where a path sits in its schema, for page order: field, then row (-1 for the table itself), then column. The model version sits first. */
function pathOrder(key: SchemaKey, path: string): [number, number, number] {
  const fields = PARAM_SCHEMAS[key].fields;
  // An optional group's fields, and its root, sit after the schema's own fields, in group order.
  // The forms' fields after them, in form order; a list's months in place.
  const grouped = [...schemaGroups(key).flatMap((g) => [g.key, ...g.fields.map((f) => f.path)]), ...schemaForms(key).flatMap((g) => [g.key, ...g.fields.map((f) => f.path)])];
  if (grouped.includes(path)) return [fields.length + grouped.indexOf(path), -1, -1];
  const inForm = grouped.findIndex((g) => path.startsWith(`${g}[`) || (path.startsWith(`${g}.`) && !grouped.includes(path)));
  if (inForm >= 0) {
    const m = /\[(\d+)\]/.exec(path.slice(grouped[inForm]!.length));
    return [fields.length + inForm, m === null ? -1 : Number(m[1]), -1];
  }
  const at = fields.findIndex((f) => f.path === path || path.startsWith(`${f.path}[`));
  const f = fields[at];
  if (f === undefined || f.path === path) return [at, -1, -1];
  const m = /^\[(\d+)\](?:\.(.+))?$/.exec(path.slice(f.path.length));
  const row = m === null ? -1 : Number(m[1]);
  const col = f.shape === "table" && m?.[2] !== undefined ? f.columns.findIndex((c) => c.key === m[2]) : -1;
  return [at, row, col];
}

/**
 * One binding's open fields, once each however many issues it has, in schema
 * order (rows and columns in place), each with its bare field label. A table
 * rule (the bucket share sum, too few rows) points at the table's first cell,
 * or at its Add button when it has no rows.
 */
function bindingFixes(index: number, d: BindingDraft): FixTarget[] {
  if (d.schemaKey === null) return [];
  const key = d.schemaKey;
  const seen = new Map<string, string>();
  for (const i of issuesOf(d)) if (!seen.has(i.path)) seen.set(i.path, i.label);
  const paths = [...seen.keys()].sort((a, b) => {
    const x = pathOrder(key, a);
    const y = pathOrder(key, b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return paths.map((path) => {
    const table = PARAM_SCHEMAS[key].fields.find((f) => f.path === path && f.shape !== "number");
    let target = path;
    if (table !== undefined && table.shape !== "number" && (d.rows[path] ?? []).length > 0) {
      target = table.shape === "list" ? `${path}[0]` : `${path}[0].${table.columns[0]!.key}`;
    }
    // A form's list points at its first month, a form root at its Add or Remove button.
    const formList = schemaForms(key).flatMap((g) => g.fields).find((f) => f.path === path && f.shape === "list");
    if (formList !== undefined && (d.rows[path] ?? []).length > 0) target = `${path}[0]`;
    return { label: seen.get(path)!, target: inputId(index, target) };
  });
}

/** One binding with open fields: its card name "<model>, <where>", its place, and its fields with bare labels (Polish 2 M3). */
export interface FixGroup { name: string; where: string; fixes: FixTarget[] }

/** The bindings with open fields, in page order (kind groups, then set order); a removed binding's placeholder has none. */
export function fixGroups(s: SetDraft): FixGroup[] {
  return groupsOf(s).flatMap((g) => g.items.flatMap((x) => {
    if (x.removed || x.draft.schemaKey === null) return [];
    const fixes = bindingFixes(x.index, x.draft);
    const where = whereOf(x.draft.stored);
    return fixes.length === 0 ? [] : [{ name: `${PARAM_SCHEMAS[x.draft.schemaKey].label}, ${where}`, where, fixes }];
  }));
}

/** Every field with an open issue, once each, in page order, as "<where>: <field>": the count Save's off reason prints. */
export function fieldsToFix(s: SetDraft): FixTarget[] {
  return fixGroups(s).flatMap((g) => g.fixes.map((f) => ({ label: `${g.where}: ${f.label}`, target: f.target })));
}

/**
 * The buttons under Save's off reason (Polish 2 M3): a binding with at most
 * `max` open fields gives one per field, "<name>: <field>"; a larger one gives
 * one, "<name>: <n> fields to fix", which focuses its first field. Not
 * "empty": a copied start can hold out-of-bound values rather than blanks.
 */
export function fixListItems(s: SetDraft, max = 5): FixTarget[] {
  return fixGroups(s).flatMap((g) => (g.fixes.length <= max
    ? g.fixes.map((f) => ({ label: `${g.name}: ${f.label}`, target: f.target }))
    : [{ label: `${g.name}: ${g.fixes.length} fields to fix`, target: g.fixes[0]!.target }]));
}

/**
 * Why Save is off, or null when it is on. Off while saving, reading the set,
 * with no set, before the set list has been read once (the id is not known),
 * while a mapped family has lost what its mapping reads (mappedGap),
 * with an open issue, or with nothing changed.
 */
export function saveBlock(s: SetDraft | null, reading: boolean, saving: string | null, listed = true): string | null {
  if (saving !== null) return `Saving ${saving}`;
  if (reading) return "Reading the set";
  if (s === null) return "Pick a set to edit";
  if (!listed) return "Reading the set list";
  const gap = mappedGap(s);
  if (gap !== null) return gap;
  // Fields, not issues: a field with a bound and a cross-rule issue is one field to fix.
  const open = fieldsToFix(s).length;
  if (open > 0) return open === 1 ? "Off: one field needs a fix" : `Off: ${open} fields need a fix`;
  if (changesOf(s).length === 0) return "Off: nothing has changed";
  return null;
}

/**
 * The set Save posts: a new id, the typed label (the id when blank), and the
 * bindings on the page in set order, added ones last. A stored binding keeps
 * its family and selector; its modelVersion, which names the model's form, is
 * kept unless the model was switched, when the typed version is posted. An
 * added binding posts its picked family and selector and its typed version.
 * The new id and the engine's content hash record the change. No
 * contentHash: the engine fills it. The source's macroBindings ride along
 * verbatim.
 */
export function savePayload(s: SetDraft, id: string): AssumptionSet {
  const label = s.label.trim();
  return {
    schemaVersion: s.source.schemaVersion,
    id,
    label: label === "" ? id : label,
    bindings: s.bindings.map((d) => (d.schemaKey === null
      ? d.stored
      : { ...d.stored, modelVersion: d.versionOpen ? d.modelVersion.trim() : d.stored.modelVersion, overlay: overlayOf(d).overlay })),
    // The source's macro mapping, verbatim; the server's bind checks it.
    ...(s.source.macroBindings !== undefined ? { macroBindings: s.source.macroBindings } : {}),
  };
}

export type SaveResult = { kind: "saved"; set: AssumptionSet } | { kind: "refused"; text: string };

/**
 * One save: POST under nextEditId(source, taken). A 409 means another save
 * took the id since the list was read: the list is read again, the next free
 * id picked, and the POST retried once. Any other refusal is the server's text
 * through pageErrText, verbatim. A save returns the set the server stored.
 */
export async function saveEdited(s: SetDraft, taken: ReadonlySet<string>): Promise<SaveResult> {
  const first = nextEditId(s.source.id, taken);
  try {
    return { kind: "saved", set: await createAssumptionSet(savePayload(s, first)) };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) return { kind: "refused", text: pageErrText(e) };
    try {
      const fresh = new Set([...taken, first, ...(await listAssumptionSets()).map((x) => x.id)]);
      return { kind: "saved", set: await createAssumptionSet(savePayload(s, nextEditId(s.source.id, fresh))) };
    } catch (e2) {
      return { kind: "refused", text: pageErrText(e2) };
    }
  }
}

/** A card's fields in schema order: a run of number fields shares one grid; a table or list is a block of its own. */
export type Segment = { kind: "numbers"; fields: NumberField[] } | { kind: "rows"; field: TableField | ListField };

export function segmentsOf(key: SchemaKey): Segment[] {
  const out: Segment[] = [];
  for (const f of PARAM_SCHEMAS[key].fields) {
    const last = out[out.length - 1];
    if (f.shape !== "number") out.push({ kind: "rows", field: f });
    else if (last !== undefined && last.kind === "numbers") last.fields.push(f);
    else out.push({ kind: "numbers", fields: [f] });
  }
  return out;
}

/** Kinds in page order, each with its heading; a one-model kind's heading is the schema's model name (Polish 2 A4). */
export const KIND_GROUPS: ReadonlyArray<{ kind: string; heading: string }> = [
  { kind: "prepay", heading: "Prepayment" },
  { kind: "nmd-decay", heading: PARAM_SCHEMAS["nmd-decay"].label },
  { kind: "deposit-beta", heading: PARAM_SCHEMAS["deposit-beta"].label },
  { kind: "cd-rollover", heading: PARAM_SCHEMAS["cd-rollover"].label },
  { kind: "commitment-draw", heading: PARAM_SCHEMAS["commitment-draw"].label },
  { kind: "loan-client-rate", heading: PARAM_SCHEMAS["loan-client-rate"].label },
  { kind: "registered", heading: "Plugin kinds" },
];

/** One item of a kind group: a card on the page with its index in the set, or the placeholder of a removed stored binding (Polish 2 M5). */
export type GroupItem = { removed: false; index: number; draft: BindingDraft } | { removed: true; index: null; draft: BindingDraft };

/**
 * The bindings grouped by kind in page order. In a group, stored bindings sit
 * in stored order, a removed one as a placeholder where its card was, and
 * added bindings follow in the order added. Empty groups are left out.
 */
export function groupsOf(s: SetDraft): Array<{ heading: string; items: GroupItem[] }> {
  const all: GroupItem[] = [
    ...s.bindings.map((draft, index): GroupItem => ({ removed: false, index, draft })),
    ...s.removed.map((draft): GroupItem => ({ removed: true, index: null, draft })),
  ];
  const at = (x: GroupItem): number => x.draft.sourceIndex ?? s.source.bindings.length + (x.index ?? 0);
  return KIND_GROUPS
    .map((g) => ({ heading: g.heading, items: all.filter((x) => x.draft.stored.overlay.kind === g.kind).sort((a, b) => at(a) - at(b)) }))
    .filter((g) => g.items.length > 0);
}
