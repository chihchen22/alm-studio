// apps/studio/src/pages/compare/CompareViews.tsx
/**
 * Compare page views (Studio S3b): the run and table pickers, the aligned
 * table and the two runs' provenance. Every cell is the reply's own value as
 * text; the only derived column is the reply's delta, labeled "(derived)".
 */
import type { CompareCell, CompareProvenance, CompareReply, ExportTable, RunMode, RunSummary } from "@alm/reader";
import { COMPARE_TABLES, cellText, compareHref, deltaText, headerCells, modeIn, runOptions, tableLabelOf } from "../../compare/compareModel";

/**
 * What the pickers offer inside a workspace: the runs it attaches (`ids`) and each one's result-picker row text
 * (`rowText`). Only the options are scoped; a run's mode, and so the route a pair reads, comes from all of /api/runs.
 */
export interface PickerScope {
  ids: string[];
  rowTexts: Record<string, string>;
}

/** The width cap of a run select in characters; styles/app.css `.plan-toolbar select { max-width: 36ch }` is the same number. */
const RUN_SELECT_CAP_CH = 36;

/** Without a scope every done run of /api/runs is offered, each as its id and label. */
function RunSelect(props: { label: string; value: string | null; runs: RunSummary[]; other: RunMode | null; scope?: PickerScope; onPick(runId: string | null): void }) {
  const { scope } = props;
  const offered = scope === undefined ? props.runs : props.runs.filter((r) => scope.ids.includes(r.runId));
  const options = runOptions(offered, props.other);
  const listed = props.value === null || options.some((o) => o.runId === props.value);
  const unlisted = scope === undefined ? "not a done run in /api/runs" : "not a done run of this workspace";
  // The select clips a label past its width cap; the title then carries the chosen option's whole text. A label that
  // fits carries none, so the markup of a short comparison is what it was.
  const chosen = options.find((o) => o.runId === props.value);
  const full = props.value === null ? undefined
    : chosen === undefined ? `${props.value}, ${unlisted}`
    : chosen.disabled === null ? (scope?.rowTexts[chosen.runId] ?? chosen.text) : `${scope?.rowTexts[chosen.runId] ?? chosen.text}, ${chosen.disabled}`;
  const title = full !== undefined && full.length > RUN_SELECT_CAP_CH ? full : undefined;
  return (
    <label>
      {props.label}{" "}
      <select value={props.value ?? ""} title={title} onChange={(e) => props.onPick(e.target.value === "" ? null : e.target.value)}>
        <option value="">Pick a run</option>
        {listed ? null : <option value={props.value!} disabled>{props.value}, {unlisted}</option>}
        {options.map((o) => {
          const text = scope?.rowTexts[o.runId] ?? o.text;
          return (
            <option key={o.runId} value={o.runId} disabled={o.disabled !== null} title={o.disabled ?? undefined}>
              {o.disabled === null ? text : `${text}, ${o.disabled}`}
            </option>
          );
        })}
      </select>
    </label>
  );
}

/**
 * Run A, run B and the table; each change rewrites the hash, so a comparison is a link. A run whose mode differs
 * from the other chosen run's is disabled; once either side is stochastic the Table select gives way to the
 * line that says what the pair reads.
 */
export function RunPickers(props: { ws: string; runs: RunSummary[]; a: string | null; b: string | null; table: ExportTable; query: Record<string, string>; scope?: PickerScope; scopeNote?: string | null }) {
  const go = (a: string | null, b: string | null, table: ExportTable) => { window.location.hash = compareHref(props.ws, props.query, a, b, table); };
  const tableLabel = tableLabelOf(props.runs, props.a, props.b);
  return (
    <>
    <div className="plan-toolbar">
      <RunSelect label="Run A" value={props.a} runs={props.runs} other={modeIn(props.runs, props.b)} scope={props.scope} onPick={(id) => go(id, props.b, props.table)} />
      <RunSelect label="Run B" value={props.b} runs={props.runs} other={modeIn(props.runs, props.a)} scope={props.scope} onPick={(id) => go(props.a, id, props.table)} />
      {tableLabel !== null ? <span className="muted">{tableLabel}</span> : (
        <label>
          Table{" "}
          <select value={props.table} onChange={(e) => go(props.a, props.b, e.target.value as ExportTable)}>
            {COMPARE_TABLES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      )}
    </div>
    {props.scopeNote === undefined || props.scopeNote === null ? null : <p className="field-help" role="status">{props.scopeNote}</p>}
    </>
  );
}

/** A number carries its full-precision JSON value as the cell's title. */
const titleOf = (v: CompareCell | undefined): string | undefined => (typeof v === "number" ? String(v) : undefined);

/** The aligned table: keys, then A and B per value column and, for a num column, the reply's B - A. */
export function CompareTable(props: { reply: CompareReply }) {
  const { reply } = props;
  const keys = reply.columns.filter((c) => c.role === "key");
  const values = reply.columns.filter((c) => c.role !== "key");
  const heads = headerCells(reply);
  const numHead = new Set(values.filter((c) => c.role === "num").flatMap((c) => [`${c.name} A`, `${c.name} B`, `${c.name} B - A (derived)`]));
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{heads.map((h) => <th scope="col" key={h} className={numHead.has(h) ? "num" : undefined}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {reply.rows.map((row, i) => {
            const cls = (role: string) => (role === "num" ? "num" : undefined);
            return (
              <tr key={i}>
                {/* The first key names the row (Row header scope 2); the other keys stay cells. */}
                {keys.map((c, k) => k === 0
                  ? <th scope="row" key={c.name} className="mono">{cellText(row.key[c.name], "A", true)}</th>
                  : <td key={c.name} className="mono">{cellText(row.key[c.name], "A", true)}</td>)}
                {values.flatMap((c) => {
                  const va = row.a?.[c.name];
                  const vb = row.b?.[c.name];
                  const cells = [
                    <td key={`${c.name}-a`} className={cls(c.role)} title={titleOf(va)}>{cellText(va, "A", row.a !== null)}</td>,
                    <td key={`${c.name}-b`} className={cls(c.role)} title={titleOf(vb)}>{cellText(vb, "B", row.b !== null)}</td>,
                  ];
                  if (c.role === "num") {
                    const d = row.delta[c.name] ?? null;
                    cells.push(<td key={`${c.name}-d`} className="num" title={titleOf(d)}>{deltaText(d)}</td>);
                  }
                  return cells;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProvRows(props: { side: "A" | "B"; prov: CompareProvenance }) {
  return (
    <>
      <dt>Run {props.side}</dt><dd className="mono">{props.prov.runId}</dd>
      <dt>Inputs hash {props.side}</dt><dd className="mono">{props.prov.inputsHash}</dd>
      {props.prov.curve !== undefined ? <><dt>Curve {props.side}</dt><dd>{props.prov.curve}</dd></> : null}
      <dt>Schema {props.side}</dt><dd className="mono">{props.prov.schemaVersion}</dd>
      <dt>Engine {props.side}</dt><dd className="mono">{props.prov.engineVersion}</dd>
    </>
  );
}

/** Both runs' provenance and the reply's note, verbatim. */
export function ProvenanceCard(props: { reply: CompareReply }) {
  const { provenance, note } = props.reply;
  return (
    <section className="card" aria-label="Provenance">
      <div className="card-title">Provenance</div>
      <dl className="kv">
        <ProvRows side="A" prov={provenance.a} />
        <ProvRows side="B" prov={provenance.b} />
        <dt>Note</dt><dd>{note}</dd>
      </dl>
    </section>
  );
}
