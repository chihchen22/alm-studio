// apps/studio/src/pages/balance/ImportPositions.tsx
/**
 * Balance Sheet > Positions and import: the import form. One primary action, "Import positions (CSV or JSON)". The
 * file is stored by the import route (POST /api/portfolios/import), then the positions block names it
 * (POST /api/workspaces/:id/blocks); the server applies the cut-off clash rule on that second write. The as-of date
 * is the workspace's cut-off: read-only on a Production workspace, editable elsewhere (spec v3.1 Section 3.6 step 4).
 */
import { useRef, useState } from "react";
import { importPortfolioCsv, importPortfolioJson, listCoa, listPortfolios, setBlock, type WorkspaceManifest } from "@alm/reader";
import { freeBookId, jsonIdOf, jsonWithId, renamedNote } from "../../guided/importBook";
import { ByField, useBy } from "../../controls/ByName";
import { useLoad } from "../../useLoad";
import {
  coaChoice, formatOfFile, importBlock, importFormModel, importNote, importSetBody, refusalNote,
  type CoaOption, type ImportFormModel, type ImportNote,
} from "../../balance/importModel";

export type ImportField = "portfolioId" | "label" | "coaId" | "asOf";

const REASON_ID = "import-positions-reason";
const optionText = (c: CoaOption): string => (c.label !== "" && c.label !== c.id ? `${c.id}: ${c.label}` : c.id);

export function ImportPositionsView(props: {
  model: ImportFormModel;
  by: string;
  /** The name a write records when none is typed (the guided path's); absent asks for one. */
  byFallback?: string;
  /** The chosen file's name; null before one is chosen. */
  file: string | null;
  busy: boolean;
  note: ImportNote | null;
  /** The stored charts of accounts; "loading" while they are read, empty when there are none or they could not be read. */
  coas: CoaOption[] | "loading";
  /** Whether the section is open: it is on an empty workspace, folded away once a book is set. */
  open: boolean;
  /** Typed values override the model's proposals; absent means the proposal shows. */
  values?: Partial<Record<ImportField, string>>;
  onBy(v: string): void;
  onFile(file: File): void;
  onField(name: ImportField, value: string): void;
  onImport(): void;
}) {
  const { model, values = {} } = props;
  const isJson = props.file !== null && formatOfFile(props.file) === "json";
  const off = props.busy;
  const block = importBlock({ file: props.file, by: props.by.trim() === "" ? props.byFallback ?? "" : props.by, busy: props.busy, coasLoading: props.coas === "loading" });
  const ready = block === null && !off;
  const { note, coas } = props;
  const coaId = coaChoice(values.coaId, model.coaId, coas === "loading" ? [] : coas);
  return (
    <details className="card" open={props.open} aria-label="Import positions">
      <summary className="card-title">Import positions (CSV or JSON)</summary>
      <p className="card-desc">
        The file becomes this workspace's one position book. The as-of date is the workspace cut-off{model.asOfReadOnly ? ", fixed on a Production workspace" : ""}.
        A JSON file carries its own id, label and as-of date; a CSV file takes them from this form.
      </p>
      <div className="param-grid">
        <label className="field">
          <span className="field-label">File</span>
          <input className="input" type="file" accept=".csv,.json,text/csv,application/json" aria-label="Positions file" disabled={off}
            onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) props.onFile(f); }} />
          <span className="field-help">{props.file ?? "A CSV or JSON file of positions"}</span>
        </label>
        {isJson ? null : (
          <>
            <label className="field">
              <span className="field-label">Book id</span>
              <input className="input" aria-label="Book id" disabled={off} value={values.portfolioId ?? model.portfolioId} onChange={(e) => props.onField("portfolioId", e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Label</span>
              <input className="input" aria-label="Label" disabled={off} value={values.label ?? ""} onChange={(e) => props.onField("label", e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Chart of accounts id</span>
              {coas === "loading" ? (
                <select className="input" aria-label="Chart of accounts id" disabled value="">
                  <option value="">Reading the stored charts</option>
                </select>
              ) : coas.length > 0 ? (
                <select className="input" aria-label="Chart of accounts id" disabled={off} value={coaId} onChange={(e) => props.onField("coaId", e.target.value)}>
                  {coas.map((c) => <option key={c.id} value={c.id}>{optionText(c)}</option>)}
                </select>
              ) : (
                <>
                  <input className="input" aria-label="Chart of accounts id" disabled={off} value={coaId} onChange={(e) => props.onField("coaId", e.target.value)} />
                  <span className="field-help">Type the chart of accounts id.</span>
                </>
              )}
            </label>
            <label className="field">
              <span className="field-label">As-of date</span>
              <input className="input" aria-label="As-of date" readOnly={model.asOfReadOnly} disabled={off} value={model.asOfReadOnly ? model.asOf : values.asOf ?? model.asOf}
                onChange={(e) => props.onField("asOf", e.target.value)} />
              <span className="field-help">{model.asOfReadOnly ? "The cut-off date of this Production workspace" : "Preset to the cut-off date"}</span>
            </label>
          </>
        )}
        <ByField value={props.by} onChange={props.onBy} disabled={off} />
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn btn-primary" aria-disabled={!ready ? true : undefined} aria-describedby={block !== null ? REASON_ID : undefined}
          onClick={ready ? props.onImport : undefined}>Import positions</button>
        {props.busy ? <span className="muted" role="status">Importing</span> : null}
        {block !== null ? <span className="muted" id={REASON_ID}>{block}</span> : null}
        {note !== null ? <span role="status">{note.text}</span> : null}
      </div>
      {note !== null && note.items.length > 0 ? <ul className="list">{note.items.map((t, i) => <li key={i}>{t}</li>)}</ul> : null}
      {note !== null && note.more > 0 ? <p className="muted">{`and ${note.more} more`}</p> : null}
    </details>
  );
}

/** The import's lines about the file's tag columns (blank cells grouped as Unassigned, a blank column). */
export function tagWarnings(warnings: readonly string[] | undefined): string[] {
  return (warnings ?? []).filter((w) => / grouped as Unassigned\.$/.test(w) || / is not read as a tag\.$/.test(w));
}

/** The form with its state and its two calls. `onImported` rereads the head after the block write. */
export function ImportPositions(props: { head: WorkspaceManifest; open: boolean; onImported(): void; fallbackBy?: string }) {
  const { head } = props;
  const model = importFormModel(head);
  const [by, setBy] = useBy();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [values, setValues] = useState<Partial<Record<ImportField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ImportNote | null>(null);
  const load = useLoad(() => listCoa(), [head.id]);
  // A chart list that cannot be read is an empty one: the form falls back to typing the id.
  const coas: CoaOption[] | "loading" = load.state === "loading" ? "loading" : load.state === "ok" ? load.value.map((c) => ({ id: c.id, label: c.label })) : [];
  const inFlight = useRef(false);

  const onFile = (f: File) => {
    setNote(null);
    void f.text().then(
      (text) => setFile({ name: f.name, text }),
      (e: unknown) => setNote(refusalNote(e)),
    );
  };

  const onImport = async () => {
    if (file === null || inFlight.current || coas === "loading") return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try {
      let bookId: string;
      let renamed: string | null = null;
      let tagLines: string[] = [];
      // An id the store already holds is stored under the first free one, never refused (S2a fix round 1, H1).
      const taken = (await listPortfolios()).map((p) => p.id);
      if (formatOfFile(file.name) === "json") {
        const asked = jsonIdOf(file.text);
        const id = asked === null ? null : freeBookId(asked, taken);
        bookId = (await importPortfolioJson(asked === null || id === asked ? file.text : jsonWithId(file.text, id!))).id;
        if (asked !== null) renamed = renamedNote(asked, bookId);
      } else {
        const coaId = coaChoice(values.coaId, model.coaId, coas);
        const asked = values.portfolioId ?? model.portfolioId;
        const portfolioId = freeBookId(asked, taken);
        const reply = await importPortfolioCsv(file.text, coaId, values.label ?? portfolioId, portfolioId, model.asOfReadOnly ? model.asOf : values.asOf ?? model.asOf);
        bookId = reply.id;
        renamed = renamedNote(asked, bookId);
        tagLines = tagWarnings(reply.warnings);
      }
      const writer = by.trim() === "" ? props.fallbackBy ?? "" : by.trim();
      await setBlock(head.id, importSetBody(head, bookId, writer));
      setNote({ ...importNote(`Imported ${bookId} into ${head.id}${renamed === null ? "" : `. ${renamed}`}`), items: tagLines });
      setFile(null);
      props.onImported();
    } catch (e) {
      setNote(refusalNote(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <ImportPositionsView
      model={model} by={by} {...(props.fallbackBy === undefined ? {} : { byFallback: props.fallbackBy })} file={file?.name ?? null} busy={busy} note={note} coas={coas} open={props.open || note !== null} values={values}
      onBy={setBy} onFile={onFile} onField={(name, value) => setValues((v) => ({ ...v, [name]: value }))} onImport={() => void onImport()}
    />
  );
}
