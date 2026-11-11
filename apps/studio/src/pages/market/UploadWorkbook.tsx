// apps/studio/src/pages/market/UploadWorkbook.tsx
/**
 * Market > Yield curves: the market workbook upload card (follow-up F1). One call does the whole job: the raw .xlsx
 * bytes go to POST /api/market/import-workbook with the workspace id and the typed name, and the server runs the
 * Production-lock and cut-off-clash checks before it stores anything, then sets the snapshot on the market block. The
 * page only validates the as-of text it was given, prints the reply, and asks the shell to read the head again.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError, importMarketWorkbook, workbookStamp, type WorkspaceManifest } from "@alm/reader";
import { ByField, useBy } from "../../controls/ByName";
import { errText } from "../../errText";

/** How many workbook errors the card lists before it says how many more there are. */
const MAX_LISTED = 10;
const REASON_ID = "upload-workbook-reason";
const STAMP_ID = "upload-workbook-stamp";
const ASOF_WORDS = "Write the as-of date as YYYY-MM-DD, for example 2026-03-31.";
const ID_TAKEN = "That snapshot id is already stored. Pick it under Attach a stored snapshot, or import under a new id.";
/** The taken id is the one this workspace already holds, so picking it from the list would change nothing. */
const ID_ATTACHED = "That snapshot id is already stored and is the one attached to this workspace. Import under a new id to replace it.";

/** The sentence for a filename whose date suffix is not on a calendar page; the server would stamp it as it is. */
function badDateWords(raw: string): string {
  return `The date in the filename (${raw}) is not a real date. Rename the file.`;
}

/** The line under the file field: the date the snapshot will carry, or where its date will come from. Null before a file. */
export function stampSentence(name: string | null): string | null {
  if (name === null) return null;
  const stamp = workbookStamp(name);
  if (stamp.kind === "bad") return badDateWords(stamp.raw);
  return stamp.kind === "date" ? `The snapshot will be stamped ${stamp.date}.` : "The filename has no date; the as-of date below is used.";
}

/** Whether the card is offered: the server refuses an import into a locked, archived or superseded workspace. */
export function uploadWritable(head: WorkspaceManifest): boolean {
  return head.status === "active" && head.lock === null;
}

/** The sentence for an as-of text that is not a real YYYY-MM-DD date; null for nothing at all or a good date. */
export function asOfProblem(text: string): string | null {
  const t = text.trim();
  if (t === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m === null) return ASOF_WORDS;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  return real ? null : ASOF_WORDS;
}

/** Why the button is off, in words; null when it can be pressed. */
export function uploadBlock(s: { file: string | null; by: string; busy: boolean }): string | null {
  if (s.busy) return "An import is in progress.";
  if (s.file === null) return "Choose a .xlsx workbook first.";
  const stamp = workbookStamp(s.file);
  if (stamp.kind === "bad") return badDateWords(stamp.raw);
  if (s.by.trim() === "") return "Type your name first; the server records who attached the snapshot.";
  return null;
}

export type UploadOutcome =
  | { kind: "ok"; id: string; calibrationDate: string | null; note: string }
  | { kind: "invalid"; message: string }
  /** `attached` is the snapshot a refusal says is attached to this workspace; set only for that refusal. */
  | { kind: "refused"; message: string; items: string[]; more: number; follow?: string; attached?: string };

/**
 * What the card keeps once the attached snapshot id has changed: an "Imported ... and attached it." note, or a refusal
 * that says its snapshot is the attached one, is false once another snapshot (or none) is attached, so it goes. The
 * person's own import moves the id to the one its note names and keeps it; any other refusal stays true and stays.
 */
export function outcomeOnAttach(outcome: UploadOutcome | null, attachedId: string | null): UploadOutcome | null {
  if (outcome?.kind === "ok" && outcome.id !== attachedId) return null;
  if (outcome?.kind === "refused" && outcome.attached !== undefined && outcome.attached !== attachedId) return null;
  return outcome;
}

/** One workbook error as a line: the route sends `{ message }` rows; anything else prints as it came. */
function itemText(x: unknown): string {
  if (typeof x === "string") return x;
  if (typeof x === "object" && x !== null && typeof (x as { message?: unknown }).message === "string") return (x as { message: string }).message;
  return JSON.stringify(x);
}

/**
 * The import: the as-of text is checked first and a bad one makes no request. On success the caller's `onChanged` runs
 * once (the head and readiness are read again); a refusal prints the server's own text and runs nothing.
 */
export async function importWorkbook(args: {
  head: WorkspaceManifest;
  file: { name: string; arrayBuffer(): Promise<ArrayBuffer> };
  asOf: string;
  /** The typed snapshot id; empty lets the server derive one from the filename. */
  id?: string;
  by: string;
  onChanged(): void;
}): Promise<UploadOutcome> {
  // The kernel stamps an impossible suffix whatever as-of text goes with it, so nothing is sent.
  const stamp = workbookStamp(args.file.name);
  if (stamp.kind === "bad") return { kind: "invalid", message: badDateWords(stamp.raw) };
  const problem = asOfProblem(args.asOf);
  if (problem !== null) return { kind: "invalid", message: problem };
  // A date in the filename is stamped by the server, and a sent as-of date would replace what the route finds there,
  // so the as-of text goes only with a filename that carries no date.
  const asOf = stamp.kind === "none" ? args.asOf.trim() : "";
  const id = (args.id ?? "").trim();
  try {
    const bytes = await args.file.arrayBuffer();
    const reply = await importMarketWorkbook(bytes, args.file.name, {
      workspaceId: args.head.id,
      by: args.by.trim(),
      ...(asOf === "" ? {} : { asOf }),
      ...(id === "" ? {} : { id }),
    });
    const calibrationDate = reply.summary?.calibrationDate ?? null;
    args.onChanged();
    return {
      kind: "ok",
      id: reply.id,
      calibrationDate,
      note: `Imported ${reply.id} and attached it.${calibrationDate === null ? "" : ` Calibration date ${calibrationDate}.`}`
        + (reply.workspace?.clash === true ? " The date differs from the workspace cut-off; the server recorded a warning." : ""),
    };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && /already exists/.test(e.message)) {
      const taken = /market "([^"]+)" already exists/.exec(e.message)?.[1];
      const attached = args.head.blocks.market.snapshot?.id;
      if (taken !== undefined && taken === attached) return { kind: "refused", message: ID_ATTACHED, items: [], more: 0, follow: errText(e), attached: taken };
      return { kind: "refused", message: ID_TAKEN, items: [], more: 0, follow: errText(e) };
    }
    const all = e instanceof ApiError && Array.isArray(e.detail) ? e.detail.map(itemText) : [];
    return { kind: "refused", message: errText(e), items: all.slice(0, MAX_LISTED), more: Math.max(0, all.length - MAX_LISTED) };
  }
}

export function UploadWorkbookView(props: {
  /** The chosen file's name; null before one is chosen. */
  file: string | null;
  asOf: string;
  id: string;
  by: string;
  busy: boolean;
  outcome: UploadOutcome | null;
  /** Changes when the file input must be emptied, after a successful import. */
  inputKey?: number;
  onFile(file: File | null): void;
  onAsOf(v: string): void;
  onId(v: string): void;
  onBy(v: string): void;
  onImport(): void;
}) {
  const { outcome } = props;
  const block = uploadBlock({ file: props.file, by: props.by, busy: props.busy });
  const off = props.busy;
  const stamp = stampSentence(props.file);
  // A bad filename date blocks with the very sentence under the file field, so the button points there and it prints once.
  const reasonId = block === null ? undefined : block === stamp ? STAMP_ID : REASON_ID;
  return (
    <section className="card" aria-label="Import a market workbook">
      <div className="card-title">Import a market workbook into this workspace</div>
      <p className="card-desc">
        The server checks the workbook's calibration date against the workspace cut-off before it stores anything.
      </p>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Market workbook (.xlsx)</span>
          <input key={props.inputKey ?? 0} className="input" type="file" accept=".xlsx" aria-label="Market workbook" disabled={off}
            onChange={(e) => props.onFile(e.target.files?.[0] ?? null)} />
          <span className="field-help">{props.file ?? "A .xlsx market workbook"}</span>
          {stamp !== null ? <span className="field-help" id={STAMP_ID} role="status">{stamp}</span> : null}
        </label>
        <label className="field">
          <span className="field-label">As-of date (only if the filename has no _YYYYMMDD suffix)</span>
          <input className="input" aria-label="As-of date" disabled={off} value={props.asOf} placeholder="YYYY-MM-DD" onChange={(e) => props.onAsOf(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Snapshot id (optional)</span>
          <input className="input" aria-label="Snapshot id" disabled={off} value={props.id} placeholder="Taken from the filename" onChange={(e) => props.onId(e.target.value)} />
          <span className="field-help">A stored snapshot is never overwritten, so an id already in use is refused.</span>
        </label>
        <ByField value={props.by} onChange={props.onBy} disabled={off} />
      </div>
      <div className="sheet-actions">
        {/* Off by aria-disabled, not disabled, so a focused button keeps focus; the click is ignored then. */}
        <button type="button" className="btn btn-primary" aria-disabled={block !== null ? true : undefined} aria-describedby={reasonId}
          onClick={block !== null ? undefined : props.onImport}>Import and attach</button>
        {props.busy ? <span className="muted" role="status">Importing</span> : null}
      </div>
      {reasonId === REASON_ID ? <p className="muted" id={REASON_ID}>{block}</p> : null}
      {outcome?.kind === "ok" ? <p className="card-desc" role="status">{outcome.note}</p> : null}
      {outcome?.kind === "invalid" ? <p className="card-desc" role="alert">{outcome.message}</p> : null}
      {outcome?.kind === "refused" ? (
        <>
          <p className="card-desc" role="alert">{outcome.message}</p>
          {outcome.follow !== undefined ? <p className="card-desc">{outcome.follow}</p> : null}
          {outcome.items.length > 0 ? <ul className="list">{outcome.items.map((t, i) => <li key={i}>{t}</li>)}</ul> : null}
          {outcome.more > 0 ? <p className="muted">{`and ${outcome.more} more`}</p> : null}
        </>
      ) : null}
      <p className="card-foot">Source: POST /api/market/import-workbook with the workspace id, which also sets the market block.</p>
    </section>
  );
}

/**
 * The card with its state and its one call. `onChanged` reads the head and its readiness again after a success.
 * The snapshot the head holds now (null when none) keys the effect below; a change to it can make the import note false.
 */
export function UploadWorkbook(props: { head: WorkspaceManifest; onChanged: () => void }) {
  const [by, setBy] = useBy();
  const [file, setFile] = useState<File | null>(null);
  // Null until the analyst types: the box then shows the workspace cut-off, and follows the workspace if it changes.
  const [typedAsOf, setTypedAsOf] = useState<string | null>(null);
  const asOf = typedAsOf ?? props.head.cutoffDate;
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const inFlight = useRef(false);
  const attachedId = props.head.blocks.market.snapshot?.id ?? null;
  useEffect(() => { setOutcome((o) => outcomeOnAttach(o, attachedId)); }, [attachedId]);

  const onImport = async () => {
    if (file === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const out = await importWorkbook({ head: props.head, file, asOf, id, by, onChanged: props.onChanged });
      setOutcome(out);
      if (out.kind === "ok") {
        setFile(null);
        setTypedAsOf(null);
        setId("");
        setInputKey((k) => k + 1);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <UploadWorkbookView
      file={file?.name ?? null} asOf={asOf} id={id} by={by} busy={busy} outcome={outcome} inputKey={inputKey}
      onFile={(f) => { setFile(f); setOutcome(null); }} onAsOf={setTypedAsOf} onId={setId} onBy={setBy} onImport={() => void onImport()}
    />
  );
}
