// apps/studio/src/pages/market/IndexHistoryPanel.tsx
/**
 * The History panel of one rate index, opened from the indices table of
 * Data > Market > Rate indices. It shows the index's stored history as a monthly line chart, its last month and the
 * gap to the market's cut-off month, and imports a .csv or .xlsx file of dated fixings under a declared unit. The
 * server reads the file, keeps each month's last fixing, converts the unit and stores the document under its content
 * id; the panel prints what it sends back. An import changes no market: the page adds a row that points the index at
 * the new history, which the market's preview and save carry. Clear the history adds the row that clears it.
 */
import { useId, useState } from "react";
import { getIndexHistory, importIndexHistory } from "@alm/reader";
import type { IndexHistory } from "@alm/engine";
import { LinePlot } from "../../charts/LinePlot";
import { errText, reasonOf } from "../../errText";
import { useLoad } from "../../useLoad";
import {
  clearNoteOf, HISTORY_UNIT_CHOICES, historyMonthLabel, historyPoints, historySummaryText, historyTicks, importBlock, importNoteOf, parseHistoryUnit,
} from "../../market/indexHistoryModel";

export type IndexHistoryState =
  | { state: "none" }
  | { state: "loading" }
  | { state: "error"; text: string }
  | { state: "ok"; id: string; value: IndexHistory };

export interface IndexHistoryNote { ok: boolean; text: string; refusals: string[] }

export interface IndexHistoryViewProps {
  indexId: string;
  history: IndexHistoryState;
  /** The chosen market's calibration date; its month is the cut-off. */
  calibrationDate?: string;
  /** The chosen file's name; null before one is chosen. */
  file: string | null;
  /** The chosen file's size in bytes: a file over the cap is refused before it is read. */
  fileSize?: number;
  /** The unit select's text: empty until one is chosen. */
  unit: string;
  label: string;
  busy: boolean;
  note: IndexHistoryNote | null;
  /** The page is busy with another call. */
  off: boolean;
  /** Changes when the file input must be emptied, after an import that landed. */
  inputKey?: number;
  onFile(f: File | null): void;
  onUnit(u: string): void;
  onLabel(l: string): void;
  onImport(): void;
  onClear(): void;
}

const yTick = (v: number): string => v.toFixed(2);
const valueText = (v: number): string => `${v.toFixed(4)} percent`;
/** Why Import is off when only the page's own call holds it. */
export const BUSY_ELSEWHERE = "Another call on this page is running; Import waits for it.";

export function IndexHistoryView(p: IndexHistoryViewProps) {
  const reasonId = useId();
  const { history: h, note } = p;
  const block = importBlock({ file: p.file, ...(p.fileSize === undefined ? {} : { size: p.fileSize }), unit: p.unit, busy: p.busy }) ?? (p.off ? BUSY_ELSEWHERE : null);
  const importOff = block !== null;
  const editOff = p.busy || p.off;
  return (
    <section className="card" aria-label={`History of ${p.indexId}`}>
      <div className="card-title">History of <span className="mono">{p.indexId}</span></div>
      {h.state === "none" ? <p className="muted">This index carries no history.</p> : null}
      {h.state === "loading" ? <p className="muted" role="status">Reading the history</p> : null}
      {h.state === "error" ? <p className="muted" role="alert">{h.text}</p> : null}
      {h.state === "ok" ? (
        <>
          <p className="card-desc">{historySummaryText(h.value, p.calibrationDate)}</p>
          <LinePlot
            series={[{ id: "h", label: p.indexId, tone: "accent", points: historyPoints(h.value) }]}
            xScale="linear"
            xTicks={historyTicks(h.value)}
            xLabel={(x) => historyMonthLabel(h.value, x)}
            yTick={yTick}
            format={valueText}
            unit="Percent"
            height={180}
            legend={false}
          />
          <p className="card-foot">
            Source: GET /api/index-histories/{h.id}; {h.value.source.fileName}, {h.value.source.frequency} rows read as month-end fixings, declared {h.value.source.unit}
          </p>
        </>
      ) : null}
      <div className="param-grid">
        <label className="field">
          <span className="field-label">History file (.csv or .xlsx)</span>
          <input key={p.inputKey ?? 0} className="input" type="file" accept=".csv,.xlsx" aria-label="History file" disabled={editOff}
            onChange={(e) => p.onFile(e.target.files?.[0] ?? null)} />
          <span className="field-help">Two columns, date and value. Dates YYYY-MM-DD, YYYY-MM or Excel dates; a daily file keeps each month&apos;s last fixing.</span>
        </label>
        <label className="field">
          <span className="field-label">Unit</span>
          <select aria-label="Unit" disabled={editOff} value={p.unit} onChange={(e) => p.onUnit(e.target.value)}>
            {HISTORY_UNIT_CHOICES.map((c) => <option key={c.unit} value={c.unit}>{c.text}</option>)}
          </select>
          <span className="field-help">The unit the file&apos;s values are in; it is never guessed</span>
        </label>
        <label className="field">
          <span className="field-label">Label</span>
          <input className="input" aria-label="History label" disabled={editOff} value={p.label} onChange={(e) => p.onLabel(e.target.value)} />
          <span className="field-help">Leave empty for the file name</span>
        </label>
      </div>
      <div className="sheet-actions">
        {/* Off by aria-disabled, not disabled, so a focused button keeps focus through a call (the Polish 1 rule). */}
        <button type="button" className="btn btn-primary" aria-disabled={importOff ? true : undefined} aria-describedby={block !== null ? reasonId : undefined}
          onClick={importOff ? undefined : p.onImport}>Import</button>
        {h.state === "none" ? null : <button type="button" className="btn" disabled={editOff} onClick={p.onClear}>Clear the history</button>}
        {/* While an import runs the block reads "An import is in progress.", so it is the busy line too; while the page's
            own call runs it reads BUSY_ELSEWHERE. */}
        {block !== null ? <span className="muted" id={reasonId} role="status">{block}</span> : null}
      </div>
      {note === null ? null : note.ok ? <p role="status">{note.text}</p> : (
        <div role="alert">
          <span className="status status-breach">{note.text}</span>
          {note.refusals.length > 0 ? <ul className="diff-list">{note.refusals.map((r, i) => <li key={i}>{r}</li>)}</ul> : null}
        </div>
      )}
    </section>
  );
}

/**
 * The panel: holds the file, the unit, the label and the import's note, reads the stored history the index names,
 * and imports. A landed import calls onImported with the new id, and the page adds the row that points the index at it.
 */
export function IndexHistoryPanel(p: { indexId: string; historyId?: string; calibrationDate?: string; off: boolean; onImported(id: string): void; onClear(): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [unitText, setUnitText] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<IndexHistoryNote | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const { historyId } = p;
  const load = useLoad<{ id: string; value: IndexHistory } | null>(
    () => (historyId === undefined ? Promise.resolve(null) : getIndexHistory(historyId).then((value) => ({ id: historyId, value }))),
    [historyId],
  );
  // A read for another id is still on screen for one render after the id changes; it reads as loading.
  const history: IndexHistoryState = historyId === undefined ? { state: "none" }
    : load.state === "error" ? { state: "error", text: `History ${historyId} could not be read: ${reasonOf(load.error)}` }
      : load.state === "ok" && load.value !== null && load.value.id === historyId ? { state: "ok", id: historyId, value: load.value.value }
        : { state: "loading" };
  const onImport = async () => {
    if (busy || p.off || file === null || importBlock({ file: file.name, size: file.size, unit: unitText, busy }) !== null) return;
    // The button is off without a unit; the parse keeps the type honest (plan v2 N8).
    const unit = parseHistoryUnit(unitText);
    if (unit === null) return;
    setBusy(true);
    setNote(null);
    try {
      const reply = await importIndexHistory(await file.arrayBuffer(), file.name, { unit, ...(label.trim() === "" ? {} : { label: label.trim() }) });
      setNote(importNoteOf(reply, p.calibrationDate));
      if (reply.ok) {
        p.onImported(reply.id);
        setFile(null);
        setInputKey((k) => k + 1);
      }
    } catch (e) {
      setNote({ ok: false, text: errText(e), refusals: [] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <IndexHistoryView
      indexId={p.indexId} history={history} calibrationDate={p.calibrationDate}
      file={file === null ? null : file.name} {...(file === null ? {} : { fileSize: file.size })} unit={unitText} label={label} busy={busy} note={note} off={p.off} inputKey={inputKey}
      onFile={(f) => { setFile(f); setNote(null); }}
      onUnit={setUnitText}
      onLabel={setLabel}
      onImport={() => void onImport()}
      onClear={() => { p.onClear(); setNote(clearNoteOf(p.indexId)); }}
    />
  );
}
