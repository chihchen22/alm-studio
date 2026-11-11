// apps/studio/src/pages/results/InstrumentsTab.tsx
/**
 * Instruments tab: the per-position results file of a run, one row per
 * position. Sorted by notional by default, filtered by family and by any dimension, the PV of one chosen scenario beside
 * the base, the constant balance NII and the SEG peak when the run opted in to seg. A position id opens the existing
 * instrument drawer. The grid draws at most INSTRUMENT_ROW_CAP rows (a granular book holds 10,000); the CSV route has them all.
 */
import { instrumentsBeforeParNote } from "@alm/engine/src/report/instrumentsNote";
import { ApiError, getInstruments, instrumentsCsvUrl, NOT_IN_RUN, type InstrumentRow, type InstrumentsFile, type RunDetail } from "@alm/reader";
import { errText } from "../../errText";
import { money, signedMoney } from "../../format/figures";
import { scenarioLabeller } from "../../format/scenarios";
import { screenHref } from "../../pageLinks";
import { baseScenarioId } from "../../results/readouts";
import { useLoad } from "../../useLoad";
import { InstrumentDrawer } from "../balance/InstrumentDrawer";
import { NotInRun, type TabProps } from "./common";

/** How many rows the grid draws. */
export const INSTRUMENT_ROW_CAP = 200;

/**
 * Spec P1: since file schema 1.1.0 a balance held at book (non-rate-sensitive) is valued at par. A file written before
 * reads 0 for it, and the screen says so in one line; the stored file is never rewritten. The line is the engine's,
 * the one Reports and the CSV print too.
 */
export const beforeParNote = instrumentsBeforeParNote;

type SortKey = "notional" | "id" | "wal" | "pv" | "nii";
const SORT_KEYS: readonly SortKey[] = ["notional", "id", "wal", "pv", "nii"];

/** A page address on this screen with some query keys changed; null removes one. */
function hrefWith(ws: string, query: Record<string, string>, patch: Record<string, string | null>): string {
  const q: Record<string, string> = { ...query };
  delete q.tab;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete q[k];
    else q[k] = v;
  }
  return screenHref({ ws, section: "results", screen: "instruments" }, q);
}

/** A dimension value as the filter compares it: a list-valued dimension matches on any of its members. */
function dimensionValues(row: InstrumentRow, key: string): string[] {
  const v = row.dimensions[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function scenarioRow(row: InstrumentRow, scenarioId: string) {
  return row.byScenario.find((s) => s.scenarioId === scenarioId);
}

/** The sort value of a row; null sorts last whatever the direction. */
function sortValue(row: InstrumentRow, key: SortKey, scenarioId: string): number | string | null {
  switch (key) {
    case "notional": return row.notional;
    case "id": return row.positionId;
    case "wal": return row.walMonths ?? null;
    case "pv": return scenarioRow(row, scenarioId)?.pv ?? null;
    case "nii": return row.seg?.niiBase12 ?? null;
  }
}

function sortRows(rows: InstrumentRow[], key: SortKey, dir: "asc" | "desc", scenarioId: string): InstrumentRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key, scenarioId);
    const y = sortValue(b, key, scenarioId);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    return c === 0 ? a.positionId.localeCompare(b.positionId) : sign * c;
  });
}

function Chips(props: { label: string; items: Array<{ text: string; href: string; current: boolean }> }) {
  return (
    <nav className="chip-row" aria-label={props.label}>
      {props.items.map((i) => <a key={i.text} className="pill" href={i.href} aria-current={i.current ? "true" : undefined}>{i.text}</a>)}
    </nav>
  );
}

export function InstrumentsView(props: { ws: string; runId: string; detail: RunDetail; file: InstrumentsFile; query: Record<string, string> }) {
  const { ws, runId, detail, file, query } = props;
  const label = scenarioLabeller(detail);
  const base = baseScenarioId(detail, file.scenarios);
  const picked = query.scenario !== undefined && file.scenarios.includes(query.scenario) ? query.scenario : base;
  const families = uniqueSorted(file.positions.map((p) => p.familyId));
  const family = query.family !== undefined && families.includes(query.family) ? query.family : null;
  const dimKeys = uniqueSorted(file.positions.flatMap((p) => Object.keys(p.dimensions)));
  const dim = query.dim !== undefined && dimKeys.includes(query.dim) ? query.dim : null;
  const dimValues = dim === null ? [] : uniqueSorted(file.positions.flatMap((p) => dimensionValues(p, dim)));
  const val = dim !== null && query.val !== undefined && dimValues.includes(query.val) ? query.val : null;
  const sortKey: SortKey = SORT_KEYS.find((k) => k === query.sort) ?? "notional";
  const dir: "asc" | "desc" = query.dir === "asc" || query.dir === "desc" ? query.dir : sortKey === "id" ? "asc" : "desc";
  const hasSeg = file.positions.some((p) => p.seg !== undefined);
  const showPicked = picked !== null && picked !== base;

  const filtered = file.positions.filter((p) => (family === null || p.familyId === family) && (dim === null || val === null || dimensionValues(p, dim).includes(val)));
  const sorted = sortRows(filtered, sortKey, dir, base ?? "");
  const shown = sorted.slice(0, INSTRUMENT_ROW_CAP);

  const sortLink = (key: SortKey, text: string) => {
    const next = sortKey === key ? (dir === "asc" ? "desc" : "asc") : key === "id" ? "asc" : "desc";
    return <a href={hrefWith(ws, query, { sort: key, dir: next })}>{text}{sortKey === key ? (dir === "asc" ? " ↑" : " ↓") : ""}</a>;
  };

  return (
    <>
      <section className="card" aria-label="Instrument filters">
        <div className="card-title">Instruments, {file.positions.length.toLocaleString("en-US")} positions</div>
        <p className="card-desc">One row per position from the run's per-position results file, on the {file.discountBasis} discount basis, as of {file.asOf}. Sorted by {sortKey === "id" ? "position id" : sortKey}, {dir === "asc" ? "smallest first" : "largest first"}.</p>
        {beforeParNote(file) !== null ? <p className="card-desc" role="note">{beforeParNote(file)}</p> : null}
        <Chips label="Family" items={[{ text: "All families", href: hrefWith(ws, query, { family: null }), current: family === null }, ...families.map((f) => ({ text: f, href: hrefWith(ws, query, { family: f }), current: family === f }))]} />
        {dimKeys.length === 0 ? null : (
          <Chips label="Dimension" items={[{ text: "No dimension", href: hrefWith(ws, query, { dim: null, val: null }), current: dim === null }, ...dimKeys.map((k) => ({ text: k, href: hrefWith(ws, query, { dim: k, val: null }), current: dim === k }))]} />
        )}
        {dim === null ? null : (
          <Chips label="Dimension value" items={[{ text: "All values", href: hrefWith(ws, query, { val: null }), current: val === null }, ...dimValues.map((v) => ({ text: v, href: hrefWith(ws, query, { val: v }), current: val === v }))]} />
        )}
        {file.scenarios.length < 2 ? null : (
          <Chips label="Scenario" items={file.scenarios.map((id) => ({ text: label(id), href: hrefWith(ws, query, { scenario: id }), current: id === picked }))} />
        )}
        <p className="card-foot">
          Showing {shown.length.toLocaleString("en-US")} of {file.positions.length.toLocaleString("en-US")} positions.
          {filtered.length > INSTRUMENT_ROW_CAP ? ` ${filtered.length.toLocaleString("en-US")} match; rows past the first ${INSTRUMENT_ROW_CAP} are not drawn, so filter further or download the CSV.` : ""}{" "}
          <a className="btn btn-quiet" href={instrumentsCsvUrl(runId)} download>Download CSV</a>
        </p>
      </section>
      <section className="card table-card" aria-label="Instruments grid">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{sortLink("id", "Position")}</th><th scope="col">Family</th><th scope="col">Type</th><th scope="col">Side</th>
                <th scope="col" className="num">{sortLink("notional", "Notional")}</th><th scope="col" className="num">{sortLink("wal", "WAL, months")}</th>
                <th scope="col" className="num">First repricing</th>
                <th scope="col" className="num">{sortLink("pv", `PV, ${base ?? "base"}`)}</th>
                {showPicked ? <th scope="col" className="num">PV, {picked}</th> : null}
                {hasSeg ? <>
                  <th scope="col" className="num">{sortLink("nii", "NII 12m, base")}</th><th scope="col" className="num">NII 12m, +200bp vs base</th>
                  <th scope="col" className="num">NII 12m, −200bp vs base</th><th scope="col" className="num">SEG peak</th>
                </> : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const b = base === null ? undefined : scenarioRow(r, base);
                const s = showPicked ? scenarioRow(r, picked) : undefined;
                return (
                  <tr key={r.positionId}>
                    <th scope="row" className="mono">
                      <a href={hrefWith(ws, query, { position: r.positionId })}>{r.positionId}</a>
                      {r.parentPositionId === undefined ? null : <span className="muted"> parent {r.parentPositionId}</span>}
                    </th>
                    <td className="mono">{r.familyId}</td>
                    <td>{r.type}</td>
                    <td>{r.side}</td>
                    <td className="num">{money(r.notional)}</td>
                    <td className="num">{r.walMonths === undefined ? <span className="status status-unobs" title="no principal inside the horizon, so the engine states no weighted average life">none</span> : r.walMonths.toFixed(1)}</td>
                    <td className="num">{r.firstRepricingMonth === null ? <span className="muted" title="never reprices inside the horizon">never</span> : r.firstRepricingMonth}</td>
                    <td className="num">{b === undefined ? <span className="status status-unobs">{NOT_IN_RUN}</span> : money(b.pv)}</td>
                    {showPicked ? <td className="num">{s === undefined ? <span className="status status-unobs">{NOT_IN_RUN}</span> : money(s.pv)}</td> : null}
                    {hasSeg ? (r.seg === undefined ? <td className="num muted" colSpan={4}>n/a</td> : <>
                      <td className="num">{money(r.seg.niiBase12)}</td>
                      <td className="num">{signedMoney(r.seg.niiUp12 - r.seg.niiBase12)}</td>
                      <td className="num">{signedMoney(r.seg.niiDown12 - r.seg.niiBase12)}</td>
                      <td className="num">{signedMoney(r.seg.segPeak)}</td>
                    </>) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="card-foot">
          Source: /api/runs/{runId}/instruments.
          {hasSeg ? " NII 12m and SEG peak are the constant balance figures of the seg block, by position; the two shocked columns are the stored shocked level less the stored base level." : ""}
        </p>
      </section>
      {query.position === undefined || detail.refs === undefined ? null : (
        <InstrumentDrawer bookId={detail.refs.portfolioId} positionId={query.position} marketId={detail.refs.marketId} closeHref={hrefWith(ws, query, { position: null })} />
      )}
    </>
  );
}

/**
 * The file could not be read. The route answers 404 for a run that was not submitted with instrumentResults.save (or whose
 * pass failed), and that is "not in this run"; anything else is an error line. The tab cannot read the answer off the run
 * envelope: the server writes instruments.json after result.json and leaves the envelope byte-identical, so
 * RunResult.instrumentsFile is never set on a stored run.
 */
export function InstrumentsLoadFailure(props: { error: unknown }) {
  if (props.error instanceof ApiError && props.error.status === 404) {
    return <NotInRun title="Instruments" reason="This run did not save per-position results. Turn on Store instrument results in the run setup's measures." />;
  }
  return <div className="card" role="alert">{errText(props.error)}</div>;
}

function InstrumentsLoaded(props: { p: TabProps }) {
  const { p } = props;
  const load = useLoad(() => getInstruments(p.runId), [p.runId]);
  if (load.state === "loading") return <div className="card muted">Reading the per-position results for {p.runId}</div>;
  if (load.state === "error") return <InstrumentsLoadFailure error={load.error} />;
  return <InstrumentsView ws={p.ws} runId={p.runId} detail={p.detail} file={load.value} query={p.query} />;
}

export function InstrumentsTab(p: TabProps) {
  return <InstrumentsLoaded p={p} />;
}
