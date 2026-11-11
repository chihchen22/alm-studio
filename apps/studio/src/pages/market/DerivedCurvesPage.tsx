// apps/studio/src/pages/market/DerivedCurvesPage.tsx
/**
 * Market > Derived curves. The workspace's saved derived curves and the editor behind
 * them: an id, a label, the base curve the spread is added to, a grid of spreads by tenor, a fill from two curves, and
 * Save. The server validates every curve and estimates every fill; the page converts text to the engine's block
 * (market/derivedCurveModel.ts) and prints the server's refusals as they stand.
 *
 * The fill reads nothing stored into the workspace and writes nothing, so it stays open on a locked workspace; Save is
 * the one write, and a locked, archived or superseded workspace turns it off with its sentence.
 */
import "../../styles/curve-builder.css";
import { useId, useRef, useState } from "react";
import {
  ApiError, estimateDerivedCurve, listCurveSetups, listDerivedCurves, saveDerivedCurve,
  type CurveSetupsReply, type DerivedCurveListRow, type DerivedCurvesReply, type WorkspaceManifest,
} from "@alm/reader";
import { ByField, useBy } from "../../controls/ByName";
import { writeBlock } from "../../controls/attachBodies";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import {
  activeSetupIdOf, addRow, baseOptions, cellProblems, curveFromState, curveIdProblem, defaultState, curveOfListRow, defaultStateFor, estimatedOnText, fillOutcome, fillProblem, gridTenors,
  optionText, PLATFORM_DEFAULT_CURVE,
  removeRow, setCell, setFields, spreadSentence, stateFromCurve,
  type CurveOption, type DerivedCurveFields, type DerivedCurveState, type SpreadRow,
} from "../../market/derivedCurveModel";

// ---------------------------------------------------------------------------
// Copy

const INTRO =
  "A derived curve is a base curve plus a spread that varies by tenor. Save it under its own id; a rate index that names it reads the base curve plus the spread at the index's tenor.";
const BASE_HELP = "The curve the spread is added to. A run whose curve is a different one refuses the derived curve.";
const FILL_HELP =
  "Estimates each row's spread at the cut-off as the first curve minus the second: up to 12 months, the gap in their index rates; above 12 months, the gap in their par swap rates, as a swap index reads them, so a row above 12 months must sit on whole years. Nothing is saved until you press Save.";

// ---------------------------------------------------------------------------
// The view: props only

export interface ResultNote {
  ok: boolean;
  /** One line each: a sentence, or the server's refusals verbatim. */
  lines: string[];
}

export interface FillView {
  from: string;
  minus: string;
  /** The last fill's lines (a sentence, or the server's refusals verbatim); null when none ran. */
  lines: string[] | null;
}

export interface DerivedCurvesViewProps {
  /** The saved derived curves; null while the list is first read. */
  curves: DerivedCurveListRow[] | null;
  /** Slots whose document is gone, as the server names them. */
  missing: { id: string; problem: string }[];
  listError: string | null;
  /** The base and fill menus (baseOptions). */
  options: CurveOption[];
  /** Why the curve setups could not be read (the menus then hold the platform default only); absent or null when they were. */
  setupsError?: string | null;
  editor: DerivedCurveState;
  /** Why this workspace takes no write (writeBlock); null when it does. */
  blocked: string | null;
  by: string;
  /** What the page is waiting for; null when idle. */
  busy: string | null;
  note: ResultNote | null;
  fill: FillView;
  onBy(v: string): void;
  onEdit(row: DerivedCurveListRow): void;
  onNew(): void;
  onField(patch: DerivedCurveFields): void;
  onCell(key: number, patch: Partial<Omit<SpreadRow, "key">>): void;
  onAddRow(): void;
  onRemoveRow(key: number): void;
  onFillFrom(v: string): void;
  onFillMinus(v: string): void;
  onFill(): void;
  onSave(): void;
}

/** The menu options plus the current value verbatim when the list does not hold it (a value the server sent). */
function withCurrent(options: readonly CurveOption[], value: string): CurveOption[] {
  return options.some((o) => o.value === value) ? [...options] : [...options, { value, text: value }];
}

const rowsWord = (n: number): string => `${n} ${n === 1 ? "row" : "rows"}`;

function CurveList(p: DerivedCurvesViewProps) {
  const off = p.busy !== null;
  return (
    <section className="card" aria-label="Saved derived curves">
      <div className="card-title">Saved derived curves</div>
      {p.listError !== null ? <p role="alert">{p.listError}</p> : null}
      {p.curves === null && p.listError === null ? <p className="muted">Reading the derived curves</p> : null}
      {p.curves !== null && p.curves.length === 0 ? <p className="card-desc">This workspace holds no derived curve.</p> : null}
      {p.curves !== null && p.curves.length > 0 ? (
        <ul className="cb-list">
          {p.curves.map((c) => {
            const name = c.label === "" ? c.curveId : c.label;
            return (
              <li key={c.id} className="cb-item">
                <div className="cb-item-head"><span className="cb-item-label">{name}</span></div>
                <span className="mono muted cb-item-id">{c.curveId}</span>
                <span className="muted">{`Base: ${optionText(p.options, c.base)}, ${rowsWord(c.spreads.length)}`}</span>
                {estimatedOnText(c) === null ? null : <span className="muted cb-item-stamp">{estimatedOnText(c)}</span>}
                <div className="cb-item-actions">
                  <button type="button" className="btn" aria-label={`Edit ${name}`} disabled={off} onClick={() => p.onEdit(c)}>Edit</button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {p.missing.map((m) => <p key={m.id} className="field-help field-error" role="alert">{`${m.id}: ${m.problem}`}</p>)}
      {/* A workspace that takes no write says so once, beside Save. */}
      {p.blocked === null && p.by.trim() === "" && p.curves !== null ? <p className="field-help">Type your name below to save a derived curve.</p> : null}
    </section>
  );
}

function CurveForm(p: DerivedCurvesViewProps & { idProblem: string | null }) {
  const ed = p.editor;
  return (
    <section className="card" aria-label="Derived curve">
      <div className="card-title">Derived curve</div>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Curve id</span>
          <input className="input" aria-label="Curve id" aria-invalid={ed.id !== "" && p.idProblem !== null ? true : undefined} value={ed.id} onChange={(e) => p.onField({ id: e.target.value })} />
          <span className="field-help">Saving under the same id replaces that curve; a new id adds one</span>
        </label>
        <label className="field">
          <span className="field-label">Label</span>
          <input className="input" aria-label="Label" value={ed.label} onChange={(e) => p.onField({ label: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Base curve</span>
          <select aria-label="Base curve" value={ed.base} onChange={(e) => p.onField({ base: e.target.value })}>
            {withCurrent(p.options, ed.base).map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
          </select>
          <span className="field-help">{BASE_HELP}</span>
        </label>
      </div>
      {ed.id !== "" && p.idProblem !== null ? <p className="field-help field-error" role="alert">{p.idProblem}</p> : null}
      {p.setupsError !== undefined && p.setupsError !== null
        ? <p className="field-help field-error" role="alert">{`The curve setups could not be read, so the menus list the platform default curve only: ${p.setupsError}`}</p>
        : null}
    </section>
  );
}

function GridCard(p: DerivedCurvesViewProps & { problems: string[] }) {
  const rows = p.editor.rows;
  return (
    <section className="card table-card" aria-label="Spreads">
      <div className="card-title">Spreads</div>
      <p className="card-desc">One row per tenor, in whole months and ascending, with the spread in basis points. Between rows the spread is a straight line in months; before the first row and beyond the last it is flat.</p>
      {rows.length === 0 ? <p className="muted">No rows yet. Add a row.</p> : (
        <div className="table-wrap cb-grid">
          <table className="table">
            <thead>
              <tr><th scope="col">Row</th><th scope="col">Tenor, months</th><th scope="col">Spread, bp</th><th scope="col">Remove</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const n = i + 1;
                return (
                  <tr key={r.key}>
                    <th scope="row" className="num">{n}</th>
                    <td><input className="input cb-tenor" aria-label={`Tenor, months, row ${n}`} inputMode="numeric" value={r.tenorText} onChange={(e) => p.onCell(r.key, { tenorText: e.target.value })} /></td>
                    <td><input className="input cb-value" aria-label={`Spread, bp, row ${n}`} inputMode="decimal" value={r.spreadText} onChange={(e) => p.onCell(r.key, { spreadText: e.target.value })} /></td>
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
      {p.problems.length > 0 ? <ul className="diff-list cb-lines" aria-label="Cells that cannot be read">{p.problems.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
    </section>
  );
}

function FillCard(p: DerivedCurvesViewProps & { tenorsRead: boolean }) {
  const reasonId = useId();
  const off = p.busy !== null || !p.tenorsRead;
  // The same curve in both menus fills zeros: Fill stays focusable and says why (the Save pattern).
  const same = fillProblem(p.fill.from, p.fill.minus);
  return (
    <section className="card" aria-label="Fill from two curves">
      <div className="card-title">Fill from two curves</div>
      <p className="card-desc">{FILL_HELP}</p>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Fill from</span>
          <select aria-label="Fill from" value={p.fill.from} onChange={(e) => p.onFillFrom(e.target.value)}>
            {withCurrent(p.options, p.fill.from).map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Minus</span>
          <select aria-label="Minus" value={p.fill.minus} onChange={(e) => p.onFillMinus(e.target.value)}>
            {withCurrent(p.options, p.fill.minus).map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
          </select>
        </label>
      </div>
      <div className="sheet-actions">
        <button
          type="button" className="btn" disabled={off} aria-disabled={!off && same !== null ? true : undefined}
          aria-describedby={same !== null ? reasonId : undefined} onClick={off || same !== null ? undefined : p.onFill}
        >Fill</button>
        {!p.tenorsRead ? <span className="muted">Every tenor must be a whole number of months before a fill.</span> : null}
        {same !== null ? <span className="muted" id={reasonId}>{same}</span> : null}
      </div>
      {p.fill.lines === null ? null : (
        <ul className="diff-list cb-lines" role="status" aria-label="Fill result">{p.fill.lines.map((s, i) => <li key={i}>{s}</li>)}</ul>
      )}
      <p className="card-foot">Source: POST /api/workspaces/:id/derived-curves/estimate</p>
    </section>
  );
}

function SaveCard(p: DerivedCurvesViewProps & { why: string | null }) {
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
        <button type="button" className="btn" disabled={p.busy !== null} onClick={p.onNew}>Start a new derived curve</button>
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

export function DerivedCurvesView(p: DerivedCurvesViewProps) {
  const problems = cellProblems(p.editor);
  const idProblem = curveIdProblem(p.editor.id);
  const why = p.blocked !== null ? null
    : idProblem !== null ? idProblem
    : p.editor.label.trim() === "" ? "Give the curve a label."
    : p.editor.rows.length === 0 ? "Add at least one row."
    : problems.length > 0 ? "Every cell must read before a save."
    : p.by.trim() === "" ? "Type your name first."
    : null;
  return (
    <div className="cb-page">
      <section className="card" aria-label="About derived curves">
        <div className="card-title">Derived curves</div>
        <p className="card-desc">{INTRO}</p>
        <p className="card-desc">{spreadSentence}</p>
      </section>
      <CurveList {...p} />
      <CurveForm {...p} idProblem={idProblem} />
      <GridCard {...p} problems={problems} />
      <FillCard {...p} tenorsRead={gridTenors(p.editor) !== null} />
      <SaveCard {...p} why={why} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page: the reads, the editor state and the calls

/** A write's failure in words: a 409 adds the reload prompt the curve setups page gives. */
function writeError(e: unknown): string {
  return e instanceof ApiError && e.status === 409 ? `${errText(e)} Reload the page to read the workspace's current head.` : errText(e);
}

export function DerivedCurvesPage(props: { ws: string; head?: WorkspaceManifest | null; onChanged?: () => void }) {
  const head = props.head ?? null;
  const onChanged = props.onChanged ?? (() => {});
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<DerivedCurveState>(defaultState);
  // The editor as last rendered, for a fill to compare its starting mark against when it lands.
  const latest = useRef(editor);
  latest.current = editor;
  const [by, setBy] = useBy();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<ResultNote | null>(null);
  const [fill, setFill] = useState<FillView>({ from: PLATFORM_DEFAULT_CURVE, minus: PLATFORM_DEFAULT_CURVE, lines: null });
  const list = useLoad<DerivedCurvesReply>(() => listDerivedCurves(props.ws), [props.ws, refresh, head?.revision]);
  const setups = useLoad<CurveSetupsReply>(() => listCurveSetups(props.ws), [props.ws, head?.revision]);
  const [kept, setKept] = useState<DerivedCurvesReply | null>(null);
  if (list.state === "ok" && list.value !== kept) setKept(list.value);

  if (head === null) return <div className="card muted">Reading the workspace</div>;

  const shownList = list.state === "ok" ? list.value : kept;
  // The menus name each setup by its own id (setupId), the id a derived curve's base and the estimate take.
  const setupRows = setups.state === "ok" ? setups.value.setups : [];
  const options = baseOptions(setupRows.map((s) => ({ id: s.setupId, label: s.label, active: s.active })));
  // A new curve sits on the curve a run reads: the active setup when one is active.
  const activeSetupId = activeSetupIdOf(setupRows);
  const edit = (next: (ed: DerivedCurveState) => DerivedCurveState) => { setEditor(next); setNote(null); };

  // One call at a time. The result note is left alone here: a save sets its own, and a fill keeps the last.
  const call = async (what: string, fn: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const onEdit = (row: DerivedCurveListRow) => {
    setEditor((ed) => ({ ...stateFromCurve(curveOfListRow(row)), version: ed.version + 1 }));
    setFill((f) => ({ ...f, lines: null }));
    setNote({ ok: true, lines: [`Editing ${row.curveId}. Save under the same id to replace it.`] });
  };

  const onSave = () => {
    const curve = curveFromState(editor);
    void call(`Saving ${curve.id}`, async () => {
      setNote(null);
      try {
        const r = await saveDerivedCurve(head.id, curve, head.revision, by.trim());
        if (r.ok) {
          const same = JSON.stringify(curveFromState(latest.current)) === JSON.stringify(curve);
          setNote({ ok: true, lines: [same ? `Saved ${curve.id}.` : `Saved ${curve.id} as it stood when Save was pressed. The editor changed after the save started; save again to keep the change.`] });
          setRefresh((n) => n + 1);
          onChanged();
        } else {
          setNote({ ok: false, lines: r.refusals.length > 0 ? r.refusals : ["The server refused the derived curve and gave no reason."] });
        }
      } catch (e) {
        setNote({ ok: false, lines: [writeError(e)] });
      }
    });
  };

  const onFill = () => {
    const tenors = gridTenors(editor);
    if (tenors === null || fillProblem(fill.from, fill.minus) !== null) return;
    const sent = { from: fill.from, minus: fill.minus };
    // The grid's version when the call begins (ruling R10): a cell or row changed while it runs is never overwritten; an
    // id, label or base typed meanwhile is kept and the fill still lands.
    const started = latest.current.version;
    const names = options;
    void call("Estimating the spreads", async () => {
      try {
        const reply = await estimateDerivedCurve(head.id, sent.from, sent.minus, tenors);
        const out = fillOutcome(latest.current, started, reply, sent, names);
        if (out.state !== latest.current) {
          // A functional update, so a keystroke queued after the last render is judged by the same version rule
          // rather than overwritten. The last save's note no longer describes the grid, so it goes.
          setEditor((ed) => fillOutcome(ed, started, reply, sent, names).state);
          setNote(null);
        }
        setFill((f) => ({ ...f, lines: out.lines }));
      } catch (e) {
        setFill((f) => ({ ...f, lines: [errText(e)] }));
      }
    });
  };

  return (
    <DerivedCurvesView
      curves={shownList === null ? null : shownList.curves}
      missing={shownList?.missing ?? []}
      listError={list.state === "error" ? errText(list.error) : null}
      options={options}
      setupsError={setups.state === "error" ? errText(setups.error) : null}
      editor={editor}
      blocked={writeBlock(head, "its derived curves")}
      by={by}
      busy={busy}
      note={note}
      fill={fill}
      onBy={setBy}
      onEdit={onEdit}
      onNew={() => { setEditor((ed) => ({ ...defaultStateFor(activeSetupId), version: ed.version + 1 })); setFill((f) => ({ ...f, lines: null })); setNote(null); }}
      onField={(patch) => edit((ed) => setFields(ed, patch))}
      onCell={(key, patch) => edit((ed) => setCell(ed, key, patch))}
      onAddRow={() => edit(addRow)}
      onRemoveRow={(key) => edit((ed) => removeRow(ed, key))}
      onFillFrom={(from) => setFill((f) => ({ ...f, from }))}
      onFillMinus={(minus) => setFill((f) => ({ ...f, minus }))}
      onFill={onFill}
      onSave={onSave}
    />
  );
}
