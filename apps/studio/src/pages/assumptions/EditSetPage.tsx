// apps/studio/src/pages/assumptions/EditSetPage.tsx
/**
 * Data > Assumptions > Edit a set (ALM Studio Pieces 4a and 4b, and Polish 2).
 * EditSetView is props only, bar the local picks of the add panel and each
 * card's switch control; AddBindingPanelView and SwitchModelView are props
 * only. EditSetPage reads the set the address names (?set=<id>), the book in
 * the Book pill (it fills the family and selector pickers) and the store once
 * (the set list and every stored set, the bindings a new one can copy), holds
 * the draft, and saves an edited copy under a new id; the stored set is never
 * changed. Labels, units, help lines and checks come from the engine's
 * parameter schema, and every edit is a setEditModel function. Set Check: a
 * row after Save checks the draft against a stored plan that reads its source
 * set (setCheckModel); it never holds Save off.
 * The optional forms of a deposit binding (the full beta form, the component decay form
 * and the replicating-portfolio credit) open below its parameters, each with Add and Remove, its numbers, choices,
 * texts and lists; the component decay series fills from the shipped SOFR history. Each form's own validator, the
 * one intake and the bind check run, judges it, so a refusal here reads as it would there.
 */
import { StartHereSetBanner } from "../workspace/StartHere";
import { useEffect, useId, useRef, useState } from "react";
import type { AssumptionSet, PortfolioSpec } from "@alm/engine";
// The schema module by path, not the engine barrel: the barrel pulls node:crypto into the browser build.
import { PARAM_SCHEMAS, type ChoiceField, type FormGroup, type ListField, type NumberField, type SchemaKey, type TableField, type TextField } from "@alm/engine/src/contracts/paramSchema";
import { getAssumptionSet, getDepositHistory, getPortfolio, type AssumptionSetListItem } from "@alm/reader";
import { pageErrText, reasonOf } from "../../errText";
import { useLoad, type LoadState } from "../../useLoad";
import {
  ADD_BINDING_ID, ADD_MODELS, addBinding, addBlock, addLabel, addRow, bindingRefusal, bindingRefusalId, bindsText, cardMarker, changeLine, changesOf, chipOn, draftSet,
  draftShown, editHref, editSelected, EMPTY_ADD, familyChoices, fixListItems, focusAfterRemove, focusAfterRemoveBinding, focusAfterReread, groupRemoveRefusal, groupsOf, inputId, issueText, issuesOf, listFailure,
  MACRO_MAPPING_LABEL, macroMappingLines, messagesAt, noteShown, pickAddFamily, pickAddModel, readOnlyLine, readStore, removeBinding, removeBindingId, removedName, removeRow, restoreBinding,
  restoreBindingId, SAVE_ID, saveBlock, saveEdited, saveIdFor, saveOutcome, schemaGroups, schemaForms, formFieldShown, formOffLine, setForm, fillSeries, segmentsOf, selectorChips, selectorNote, SET_PICK_ID, setCell, setGroup, setLabel, setModelVersion, setOptionText, setValue,
  shareSumText, START_BLANK, startBinding, startBlock, startChoices, storedShown, switchModel, switchTargets, takenIds, toggleChip, usdReadBack, whereOf,
  type AddDraft, type BindingDraft, type Change, type RowDraft, type SaveNote, type SetDraft, type StartChoice, type StoredRead,
} from "../../assumptions/setEditModel";
import {
  checkBlock, checkDraft, checkHeadline, checkShown, planOptionText, plansNoteOf, plansReading, readPlans, type CheckNote, type CheckOutcome, type PlanReads, type PlansRead,
} from "../../assumptions/setCheckModel";

export type { SaveNote };

/**
 * The read-only Macro mapping row, one line per macro binding as "<seriesId> to <familyId>
 * (house-price response)". Props only; nothing when the lines are empty. By kind shows it too.
 */
export function MacroMappingRow(props: { lines: string[]; setId?: string }) {
  if (props.lines.length === 0) return null;
  return (
    <section className="card" aria-label={MACRO_MAPPING_LABEL}>
      <div className="card-title">{MACRO_MAPPING_LABEL}{props.setId !== undefined ? <>, <span className="mono">{props.setId}</span></> : null}</div>
      {props.lines.map((l) => <p key={l} className="card-desc">{l}</p>)}
      <p className="card-foot">Read-only here: Studio does not edit the mapping, and it is kept on save. While the set maps a series to a family, that family's house-price response cannot be removed; the mapping must be removed first. Every housing value is illustrative.</p>
    </section>
  );
}

export interface EditSetViewProps {
  sets: AssumptionSetListItem[];
  selected: string | null;
  /** The draft of the selected set; null while it is read, when it could not be read, or with no set picked. */
  draft: SetDraft | null;
  reading: boolean;
  /** Why the picked set could not be read; null when it was. */
  loadError: string | null;
  /** Why the set list shown is the last one read (listFailure's note); null when the list read. */
  listNote: string | null;
  /** The id being saved; null when no save is in flight. */
  saving: string | null;
  /** The id the next save takes; null before the set list has been read once. */
  saveId: string | null;
  /** The save note while it holds (noteShown): "Saved <id>" as a status, a refusal as an alert. */
  note: Pick<SaveNote, "text" | "error"> | null;
  /** The book in the Book pill, which fills the add form's family and selector pickers; null while there is none. */
  book: PortfolioSpec | null;
  /** The book id in the Book pill; null while none is picked. A change starts the add form over (addPanelKey). */
  bookId: string | null;
  /** Why no book fills the pickers (none picked, being read, not read); null when `book` is set. */
  bookNote: string | null;
  /** Every stored set, read in full: the bindings a new or switched binding can copy its values from. */
  stored: AssumptionSet[];
  /** Why some or all stored sets are not offered as starting values (storedNoteOf); null when none is missing. */
  storedNote: string | null;
  onPick(id: string | null): void;
  onDraft(next: SetDraft): void;
  onSave(): void;
  /** Read the set list again, after a failed read (Polish 2 A2). */
  onReread(): void;
  /** The Check against a plan row (Set Check); shown with a draft. Absent, no row. */
  check?: SetCheckRowProps;
}

export interface SetCheckRowProps {
  /** The source set the draft stands in for. */
  setId: string;
  /** The stored plans that read the set; null while the plans are read. */
  plans: PlanReads[] | null;
  /** Why no plan, or not every plan, is offered; null when none is missing. */
  plansNote: string | null;
  /** The plan picked; null with none. */
  planId: string | null;
  /** The plan a check is running against; null with none in flight. */
  checking: string | null;
  /** The last check's outcome while it holds (checkShown); null otherwise. */
  note: CheckOutcome | null;
  onPlan(id: string | null): void;
  onCheck(): void;
}

/**
 * Check against a plan (Set Check): a picker of the stored plans that read the
 * source set and a Check button, then the outcome: a pass as a status, a
 * refusal as an alert listing the rule and stage, or the refusal class and the
 * binding it names. Save is never held off by it. Props only.
 */
export function SetCheckRow(p: SetCheckRowProps) {
  const reasonId = useId();
  const noteId = useId();
  const block = checkBlock(p.planId, p.checking);
  const o = p.note;
  return (
    <>
      <div className="sheet-actions" role="group" aria-label="Check against a plan">
        {p.plans === null ? <span className="muted">Reading the plans</span> : (
          <label className="field">
            <span className="field-label">Check against a plan</span>
            <select value={p.planId ?? ""} aria-describedby={p.plansNote !== null ? noteId : undefined} onChange={(e) => p.onPlan(e.target.value === "" ? null : e.target.value)}>
              <option value="">Pick a plan</option>
              {p.plans.map((x) => <option key={x.id} value={x.id}>{planOptionText(x)}</option>)}
            </select>
          </label>
        )}
        {/* Off by aria-disabled, not disabled, so a focused Check keeps focus through a check (the Polish 1 rule). */}
        <button type="button" className="btn" aria-disabled={block !== null ? true : undefined} aria-describedby={block !== null ? reasonId : undefined}
          onClick={block !== null ? undefined : p.onCheck}>Check</button>
        {block !== null ? <span className="muted" id={reasonId} role="status">{block}</span> : null}
        {p.plansNote !== null ? <span className="field-help" id={noteId}>{p.plansNote}</span> : null}
      </div>
      {o === null ? null : o.kind === "passes" ? <span className="status status-pass" role="status">✓ {checkHeadline(o)}</span> : (
        <section className="card" role="alert">
          <span className="status status-breach">✕ {checkHeadline(o)}</span>
          <ul className="diff-list">{(o.kind === "refused" ? o.lines : [o.text]).map((line, i) => <li key={i}>{line}</li>)}</ul>
        </section>
      )}
    </>
  );
}

/**
 * The messages under a field: text, in the error colour, never colour alone.
 * Not a live region: the input names it by aria-describedby and marks itself
 * aria-invalid, and Save's reason is the one region a keystroke changes
 * (Polish 2 C5).
 */
function Messages(props: { id: string; messages: string[] }) {
  return props.messages.length === 0 ? null : <span className="field-help field-error" id={props.id}>{props.messages.map(issueText).join(" ")}</span>;
}

const describedBy = (ids: ReadonlyArray<string | null>): string => ids.filter((x): x is string => x !== null).join(" ");

function NumberInput(props: { field: NumberField; inputId: string; value: string; messages: string[]; onChange(text: string): void }) {
  const id = useId();
  const f = props.field;
  const invalid = props.messages.length > 0;
  // A USD value read back grouped beside its unit (display only; the input keeps the raw text).
  const readBack = usdReadBack(f.unit, props.value);
  return (
    <div className="field">
      <label className="field-label" htmlFor={props.inputId}>{f.label}</label>
      <span className="param-input">
        <input id={props.inputId} className="input" inputMode="decimal" aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy([invalid ? `${id}msg` : null, `${id}unit`, readBack !== null ? `${id}rb` : null, `${id}help`])}
          value={props.value} onChange={(e) => props.onChange(e.target.value)} />
        <span className="param-unit" id={`${id}unit`}>{f.unit}</span>
        {readBack !== null ? <span className="param-unit" id={`${id}rb`}>{readBack}</span> : null}
      </span>
      <Messages id={`${id}msg`} messages={props.messages} />
      <span className="field-help" id={`${id}help`}>{f.help}</span>
    </div>
  );
}

/**
 * The rows of a table or list. Removing a row hands keyboard focus to the next
 * row's Remove button, or to Add when none follows, so focus never drops to the
 * page (the Polish 1 knot-row rule, setEditModel.focusAfterRemove).
 */
function RowsEditor(props: {
  field: TableField | ListField; rows: RowDraft[]; issues: ReturnType<typeof issuesOf>; foot: string | null;
  /** The DOM id of the input at a path (setEditModel.inputId), so a field-to-fix button can focus it. */
  idOf(path: string): string;
  onCell(row: number, cell: string, text: string): void; onAdd(): void; onRemove(row: number): void;
}) {
  const { field: f, rows } = props;
  const id = useId();
  const removeButtons = useRef(new Map<number, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  // Set by a remove, read once after the next commit, when the target row's button is in the page.
  const focusNext = useRef<number | "add" | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    (target === "add" ? addButton.current : removeButtons.current.get(target))?.focus();
  });
  const isList = f.shape === "list";
  const rowName = (i: number) => (isList ? `month ${i + 1}` : `row ${i + 1}`);
  const columns = f.shape === "list"
    ? [{ key: "value", label: f.label, unit: f.unit, text: false }]
    : f.columns.map((c) => ({ key: c.key, label: c.label, unit: "text" in c ? "" : c.unit, text: "text" in c }));
  const tableMessages = messagesAt(props.issues, f.path);
  return (
    <div className="stack param-rows">
      <div className="field-label" id={`${id}label`}>{f.label}</div>
      <div className="table-wrap">
        <table className="table" aria-labelledby={`${id}label`} aria-describedby={`${id}help`}>
          <thead><tr>
            <th scope="col">{isList ? "Month" : <span className="sr-only">Row</span>}</th>
            {columns.map((c) => <th scope="col" key={c.key} className={c.text ? undefined : "num"}>{c.unit === "" ? c.label : `${c.label}, ${c.unit}`}</th>)}
            <th scope="col"><span className="sr-only">Remove</span></th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <th scope="row">{isList ? `Month ${i + 1}` : `Row ${i + 1}`}</th>
                {columns.map((c) => {
                  const path = isList ? `${f.path}[${i}]` : `${f.path}[${i}].${c.key}`;
                  const messages = messagesAt(props.issues, path);
                  const msgId = `${id}m${r.key}${c.key}`;
                  const rbId = `${id}rb${r.key}${c.key}`;
                  const readBack = usdReadBack(c.unit, r.cells[c.key] ?? "");
                  return (
                    <td key={c.key} className={c.text ? undefined : "num"}>
                      <input id={props.idOf(path)} className={c.text ? "input input-text" : "input input-bal"} inputMode={c.text ? undefined : "decimal"} aria-label={`${c.label}, ${rowName(i)}`}
                        aria-invalid={messages.length > 0 ? true : undefined}
                        aria-describedby={describedBy([messages.length > 0 ? msgId : null, readBack !== null ? rbId : null]) || undefined}
                        value={r.cells[c.key] ?? ""} onChange={(e) => props.onCell(i, c.key, e.target.value)} />
                      {readBack !== null ? <div className="field-help" id={rbId}>{readBack}</div> : null}
                      <Messages id={msgId} messages={messages} />
                    </td>
                  );
                })}
                <td>
                  <button type="button" className="btn btn-quiet btn-icon" aria-label={`Remove ${rowName(i)}`}
                    onClick={() => { focusNext.current = focusAfterRemove(rows, i); props.onRemove(i); }}
                    ref={(el) => { if (el === null) removeButtons.current.delete(r.key); else removeButtons.current.set(r.key, el); }}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Messages id={`${id}tmsg`} messages={tableMessages} />
      {props.foot !== null ? <span className="field-help">{props.foot}</span> : null}
      <div className="sheet-actions">
        <button type="button" className="btn" id={props.idOf(f.path)} ref={addButton} onClick={props.onAdd}>{isList ? "Add month" : "Add row"}</button>
        <span className="field-help" id={`${id}help`}>{f.help}</span>
      </div>
    </div>
  );
}

/** The model version of an added or switched binding: required text, prefilled from the copied binding. */
function VersionInput(props: { inputId: string; value: string; messages: string[]; onChange(text: string): void }) {
  const id = useId();
  const invalid = props.messages.length > 0;
  return (
    <div className="field">
      <label className="field-label" htmlFor={props.inputId}>Model version</label>
      <input id={props.inputId} className="input input-text" aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy([invalid ? `${id}msg` : null, `${id}help`])} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <Messages id={`${id}msg`} messages={props.messages} />
      <span className="field-help" id={`${id}help`}>Names the model's form; it travels into each run's provenance.</span>
    </div>
  );
}

/** The DOM ids of a card's switch control: the Switch model button, the start choice and the confirm. */
const switchOpenId = (cardKey: number): string => `switch-model-${cardKey}`;
const switchStartId = (cardKey: number): string => `switch-start-${cardKey}`;
const switchConfirmId = (cardKey: number): string => `switch-confirm-${cardKey}`;

/**
 * Where focus goes after a start is picked in a card's switch row: Blank with
 * no stored start of the model unmounts the picker (a stale start was all that
 * kept it), so focus goes to the confirm; any other pick keeps the select in
 * the page, and focus stays on it (null). Final review I1.
 */
export const focusAfterStart = (cardKey: number, start: string, starts: number): string | null =>
  start === START_BLANK && starts === 0 ? switchConfirmId(cardKey) : null;

export interface SwitchModelViewProps {
  /** The card's key: the control's ids follow it. */
  cardKey: number;
  /** The card's name, for the Switch model button's accessible name. */
  name: string;
  /** The model the card switches to. */
  target: SchemaKey;
  open: boolean;
  /** Where the new model's fields start: START_BLANK or a start choice's id. */
  start: string;
  /** The stored bindings of the target model the fields can start from. */
  starts: StartChoice[];
  /** Why some stored sets are not offered as starting values; plain text tied to the start choice, not a live region. */
  storedNote: string | null;
  /** Piece 7b follow-up (mfu-3): the id of the card's refusal copy while a mapping holds the switch off; absent when it is allowed. */
  refusedBy?: string;
  onOpen(): void;
  onStart(start: string): void;
  onSwitch(): void;
  onCancel(): void;
}

/**
 * Switch a prepay binding to its other model (Polish 2 M2). Closed, one quiet
 * "Switch model" in the card head beside Remove. Open, a row under the head:
 * where the new model's fields start (a stored binding of that model, or
 * "Starts blank" when none can be copied), the confirm "Switch to <model>",
 * held off while the start is no longer offered (Polish 2 A3), and Cancel.
 * Switch discards every value in the card, so it takes a second, deliberate
 * step, and the row says so beside the confirm (Task 8 critic M1). Props only.
 */
export function SwitchModelView(p: SwitchModelViewProps) {
  const reasonId = useId();
  const noteId = useId();
  const warnId = useId();
  if (!p.open) {
    return (
      <button type="button" className="btn btn-quiet" id={switchOpenId(p.cardKey)} aria-label={`Switch model of ${p.name}`}
        disabled={p.refusedBy !== undefined} aria-describedby={p.refusedBy} onClick={p.refusedBy !== undefined ? undefined : p.onOpen}>Switch model</button>
    );
  }
  const label = PARAM_SCHEMAS[p.target].label;
  const block = startBlock(p.start, p.starts);
  const note = p.storedNote !== null ? noteId : null;
  // A start picked before the stored sets were read again stays pickable while none is offered, so Blank can replace it.
  const picker = p.starts.length > 0 || p.start !== START_BLANK;
  return (
    <div className="switch-row">
      {picker ? (
        <label className="field">
          <span className="field-label">Start the {label} fields from</span>
          <select id={switchStartId(p.cardKey)} value={p.start} aria-describedby={note ?? undefined} onChange={(e) => p.onStart(e.target.value)}>
            <option value={START_BLANK}>Blank</option>
            {p.starts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
      ) : <span className="muted">Starts blank</span>}
      <button type="button" className="btn" id={switchConfirmId(p.cardKey)} aria-disabled={block !== null ? true : undefined}
        aria-describedby={describedBy([block !== null ? reasonId : null, picker ? null : note, warnId])}
        onClick={block !== null ? undefined : p.onSwitch}>Switch to {label}</button>
      <button type="button" className="btn btn-quiet" onClick={p.onCancel}>Cancel</button>
      {block !== null ? <span className="muted" id={reasonId} role="status">{block}</span> : null}
      <span className="field-help" id={warnId}>Switching replaces the values in this card.</span>
      {p.storedNote !== null ? <span className="field-help" id={noteId}>{p.storedNote}</span> : null}
    </div>
  );
}

/** A removed stored binding's placeholder, where its card was: one line and a quiet Restore (Polish 2 M5). */
function RemovedCard(props: { draft: BindingDraft; set: SetDraft; onDraft(next: SetDraft): void; focusAfter(id: string): void }) {
  const name = removedName(props.draft);
  return (
    <article className="card" aria-label={`${name}: removed`}>
      <div className="card-head">
        <span className="muted">{name}: removed</span>
        <button type="button" className="btn btn-quiet" id={restoreBindingId(props.draft.key)} aria-label={`Restore ${name}`}
          onClick={() => { props.focusAfter(removeBindingId(props.draft.key)); props.onDraft(restoreBinding(props.set, props.draft.key)); }}>Restore</button>
      </div>
    </article>
  );
}

function BindingCard(props: {
  index: number; draft: BindingDraft; set: SetDraft; stored: AssumptionSet[]; storedNote: string | null;
  onDraft(next: SetDraft): void; focusAfter(id: string): void;
}) {
  const { index, draft: d, set } = props;
  // The switch control: null while closed, else the start picked. The card is keyed by set and card, so a new set starts it over (Polish 2 A3).
  const [switching, setSwitching] = useState<string | null>(null);
  // Opening and cancelling the switch re-render this card alone, so the card hands focus on after its own commit (the add panel's rule, fix I1).
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    document.getElementById(target)?.focus();
  });
  if (d.schemaKey === null) {
    return (
      <article className="card" aria-label={whereOf(d.stored)}>
        <div className="card-title">{whereOf(d.stored)}</div>
        <p className="card-desc">{readOnlyLine(d.stored.overlay)}</p>
      </article>
    );
  }
  const schema = PARAM_SCHEMAS[d.schemaKey];
  const issues = issuesOf(d);
  const name = `${schema.label}, ${whereOf(d.stored)}`;
  const marker = cardMarker(d);
  const target = switchTargets(d)[0];
  const starts = target === undefined ? [] : startChoices(props.stored, target);
  // Piece 7b follow-up (mfu-3): Switch model and Remove are off on a mapped family's stored card, which the bind check would refuse on save.
  const refusal = bindingRefusal(set, index);
  const refusalId = refusal !== null ? bindingRefusalId(d.key) : undefined;
  const switchView = (open: boolean) => (target === undefined ? null : (
    <SwitchModelView cardKey={d.key} name={name} target={target} open={open} start={switching ?? START_BLANK} starts={starts} storedNote={props.storedNote} refusedBy={refusalId}
      onOpen={() => { focusNext.current = starts.length > 0 ? switchStartId(d.key) : switchConfirmId(d.key); setSwitching(START_BLANK); }}
      onStart={(s) => { focusNext.current = focusAfterStart(d.key, s, starts.length); setSwitching(s); }}
      onCancel={() => { focusNext.current = switchOpenId(d.key); setSwitching(null); }}
      onSwitch={() => {
        const next = switchModel(set, index, target, startBinding(starts, switching ?? START_BLANK));
        // The new model's version is the first field it needs; a switch back to the stored model closes it, so focus goes back to Switch model.
        props.focusAfter(next.bindings[index]!.versionOpen ? inputId(index, "modelVersion") : switchOpenId(d.key));
        setSwitching(null);
        props.onDraft(next);
      }} />
  ));
  return (
    <article className="card stack" aria-label={name}>
      <div>
        <div className="card-head">
          <div className="card-title">{name}{marker !== null ? <> <span className="chip chip-edited">{marker}</span></> : null}</div>
          <div className="card-head-actions">
            {switching === null ? switchView(false) : null}
            <button type="button" className="btn btn-quiet" id={removeBindingId(d.key)} aria-label={`Remove ${name}`}
              disabled={refusal !== null} aria-describedby={refusalId}
              onClick={() => { if (refusal !== null) return; props.focusAfter(focusAfterRemoveBinding(set, index)); props.onDraft(removeBinding(set, index)); }}>Remove</button>
          </div>
        </div>
        {refusal !== null ? <p className="field-help" id={refusalId}>{refusal}</p> : null}
        {d.versionOpen
          ? <p className="card-desc">Family and selector are not edited here; remove the binding and add it again to change them.</p>
          : <p className="card-desc">Model version <span className="mono">{d.stored.modelVersion}</span>, kept on save. Family and selector are not edited here.</p>}
      </div>
      {switching !== null ? switchView(true) : null}
      {d.versionOpen ? (
        <div className="param-grid">
          <VersionInput inputId={inputId(index, "modelVersion")} value={d.modelVersion} messages={messagesAt(issues, "modelVersion")}
            onChange={(text) => props.onDraft(setModelVersion(set, index, text))} />
        </div>
      ) : null}
      {segmentsOf(d.schemaKey).map((s) => (s.kind === "numbers" ? (
        <div key={s.fields[0]!.path} className="param-grid">
          {s.fields.map((f) => (
            <NumberInput key={f.path} field={f} inputId={inputId(index, f.path)} value={d.values[f.path] ?? ""} messages={messagesAt(issues, f.path)}
              onChange={(text) => props.onDraft(setValue(set, index, f.path, text))} />
          ))}
        </div>
      ) : (
        <RowsEditor key={s.field.path} field={s.field} rows={d.rows[s.field.path] ?? []} issues={issues} idOf={(path) => inputId(index, path)} foot={s.field.shape === "table" ? shareSumText(d, s.field) : null}
          onCell={(row, cell, text) => props.onDraft(setCell(set, index, s.field.path, row, cell, text))}
          onAdd={() => props.onDraft(addRow(set, index, s.field.path))}
          onRemove={(row) => props.onDraft(removeRow(set, index, s.field.path, row))} />
      )))}
      {schemaGroups(d.schemaKey).map((g) => {
        const on = d.groupOn[g.key] === true;
        const groupMessages = messagesAt(issues, g.key);
        // Remove is off on a mapped family's group, which the bind check would refuse on save.
        const refusal = groupRemoveRefusal(set, index, g.key);
        const refusalId = `${inputId(index, g.key)}-refusal`;
        return (
          <section key={g.key} className="stack" aria-label={g.label}>
            <div className="card-head">
              <div className="card-title">{g.label}</div>
              <button type="button" className="btn btn-quiet" id={inputId(index, g.key)} aria-label={`${on ? "Remove" : "Add"} ${g.label}`}
                disabled={refusal !== null} aria-describedby={refusal !== null ? refusalId : undefined}
                onClick={() => { if (refusal === null) props.onDraft(setGroup(set, index, g.key, !on)); }}>{on ? "Remove" : "Add"}</button>
            </div>
            {refusal !== null ? <p className="field-help" id={refusalId}>{refusal}</p> : null}
            {groupMessages.length > 0 ? <p className="field-help field-error">{groupMessages.map(issueText).join(" ")}</p> : null}
            {on ? (
              <div className="param-grid">
                {g.fields.map((f) => (
                  <NumberInput key={f.path} field={f} inputId={inputId(index, f.path)} value={d.values[f.path] ?? ""} messages={messagesAt(issues, f.path)}
                    onChange={(text) => props.onDraft(setValue(set, index, f.path, text))} />
                ))}
              </div>
            ) : <p className="card-desc">Not carried: this binding has no house-price response. Add opens the seven parameters to fill, each illustrative.</p>}
          </section>
        );
      })}
      {schemaForms(d.schemaKey).map((g) => <FormSection key={g.key} index={index} draft={d} set={set} form={g} issues={issues} onDraft={props.onDraft} />)}
    </article>
  );
}


/** A choice of fixed values; an optional one adds "None", which writes no key. */
function ChoiceInput(props: { field: ChoiceField; inputId: string; value: string; messages: string[]; onChange(text: string): void }) {
  const id = useId();
  const f = props.field;
  const invalid = props.messages.length > 0;
  return (
    <div className="field">
      <label className="field-label" htmlFor={props.inputId}>{f.label}</label>
      <select id={props.inputId} className="input" value={props.value} aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy([invalid ? `${id}msg` : null, `${id}help`])} onChange={(e) => props.onChange(e.target.value)}>
        {f.optional === true || !f.options.some((o) => o.value === props.value) ? <option value="">{f.optional === true ? "None" : "Pick one"}</option> : null}
        {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Messages id={`${id}msg`} messages={props.messages} />
      <span className="field-help" id={`${id}help`}>{f.help}</span>
    </div>
  );
}

/** A text value, a month or a name, written as typed. */
function TextInput(props: { field: TextField; inputId: string; value: string; messages: string[]; onChange(text: string): void }) {
  const id = useId();
  const f = props.field;
  const invalid = props.messages.length > 0;
  return (
    <div className="field">
      <label className="field-label" htmlFor={props.inputId}>{f.label}</label>
      <input id={props.inputId} className="input input-text" value={props.value} placeholder={f.format === "year-month" ? "YYYY-MM" : undefined}
        aria-invalid={invalid ? true : undefined} aria-describedby={describedBy([invalid ? `${id}msg` : null, `${id}help`])} onChange={(e) => props.onChange(e.target.value)} />
      <Messages id={`${id}msg`} messages={props.messages} />
      <span className="field-help" id={`${id}help`}>{f.help}</span>
    </div>
  );
}

/** A list longer than this opens folded, so a long rate series does not push the rest of the card down the page. */
const FOLD_ROWS = 12;

/**
 * One optional form of a binding card. Off, one line and Add; on, Remove, every shown field in its
 * shape, and for a form with a series, the picker that fills it from the shipped SOFR history.
 */
function FormSection(props: { index: number; draft: BindingDraft; set: SetDraft; form: FormGroup; issues: ReturnType<typeof issuesOf>; onDraft(next: SetDraft): void }) {
  const { index, draft: d, set, form: g, issues } = props;
  const [filling, setFilling] = useState<string | null>(null);
  const on = d.formOn[g.key] === true;
  const rootMessages = messagesAt(issues, g.key);
  const fill = () => {
    setFilling("Reading the shipped SOFR history");
    getDepositHistory().then(
      (h) => { setFilling(null); props.onDraft(fillSeries(set, index, g.key, { label: h.nmdWarmup.series.label, firstMonth: h.nmdWarmup.series.firstMonth, valuesPct: h.nmdWarmup.series.valuesPct })); },
      (e: unknown) => setFilling(`The history was not read: ${pageErrText(e)}`),
    );
  };
  const shown = g.fields.filter((f) => formFieldShown(d, f));
  return (
    <section className="stack" aria-label={g.label}>
      <div className="card-head">
        <div className="card-title">{g.label}</div>
        <button type="button" className="btn btn-quiet" id={inputId(index, g.key)} aria-label={`${on ? "Remove" : "Add"} ${g.label}`}
          onClick={() => props.onDraft(setForm(set, index, g.key, !on))}>{on ? "Remove" : "Add"}</button>
      </div>
      <p className="card-desc">{g.help}</p>
      {rootMessages.length > 0 ? <p className="field-help field-error">{rootMessages.map(issueText).join(" ")}</p> : null}
      {!on ? <p className="card-desc">{formOffLine(g)}</p> : (
        <>
          {g.fill !== undefined ? (
            <div className="sheet-actions">
              <button type="button" className="btn" onClick={fill} disabled={filling !== null && filling.startsWith("Reading")}>Fill the series from the shipped SOFR history</button>
              <span className="field-help">{filling ?? "Sets the series' name, first month and every monthly value (monthly averages of daily SOFR); the window stays as typed."}</span>
            </div>
          ) : null}
          <div className="param-grid">
            {shown.filter((f) => f.shape !== "list").map((f) => {
              const value = d.values[f.path] ?? "";
              const messages = messagesAt(issues, f.path);
              const onChange = (text: string) => props.onDraft(setValue(set, index, f.path, text));
              if (f.shape === "choice") return <ChoiceInput key={f.path} field={f} inputId={inputId(index, f.path)} value={value} messages={messages} onChange={onChange} />;
              if (f.shape === "text") return <TextInput key={f.path} field={f} inputId={inputId(index, f.path)} value={value} messages={messages} onChange={onChange} />;
              if (f.shape === "number") return <NumberInput key={f.path} field={f} inputId={inputId(index, f.path)} value={value} messages={messages} onChange={onChange} />;
              return null;
            })}
          </div>
          {shown.flatMap((f) => (f.shape === "list" ? [f] : [])).map((f) => {
            const rows = d.rows[f.path] ?? [];
            const editor = (
              <RowsEditor key={f.path} field={f as unknown as ListField} rows={rows} issues={issues} idOf={(path) => inputId(index, path)} foot={null}
                onCell={(row, cell, text) => props.onDraft(setCell(set, index, f.path, row, cell, text))}
                onAdd={() => props.onDraft(addRow(set, index, f.path))}
                onRemove={(row) => props.onDraft(removeRow(set, index, f.path, row))} />
            );
            if (rows.length <= FOLD_ROWS) return editor;
            const listMessages = issues.filter((i) => i.path === f.path || i.path.startsWith(`${f.path}[`));
            return (
              <details key={f.path} className="demo-card-details" open={listMessages.length > 0}>
                <summary>{f.label}: {rows.length} values</summary>
                {editor}
              </details>
            );
          })}
        </>
      )}
    </section>
  );
}

export interface AddBindingFormProps {
  value: AddDraft;
  book: PortfolioSpec | null;
  bookNote: string | null;
  stored: AssumptionSet[];
  /** Why some or all stored sets are not offered as starting values; shown under the starting-values choice. */
  storedNote: string | null;
  /** The id the Model select carries: the Add a binding control's, while the form stands in for it (Polish 2 M1). */
  selectId?: string;
  onChange(next: AddDraft): void;
  onAdd(): void;
  onCancel(): void;
}

/**
 * The add form: a model, then a family of the book in the Book pill that the
 * model fits, then an optional selector from that family's tags, then where the
 * values start (blank, or a stored binding of the same model). Props only.
 */
export function AddBindingForm(p: AddBindingFormProps) {
  const a = p.value;
  const reasonId = useId();
  const storedNoteId = useId();
  const starts = a.key === null ? [] : startChoices(p.stored, a.key);
  const block = addBlock(a, p.book, p.bookNote, starts);
  const families = a.key !== null && p.book !== null ? familyChoices(p.book, a.key) : [];
  const chips = a.familyId !== null && p.book !== null && families.some((f) => f.id === a.familyId) ? selectorChips(p.book, a.familyId) : [];
  // Shown whatever else holds Add off (Polish 2 A7).
  const noTags = selectorNote(a, p.book);
  return (
    <section className="card stack" aria-label="Add a binding form">
      <div className="card-title">Add a binding</div>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Model</span>
          <select id={p.selectId} value={a.key ?? ""} onChange={(e) => p.onChange(pickAddModel(e.target.value === "" ? null : (e.target.value as AddDraft["key"])))}>
            <option value="">Pick a model</option>
            {ADD_MODELS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
        {a.key !== null && p.book !== null && families.length > 0 ? (
          <label className="field">
            <span className="field-label">Family in {p.book.id}</span>
            <select value={a.familyId ?? ""} onChange={(e) => p.onChange(pickAddFamily(a, e.target.value === "" ? null : e.target.value))}>
              <option value="">Pick a family</option>
              {families.map((f) => <option key={f.id} value={f.id}>{f.id === f.label ? f.id : `${f.id}: ${f.label}`}</option>)}
            </select>
          </label>
        ) : null}
        {a.key !== null ? (
          <label className="field">
            <span className="field-label">Start the values from</span>
            <select value={a.start} aria-describedby={p.storedNote !== null ? storedNoteId : undefined} onChange={(e) => p.onChange({ ...a, start: e.target.value })}>
              <option value={START_BLANK}>Blank</option>
              {starts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {a.key !== null && p.storedNote !== null ? <p className="card-desc" id={storedNoteId}>{p.storedNote}</p> : null}
      {a.familyId !== null && chips.length > 0 ? (
        <fieldset className="stack chip-fieldset">
          <legend className="field-label">Selector</legend>
          {chips.map((g) => (
            <div key={g.tag} className="chip-row" role="group" aria-label={g.label}>
              <span className="field-help">{g.label}</span>
              {g.values.map((v) => {
                const on = chipOn(a.selector, g.tag, v);
                // The check is the pressed chip's non-colour cue; aria-pressed already carries the state, so it is hidden.
                return (
                  <button key={v} type="button" className="pill" aria-pressed={on}
                    onClick={() => p.onChange({ ...a, selector: toggleChip(a.selector, g.tag, v) })}>{on ? <span className="chip-check" aria-hidden="true">✓</span> : null}{v}</button>
                );
              })}
            </div>
          ))}
          <p className="card-desc" aria-live="polite">{bindsText(a.selector)}</p>
        </fieldset>
      ) : noTags !== null ? <p className="card-desc">{noTags}</p> : null}
      <div className="sheet-actions">
        <button type="button" className="btn" aria-disabled={block !== null ? true : undefined} aria-describedby={block !== null ? reasonId : undefined}
          onClick={block !== null ? undefined : p.onAdd}>{addLabel(a)}</button>
        <button type="button" className="btn btn-quiet" onClick={p.onCancel}>Cancel</button>
        {block !== null ? <span className="muted" id={reasonId} role="status">{block}</span> : null}
      </div>
    </section>
  );
}

export interface AddBindingPanelViewProps {
  /** The form's picks; null while the form is closed. */
  adding: AddDraft | null;
  book: PortfolioSpec | null;
  bookNote: string | null;
  stored: AssumptionSet[];
  storedNote: string | null;
  onOpen(): void;
  onChange(next: AddDraft): void;
  onAdd(): void;
  onCancel(): void;
}

/**
 * The Add a binding control (Polish 2 M1). Closed, one button, "Add a
 * binding". Open, the form alone: no button stays above it to discard the
 * picks, and its id moves to the form's Model select, so focus after the last
 * card is removed, or after the form opens or is cancelled, still lands on
 * this control. Props only.
 */
export function AddBindingPanelView(p: AddBindingPanelViewProps) {
  if (p.adding === null) {
    return (
      <div className="sheet-actions">
        <button type="button" className="btn" id={ADD_BINDING_ID} onClick={p.onOpen}>Add a binding</button>
      </div>
    );
  }
  return (
    <AddBindingForm value={p.adding} selectId={ADD_BINDING_ID} book={p.book} bookNote={p.bookNote} stored={p.stored} storedNote={p.storedNote}
      onChange={p.onChange} onAdd={p.onAdd} onCancel={p.onCancel} />
  );
}

/** The add panel with its picks, which are its own state, reset with the set and the book (addPanelKey). */
function AddBindingPanel(props: {
  set: SetDraft; book: PortfolioSpec | null; bookNote: string | null; stored: AssumptionSet[]; storedNote: string | null;
  onDraft(next: SetDraft): void; focusAfter(id: string): void;
}) {
  const [adding, setAdding] = useState<AddDraft | null>(null);
  // Opening and Cancel re-render this panel alone, so the page's focus hand-off would wait for some later render and
  // then pull focus back here mid-typing. The panel moves focus to its own control after its own commit instead (fix
  // I1): the Model select once open, the Add a binding button once closed; both carry ADD_BINDING_ID.
  const focusControl = useRef(false);
  useEffect(() => {
    if (!focusControl.current) return;
    focusControl.current = false;
    document.getElementById(ADD_BINDING_ID)?.focus();
  });
  const add = () => {
    if (adding === null || adding.key === null || adding.familyId === null) return;
    const copy = startBinding(startChoices(props.stored, adding.key), adding.start);
    // The new card lands last in the set; its model version is the first field it needs.
    props.focusAfter(inputId(props.set.bindings.length, "modelVersion"));
    props.onDraft(addBinding(props.set, adding.key, adding.familyId, adding.selector, copy));
    setAdding(null);
  };
  return (
    <AddBindingPanelView adding={adding} book={props.book} bookNote={props.bookNote} stored={props.stored} storedNote={props.storedNote}
      onOpen={() => { focusControl.current = true; setAdding(EMPTY_ADD); }} onChange={setAdding} onAdd={add}
      onCancel={() => { focusControl.current = true; setAdding(null); }} />
  );
}

/** Each changed field as label: old -> new (an added row or binding as label: added), above Save. Nothing shows until a value changes. */
export function ChangesList(props: { changes: Change[] }) {
  if (props.changes.length === 0) return null;
  return (
    <section className="card" aria-label="Changes">
      <div className="card-title">Changes</div>
      <ul className="diff-list">{props.changes.map((c, i) => <li key={i}>{changeLine(c)}</li>)}</ul>
    </section>
  );
}

/** The add panel's key: a new set or a new book starts the form over, so no selector pressed under one book is held under another. */
export function addPanelKey(setId: string, bookId: string | null): string {
  return `${setId}|${bookId ?? ""}`;
}

/** A binding card's key: the set and the card, so an adopted set remounts every card and each switch pick starts over (Polish 2 A3). */
export function cardKey(setId: string, key: number): string {
  return `${setId}|${key}`;
}

export function EditSetView(p: EditSetViewProps) {
  const draft = p.draft;
  const block = saveBlock(draft, p.reading, p.saving, p.saveId !== null || draft === null);
  const reasonId = useId();
  // Each field Save waits on, by binding, so the viewer can reach it from here (critic I4); a long group is one button (Polish 2 M3).
  const fixes = draft !== null && p.saving === null ? fixListItems(draft) : [];
  // Set by a binding remove, restore, add or switch; read once after the next commit, when the target is in the page.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    document.getElementById(target)?.focus();
  });
  const focusAfter = (id: string) => { focusNext.current = id; };
  return (
    <>
      <div className="plan-toolbar">
        <label>
          Assumption set{" "}
          <select id={SET_PICK_ID} aria-label="Assumption set" value={p.selected ?? ""} onChange={(e) => p.onPick(e.target.value === "" ? null : e.target.value)}>
            <option value="">Pick a set</option>
            {/* A set whose stored document is gone is listed from its meta (mfu-1) but cannot be read: off, so picking it never meets the 404. */}
            {p.sets.map((s) => <option key={s.id} value={s.id} disabled={s.documentMissing === true}>{setOptionText(s)}</option>)}
            {p.selected !== null && !p.sets.some((s) => s.id === p.selected) ? <option value={p.selected}>{p.selected}</option> : null}
          </select>
        </label>
        {draft !== null ? <label>Label <input className="input" aria-label="Label" value={draft.label} onChange={(e) => p.onDraft(setLabel(draft, e.target.value))} /></label> : null}
        {p.reading ? <span className="muted">Reading assumption set {p.selected}</span> : null}
      </div>
      {p.loadError !== null ? <section className="card unobs-panel" role="alert"><span className="status status-unobs">Assumption set not read</span><p className="unobs-text">{p.loadError}</p></section> : null}
      <div className="card card-desc">Save stores an edited copy under a new id; the stored set is never changed. Values are edited as the engine reads them, in the unit shown; the engine refuses a value outside its bounds.</div>
      {draft !== null ? (
        <>
          {groupsOf(draft).map((g) => (
            <section key={g.heading} className="stack" aria-label={g.heading}>
              <h2 className="card-title">{g.heading}</h2>
              {g.items.map((x) => (x.removed
                ? <RemovedCard key={cardKey(draft.source.id, x.draft.key)} draft={x.draft} set={draft} onDraft={p.onDraft} focusAfter={focusAfter} />
                : <BindingCard key={cardKey(draft.source.id, x.draft.key)} index={x.index} draft={x.draft} set={draft} stored={p.stored} storedNote={p.storedNote}
                  onDraft={p.onDraft} focusAfter={focusAfter} />))}
            </section>
          ))}
          <MacroMappingRow lines={macroMappingLines(draft.source.macroBindings)} />
          <AddBindingPanel key={addPanelKey(draft.source.id, p.bookId)} set={draft} book={p.book} bookNote={p.bookNote} stored={p.stored} storedNote={p.storedNote} onDraft={p.onDraft} focusAfter={focusAfter} />
          <ChangesList changes={changesOf(draft)} />
          <div className="sheet-actions">
            {/* Off by aria-disabled, not disabled, so a focused Save keeps focus through a save (the Polish 1 rule). */}
            <button type="button" className="btn btn-primary" id={SAVE_ID} aria-disabled={block !== null ? true : undefined} aria-describedby={block !== null ? reasonId : undefined}
              onClick={block !== null ? undefined : p.onSave}>
              {p.saveId !== null ? <>Save as <span className="mono">{p.saveId}</span></> : "Save"}
            </button>
            {block !== null ? <span className="muted" id={reasonId} role="status">{block}</span> : null}
          </div>
          {fixes.length > 0 ? (
            <ul className="fix-list" aria-label="Fields to fix">
              {fixes.map((x) => (
                <li key={`${x.target}|${x.label}`}><button type="button" className="btn btn-quiet" onClick={() => document.getElementById(x.target)?.focus()}>{x.label}</button></li>
              ))}
            </ul>
          ) : null}
          {p.check !== undefined ? <SetCheckRow {...p.check} /> : null}
        </>
      ) : null}
      {/* Under Save and its fix list, where a save's re-read of the list fails (Task 8 critic I2). Read the list again hands
          focus to Save, or to the picker with no set shown, after the next commit, so it never drops to the page as the alert
          unmounts (drive X1). */}
      {p.listNote !== null ? (
        <section className="card unobs-panel" role="alert">
          <span className="status status-unobs">Set list not read</span>
          <p className="unobs-text">{p.listNote}</p>
          <button type="button" className="btn" onClick={() => { focusAfter(focusAfterReread(draft !== null)); p.onReread(); }}>Read the list again</button>
        </section>
      ) : null}
      {p.note !== null ? (p.note.error ? <div className="card" role="alert">{p.note.text}</div> : <span role="status">{p.note.text}</span>) : null}
    </>
  );
}

/** Why no book fills the add form's pickers, or null when one does. */
function bookNoteOf(bookId: string | null, book: ReturnType<typeof useLoad<PortfolioSpec | null>>): string | null {
  if (bookId === null) return "Pick a book in the Book pill to list its families";
  if (book.state === "loading") return `Reading book ${bookId}`;
  if (book.state === "error") return `Book ${bookId} not read: ${reasonOf(book.error)}`;
  return null;
}

/** The check row's plans and note: null while the plans are read; none, with the reason, when they could not be. */
function plansShown(plans: PlansRead | null, state: LoadState<PlansRead>, setId: string): { plans: PlanReads[] | null; note: string | null } {
  if (plans !== null) return { plans: plansReading(plans.plans, setId), note: plansNoteOf(plans, setId) };
  if (state.state === "error") return { plans: [], note: `The stored plans could not be read, so none is offered. ${pageErrText(state.error)}` };
  return { plans: null, note: null };
}

/** Why some or all stored sets are not offered as starting values: null while they are read and when every one was read (fix I2). */
export function storedNoteOf(stored: LoadState<StoredRead>): string | null {
  if (stored.state === "error") return `The stored sets could not be read, so none is offered as a starting value. ${pageErrText(stored.error)}`;
  if (stored.state === "loading" || stored.value.unread === 0) return null;
  const n = stored.value.unread;
  return n === 1 ? "1 stored set could not be read; it is not offered as a starting value." : `${n} stored sets could not be read; they are not offered as starting values.`;
}

export function EditSetPage(props: { ws: string; query: Record<string, string>; bookId: string | null }) {
  // The just-saved id, held until the address names it (or names anything else).
  const [pendingId, setPendingId] = useState<string | null>(null);
  const selected = editSelected(pendingId, props.query);
  const [refresh, setRefresh] = useState(0);
  // One read of the store per refresh: the set list, then every stored set in full, the bindings a new or switched
  // binding can copy (Polish 2 A3). Read again after each save that stores and on Read the list again.
  const store = useLoad(() => readStore(), [refresh]);
  const body = useLoad<AssumptionSet | null>(() => (selected === null ? Promise.resolve(null) : getAssumptionSet(selected)), [selected]);
  const book = useLoad<PortfolioSpec | null>(() => (props.bookId === null ? Promise.resolve(null) : getPortfolio(props.bookId)), [props.bookId]);
  const [draft, setDraft] = useState<SetDraft | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [note, setNote] = useState<SaveNote | null>(null);
  // A Book change ends the save note, whatever book it was stamped with, so Book b1 to b2 to b1 does not bring it
  // back (Polish 3 T4; Polish 2 spec A1: the note clears on a Book change).
  useEffect(() => { setNote(null); }, [props.bookId]);
  // Draft edits since the page opened. A save note is stamped with the count and the book at its Save click and shows
  // only while both hold (Polish 2 A1); the adopt after a save and a set read are not edits.
  const edits = useRef(0);
  // A second click lands before React re-renders Save as off; the ref stops it (the Polish 1 double-click rule).
  const inFlight = useRef(false);
  // Only a read that landed resets the form.
  useEffect(() => {
    if (body.state === "ok") setDraft(body.value === null ? null : draftSet(body.value));
  }, [body]);
  // Any change of the address's set ends the pending hold: it has caught up with the save, or the viewer went elsewhere.
  useEffect(() => { setPendingId(null); }, [props.query.set]);
  // A save reply reads these when it lands, not the values its click closed over.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useRef({ selected, query: props.query });
  current.current = { selected, query: props.query };
  // Bumped by every pick, so a reply that lands after a pick but before the address moves is not adopted.
  const picks = useRef(0);
  // Critic M5: the last list read stays in force while the list is read again after a save, and every id this page
  // saved stays taken, so the Save label never names an id already stored.
  const lastList = useRef<AssumptionSetListItem[] | null>(null);
  if (store.state === "ok") lastList.current = store.value.listed;
  // The stored sets offered as starts: the last good read stays while the store is read again, so the choices never empty (Polish 2 A3).
  const lastStored = useRef<StoredRead | null>(null);
  const storedState: LoadState<StoredRead> = store.state === "ok" ? { state: "ok", value: store.value.stored } : store;
  const stored = storedShown(storedState, lastStored.current);
  lastStored.current = stored;
  const savedIds = useRef(new Set<string>());
  // Set Check: the stored plans, read with the store; the last good read stays while they are read again.
  const plansLoad = useLoad(() => readPlans(), [refresh]);
  const lastPlans = useRef<PlansRead | null>(null);
  if (plansLoad.state === "ok") lastPlans.current = plansLoad.value;
  const [checkPlan, setCheckPlan] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [checkNote, setCheckNote] = useState<CheckNote | null>(null);
  const checkInFlight = useRef(false);
  // A new set starts the check row over: its plans are that set's.
  useEffect(() => { setCheckPlan(null); setCheckNote(null); }, [selected]);
  // A failed list read with a list held keeps the editor and shows a note (Polish 2 A2); with none held it is the page.
  const failure = listFailure(store, lastList.current);
  if (failure?.kind === "page") return <div className="card" role="alert">{failure.text}</div>;
  const listed = lastList.current;
  const sets = listed ?? [];
  const taken = takenIds(listed, selected, savedIds.current);
  const saveId = saveIdFor(selected, listed, savedIds.current);
  const shown = draftShown(draft, selected);
  const save = async () => {
    if (inFlight.current || shown === null || saveId === null) return;
    inFlight.current = true;
    const from = shown.source.id;
    const pick = picks.current;
    const stamp = { edits: edits.current, bookId: props.bookId };
    setSaving(saveId);
    setNote(null);
    try {
      const r = await saveEdited(shown, taken);
      if (r.kind === "saved") savedIds.current.add(r.set.id);
      const outcome = saveOutcome(from, picks.current === pick ? current.current.selected : null, mounted.current);
      if (outcome === "none") return;
      if (r.kind === "refused") setNote({ text: r.text, error: true, ...stamp });
      else {
        setNote({ text: `Saved ${r.set.id}`, error: false, ...stamp });
        setRefresh((n) => n + 1);
        if (outcome === "adopt") {
          // The saved set is shown at once and selected in the same render, so the form, and a focused Save, stay
          // mounted while the address moves to it and it is read again.
          setDraft(draftSet(r.set));
          setPendingId(r.set.id);
          window.location.hash = editHref(props.ws, current.current.query, r.set.id);
        }
      }
    } finally {
      inFlight.current = false;
      setSaving(null);
    }
  };
  const shownPlans = shown === null ? null : plansShown(lastPlans.current, plansLoad, shown.source.id);
  const pickedPlan = shownPlans?.plans?.some((x) => x.id === checkPlan) === true ? checkPlan : null;
  // The check never touches Save: it reads the draft as Save would post it, under the source set's id, and stores nothing.
  const check = async () => {
    if (checkInFlight.current || shown === null || pickedPlan === null) return;
    checkInFlight.current = true;
    const pick = picks.current;
    const stamp = edits.current;
    setChecking(pickedPlan);
    setCheckNote(null);
    try {
      const outcome = await checkDraft(shown, pickedPlan);
      if (mounted.current && picks.current === pick) setCheckNote({ outcome, edits: stamp, planId: pickedPlan });
    } finally {
      checkInFlight.current = false;
      if (mounted.current) setChecking(null);
    }
  };
  const checkRow: SetCheckRowProps | undefined = shown === null || shownPlans === null ? undefined : {
    setId: shown.source.id, plans: shownPlans.plans, plansNote: shownPlans.note, planId: pickedPlan, checking,
    note: checkShown(checkNote, edits.current, pickedPlan)?.outcome ?? null,
    onPlan: setCheckPlan, onCheck: () => void check(),
  };
  return (
    <>
    {/* Studio slice S3f fix round (H1): reached from a Start here item, the page says what to change and offers Use this copy. */}
    <StartHereSetBanner ws={props.ws} query={props.query} shownSetId={shown?.source.id ?? selected} />
    <EditSetView
      check={checkRow}
      sets={sets} selected={selected} draft={shown} reading={selected !== null && body.state === "loading"}
      loadError={body.state === "error" ? reasonOf(body.error) : null} listNote={failure?.kind === "note" ? failure.text : null}
      saving={saving} saveId={saveId} note={noteShown(note, edits.current, props.bookId)}
      book={book.state === "ok" ? book.value : null} bookId={props.bookId} bookNote={bookNoteOf(props.bookId, book)} stored={stored?.sets ?? []}
      storedNote={storedNoteOf(stored !== null ? { state: "ok", value: stored } : storedState)}
      onPick={(id) => { picks.current += 1; setNote(null); setPendingId(null); window.location.hash = editHref(props.ws, props.query, id); }}
      onDraft={(next) => { edits.current += 1; setDraft(next); }} onSave={() => void save()} onReread={() => setRefresh((n) => n + 1)}
    />
    </>
  );
}
