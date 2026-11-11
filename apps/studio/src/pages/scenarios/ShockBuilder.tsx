// apps/studio/src/pages/scenarios/ShockBuilder.tsx
/**
 * Data > Scenarios > Custom rate shocks.
 * BuilderForm is props only. ShockBuilder holds the draft, which is local to
 * this layer and cleared on leaving it, runs the preview loop, and hands each
 * plan edit to the shared Scenarios editor through onEdit. Nothing here
 * computes a number: shockForm reads the form, the server serves the curves.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RunPlan, ScenarioLibrary } from "@alm/engine";
import { addInlineScenario, updateScenarioShock } from "../../scenarios/scenarioEdits";
import {
  addKnot, afterUpdate, checkForm, chooseStart, errorFor, focusAfterRemove, libraryIds, newBuilder, openBuilder, reconcile, removeKnot, setKnot, shapeSpec, startOptions, takenIds, withForm,
  type BuilderState, type FormCheck, type Shape, type ShockForm, type StartOption,
} from "../../scenarios/shockForm";
import { ShockPreviewCard } from "./ShockPreviewCard";
import { actionEnabled, useShockPreview } from "./useShockPreview";

const SHAPES: ReadonlyArray<{ id: Shape; label: string }> = [
  { id: "parallel", label: "Parallel" },
  { id: "twist", label: "Twist" },
  { id: "custom", label: "Tenor knots" },
];

/** A field's message, shown once the field holds text; an empty field only keeps the action off (spec Section 5.1 item 3). */
function messageFor(check: FormCheck, field: string, typed: string): string | null {
  return typed === "" ? null : errorFor(check, field);
}

/**
 * The message under a field, in the error colour, with the id its input's aria-describedby names. Not a live
 * region: the preview's Checking line is the one region a keystroke changes (Polish 2 C5).
 */
function msg(message: string | null, id: string): ReactNode {
  return message === null ? null : <span className="field-help field-error" id={id}>{message}</span>;
}

/**
 * An input's link to the text around it: aria-invalid while its message shows, and aria-describedby naming the
 * message (while it shows) and then the rest (unit, help). The name stays the label text alone (aria-labelledby).
 */
function describedBy(message: string | null, messageId: string, rest: ReadonlyArray<string | undefined> = []) {
  const ids = [message === null ? undefined : messageId, ...rest].filter((id): id is string => id !== undefined);
  return { "aria-invalid": message === null ? undefined : true, "aria-describedby": ids.length === 0 ? undefined : ids.join(" ") };
}

function NumField(props: { label: string; suffix: string; value: string; message: string | null; help?: string; onChange(v: string): void }) {
  const id = useId();
  const helpId = props.help === undefined ? undefined : `${id}help`;
  return (
    <label className="field">
      <span className="field-label" id={`${id}label`}>{props.label}</span>
      <span className="input-wrap">
        <input className="input" inputMode="decimal" aria-labelledby={`${id}label`} {...describedBy(props.message, `${id}msg`, [`${id}unit`, helpId])}
          value={props.value} onChange={(e) => props.onChange(e.target.value)} />
        <span className="input-suffix" id={`${id}unit`}>{props.suffix}</span>
      </span>
      {msg(props.message, `${id}msg`)}
      {props.help !== undefined ? <span className="field-help" id={helpId}>{props.help}</span> : null}
    </label>
  );
}

/**
 * Tenor-knot rows in the typed order. Each row shows its label "Knot N", the row number a refusal's hint names; the
 * number is a label, not a computed value. A removed row hands keyboard focus to the next row's Remove button, or
 * to Add knot when none follows, so focus never drops to the page (Task 8 fix S6 focus).
 */
function KnotRows(props: { form: ShockForm; check: FormCheck; onForm(f: ShockForm): void }) {
  const { form: f, check } = props;
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
  const remove = (i: number) => {
    focusNext.current = focusAfterRemove(f, i);
    props.onForm(removeKnot(f, i));
  };
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table" aria-label="Tenor knots">
          <thead><tr><th scope="col"><span className="sr-only">Knot</span></th><th scope="col" className="num">Tenor (years)</th><th scope="col" className="num">Shift (bp)</th><th scope="col"><span className="sr-only">Row</span></th></tr></thead>
          <tbody>
            {f.knots.map((k, i) => {
              const tenorMsg = messageFor(check, `knots[${i}].tenorYears`, k.tenorYears);
              const shiftMsg = messageFor(check, `knots[${i}].shockBp`, k.shockBp);
              return (
                <tr key={k.key}>
                  <th scope="row">{`Knot ${i + 1}`}</th>
                  <td className="num">
                    <input className="input input-short" aria-label={`Tenor in years, knot ${i + 1}`} {...describedBy(tenorMsg, `${id}t${k.key}`)} inputMode="decimal" value={k.tenorYears}
                      onChange={(e) => props.onForm(setKnot(f, i, { ...k, tenorYears: e.target.value }))} />
                    {msg(tenorMsg, `${id}t${k.key}`)}
                  </td>
                  <td className="num">
                    <input className="input input-short" aria-label={`Shift in bp, knot ${i + 1}`} {...describedBy(shiftMsg, `${id}s${k.key}`)} inputMode="decimal" value={k.shockBp}
                      onChange={(e) => props.onForm(setKnot(f, i, { ...k, shockBp: e.target.value }))} />
                    {msg(shiftMsg, `${id}s${k.key}`)}
                  </td>
                  <td>
                    <button type="button" className="btn btn-quiet btn-icon" aria-label={`Remove knot ${i + 1}`} onClick={() => remove(i)}
                      ref={(el) => { if (el === null) removeButtons.current.delete(k.key); else removeButtons.current.set(k.key, el); }}>×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {f.knots.length === 0 ? <span className="field-help field-error">{errorFor(check, "knots")}</span> : null}
      <div className="sheet-actions">
        <button type="button" className="btn" ref={addButton} onClick={() => props.onForm(addKnot(f))}>Add knot</button>
        <span className="field-help">The shift holds flat beyond the first and last knot. Rows keep the order typed; the engine refuses tenors that do not ascend.</span>
      </div>
    </div>
  );
}

export function BuilderForm(props: {
  state: BuilderState;
  check: FormCheck;
  options: StartOption[];
  enabled: boolean;
  /** The preview refuses the shape as it stands: the action's help names that reason. */
  refused: boolean;
  onState(next: BuilderState): void;
  onAction(): void;
}) {
  const { state: b, check } = props;
  const f = b.form;
  const setForm = (form: ShockForm) => props.onState(withForm(b, form));
  const editId = b.mode.kind === "edit" ? b.mode.id : null;
  const id = useId();
  const idMsg = messageFor(check, "id", f.id);
  return (
    <section className="card stack" aria-label="Shock builder">
      <div className="card-title">{editId === null ? "Build a shock" : <>Edit the shock of <span className="mono">{editId}</span></>}</div>
      {b.note !== null ? <p className="card-desc" role="status">{b.note}</p> : null}
      {editId === null ? (
        <label className="field">
          <span className="field-label" id={`${id}startlabel`}>Start from</span>
          <select aria-labelledby={`${id}startlabel`} aria-describedby={`${id}starthelp`} value={b.start} onChange={(e) => props.onState(chooseStart(b, e.target.value, props.options))}>
            <option value="">Blank</option>
            {props.options.map((o) => <option key={o.key} value={o.key}>{o.text}</option>)}
          </select>
          <span className="field-help" id={`${id}starthelp`}>A copy takes the shape and sizes only. Timing, assumption set and new business are not copied.</span>
        </label>
      ) : null}
      <div className="seg" role="group" aria-label="Shape">
        {SHAPES.map((s) => (
          <button key={s.id} type="button" aria-pressed={f.shape === s.id} onClick={() => setForm({ ...f, shape: s.id })}>{s.label}</button>
        ))}
      </div>
      {f.shape === "parallel" ? (
        <NumField label="Shift" suffix="bp" value={f.parallelBp} message={messageFor(check, "parallelBp", f.parallelBp)} help="The same shift at every tenor."
          onChange={(v) => setForm({ ...f, parallelBp: v })} />
      ) : null}
      {f.shape === "twist" ? (
        <>
          <NumField label="Shift at 0Y" suffix="bp" value={f.twist.shortBp} message={messageFor(check, "twist.shortBp", f.twist.shortBp)}
            onChange={(v) => setForm({ ...f, twist: { ...f.twist, shortBp: v } })} />
          <NumField label="Pivot" suffix="years" value={f.twist.pivotYears} message={messageFor(check, "twist.pivotYears", f.twist.pivotYears)}
            onChange={(v) => setForm({ ...f, twist: { ...f.twist, pivotYears: v } })} />
          <NumField label="Shift at the longest curve tenor" suffix="bp" value={f.twist.longBp} message={messageFor(check, "twist.longBp", f.twist.longBp)}
            onChange={(v) => setForm({ ...f, twist: { ...f.twist, longBp: v } })} />
          <span className="field-help">Zero at the pivot, straight lines on each side. The longest curve tenor is the market snapshot's; the preview names it.</span>
        </>
      ) : null}
      {f.shape === "custom" ? <KnotRows form={f} check={check} onForm={setForm} /> : null}
      <label className="field">
        <span className="field-label" id={`${id}idlabel`}>Id</span>
        <input className="input" aria-labelledby={`${id}idlabel`} {...describedBy(idMsg, `${id}idmsg`, [editId !== null ? `${id}idhelp` : undefined])}
          value={f.id} readOnly={editId !== null} onChange={(e) => setForm({ ...f, id: e.target.value })} />
        {msg(idMsg, `${id}idmsg`)}
        {editId !== null ? <span className="field-help" id={`${id}idhelp`}>An edit keeps the id, so a new-business binding on it stays valid.</span> : null}
      </label>
      <label className="field">
        <span className="field-label">Label (optional)</span>
        <input className="input" value={f.label} onChange={(e) => setForm({ ...f, label: e.target.value })} />
      </label>
      <div className="sheet-actions">
        <button type="button" className="btn btn-primary" disabled={!props.enabled} onClick={props.onAction}>{editId === null ? "Add to plan" : `Update ${editId}`}</button>
        <span className="field-help">
          {props.enabled ? "The preview answers this form." : props.refused ? "Off: the preview refuses this shock." : "On once the form is complete and the preview accepts the shock."}
        </span>
      </div>
      <p className="card-foot">Goes into the plan as an inline scenario. Save as keeps it.</p>
    </section>
  );
}

export function ShockBuilder(props: { plan: RunPlan; libraries: ScenarioLibrary[]; query: Record<string, string>; onEdit(plan: RunPlan): void }) {
  const { plan, libraries } = props;
  const wanted = props.query.scenario;
  const [b, setB] = useState<BuilderState>(() => openBuilder(plan, libraries, wanted));
  // A new scenario= link opens the builder again; the builder's own plan edits do not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setB(openBuilder(plan, libraries, wanted)); }, [wanted]);
  // The draft as the plan stands: an edit whose scenario the plan no longer holds (Reset removed it) opens blank, with the reason.
  const view = reconcile(b, plan, libraries);
  const check = checkForm(view.form, takenIds(plan, view.mode), libraryIds(libraries));
  // The preview reads the shape alone (spec Section 5.1 item 4), so a copy shows its curve before it has an id; the
  // action still needs the whole form (item 5). checkForm and shapeSpec share one reading of the shape, so an ok
  // preview answers the spec the action would add.
  const { preview, retry } = useShockPreview(plan.inputs.marketSnapshot, shapeSpec(view.form));
  const enabled = actionEnabled(check.ok, preview);
  const onAction = () => {
    if (!check.ok || !enabled) return;
    if (view.mode.kind === "edit") {
      props.onEdit(updateScenarioShock(plan, view.mode.id, check.rateSpec, check.label));
      setB(afterUpdate(view, view.mode.id, check.rateSpec, check.label));
      return;
    }
    props.onEdit(addInlineScenario(plan, check.label === undefined
      ? { id: check.id, rateSpec: check.rateSpec }
      : { id: check.id, label: check.label, rateSpec: check.rateSpec }));
    setB(newBuilder());
  };
  // shock-grid: each card keeps its own height, so the form does not move while the preview changes.
  return (
    <div className="grid-2 shock-grid">
      <BuilderForm state={view} check={check} options={startOptions(plan, libraries)} enabled={enabled} refused={preview.state === "refused"} onState={setB} onAction={onAction} />
      <ShockPreviewCard marketSnapshot={plan.inputs.marketSnapshot} preview={preview} onRetry={retry} />
    </div>
  );
}
