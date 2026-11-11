/**
 * Balance Sheet. Every figure is a value a route returned, formatted by
 * @alm/reader, with a source line naming the route and field. The treemap
 * places the grouped aggregate's totalNotional; the runoff draws one line per
 * family from the base scenario's balance series, verbatim; the table is one
 * served page of positions. Nothing is summed or derived here.
 */
import type { FormEvent } from "react";
import { formatValue, pct, usd, usdMM, type CatalogGroupBy, type CatalogPositionsPage } from "@alm/reader";
import type { LoadState } from "../../useLoad";
import { pageErrText } from "../../errText";
import { LinePlot, type PlotSeries } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import { moneyTick } from "../../format/figures";
import { Treemap } from "../../charts/TreemapChart";
import { screenHref } from "../../pageLinks";
import { aggregateRoute, PAGE_SIZE, positionsRoute, type BalanceModel } from "./loadBalance";

export const GROUP_LABEL: Record<CatalogGroupBy, string> = { family: "family", instrumentType: "instrument type", coaNode: "COA node", side: "side" };
const GROUP_ORDER: CatalogGroupBy[] = ["family", "instrumentType", "coaNode", "side"];

/** The Positions href with some page keys set or removed; the workspace names the book and the as-of. */
export function balanceHref(ws: string, query: Record<string, string>, patch: Record<string, string | null>): string {
  const next = { ...query };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return screenHref({ ws, section: "balance", screen: "positions" }, next);
}

function Unobs(props: { text: string }) {
  return <span className="status status-unobs">{props.text}</span>;
}

function RunoffCard(props: { model: BalanceModel }) {
  const { runoff, bookId } = props.model;
  const title = <div className="card-title">Runoff by family, balance at start of bucket</div>;
  if (runoff === null) {
    return (
      <section className="card unobs-panel" aria-label="Runoff by family">
        {title}
        <Unobs text="Unobservable" />
        <p className="unobs-text">Unobservable: no run stored for this book, so there are no projected balances to draw.</p>
        <p className="card-foot">Source: /api/catalog/lineage/portfolios/{encodeURIComponent(bookId)} consumedBy, no entry in state done</p>
      </section>
    );
  }
  const { runId, scenarioId, asOf, horizonMonths, byFamily } = runoff;
  const source = <>Source: cashflows.byScenario[{scenarioId}].byFamily[].series.balance, run <span className="run">{runId}</span></>;
  if (byFamily.length === 0) {
    return (
      <section className="card unobs-panel" aria-label="Runoff by family">
        {title}
        <Unobs text="Unobservable" />
        <p className="unobs-text">Unobservable: the cashflows section has no family series for base scenario {scenarioId}.</p>
        <p className="card-foot">{source}</p>
      </section>
    );
  }
  const sideText = (s: "asset" | "liability" | undefined) => s ?? "side not asset or liability";
  return (
    <figure className="card viz">
      <div className="viz-head">
        {title}
        <p className="viz-sub">Base {scenarioId}, as of {asOf}, {horizonMonths} monthly buckets. Assets in the accent line, liabilities in grey; one line per family, none summed.</p>
      </div>
      {/* Bucket k (0-based) is month k + 1 on a linear month axis; the y axis runs from 0 (Polish 13). */}
      <LinePlot
        series={byFamily.map((f): PlotSeries => ({
          id: f.familyId,
          label: `${f.familyId} (${sideText(f.side)})`,
          points: f.balance.map((v, k): Point => [k + 1, v]),
          tone: f.side === "asset" ? "accent" : "muted",
        }))}
        xScale="linear"
        xTicks={monthTicks}
        xLabel={(m) => `Month ${m}`}
        yTick={moneyTick}
        yZero
        zoom
        unit="USD, axis from 0"
        format={usdMM}
      />
      <figcaption>{source}</figcaption>
    </figure>
  );
}

/** The positions table body and pager for one served page, or its loading or error state. */
function PositionsBody(props: { ws: string; positions: LoadState<CatalogPositionsPage>; query: Record<string, string> }) {
  const { ws, positions, query } = props;
  if (positions.state === "loading") return <p className="table-foot">Reading positions</p>;
  if (positions.state === "error") {
    const e = positions.error;
    return <p className="table-foot" role="alert">{pageErrText(e)}</p>;
  }
  const page = positions.value;
  const { offset, total, returned } = page.page;
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Position</th><th scope="col">Family</th><th scope="col">COA node</th><th scope="col">Side</th><th scope="col">Instrument</th>
              <th scope="col" className="num">Notional</th><th scope="col" className="num">Rate</th><th scope="col" className="num">Maturity, months</th><th scope="col">Behavioral</th>
            </tr>
          </thead>
          <tbody>
            {page.positions.map((p) => {
              const href = balanceHref(ws, query, { position: p.positionId });
              return (
                <tr key={p.positionId} className={`row-link${query.position === p.positionId ? " is-selected" : ""}`} onClick={() => { window.location.hash = href; }}>
                  <th scope="row" className="mono"><a href={href}>{p.positionId}</a></th>
                  <td className="mono">{p.familyId}</td>
                  <td className="mono">{p.coaNodeId}</td>
                  <td>{p.side ?? "Unobservable"}</td>
                  <td className="mono">{p.instrumentType}</td>
                  <td className="num lvl">{usd(p.notional)}</td>
                  <td className="num" title={p.rate === null ? `rateKind ${p.rateKind}: model-implied` : undefined}>{p.rate === null ? "model-implied" : pct(p.rate)}</td>
                  <td className="num">{formatValue("count", p.maturityMonths)}</td>
                  <td className="mono">{p.behavioral ?? "none"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-foot table-pager">
        <span className="num">
          offset {formatValue("count", offset)}, returned {formatValue("count", returned)}, total {formatValue("count", total)}
        </span>
        <span className="pager">
          {offset > 0 ? <a className="btn btn-quiet" href={balanceHref(ws, query, { offset: String(Math.max(0, offset - PAGE_SIZE)) })}>Prev</a> : <button className="btn btn-quiet" type="button" disabled>Prev</button>}
          {offset + returned < total ? <a className="btn btn-quiet" href={balanceHref(ws, query, { offset: String(offset + PAGE_SIZE) })}>Next</a> : <button className="btn btn-quiet" type="button" disabled>Next</button>}
        </span>
      </div>
      <p className="card-foot">
        Rate model-implied: the rateKind is beta-s-curve or cohort-book, so the catalog stores no rate. Source: {positionsRoute(page.portfolioId, page.filters, offset)}
      </p>
    </>
  );
}

export function BalanceView(props: { ws: string; model: BalanceModel; positions: LoadState<CatalogPositionsPage>; query: Record<string, string> }) {
  const { ws, model, positions, query } = props;
  const { bookId, groupBy, basis, groups, familyGroups, filters } = model;
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const aggRoute = aggregateRoute(bookId, filters, groupBy);
  const hasFilter = filters.familyId !== undefined || filters.coaNodeId !== undefined || filters.instrumentType !== undefined;

  const onFilter = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const val = (k: string) => { const v = String(data.get(k) ?? "").trim(); return v === "" ? null : v; };
    window.location.hash = balanceHref(ws, query, { coaNodeId: val("coaNodeId"), instrumentType: val("instrumentType"), offset: null });
  };

  return (
    <>
      <figure className="card viz">
        <div className="viz-head">
          <div className="card-title">Book by {GROUP_LABEL[groupBy]}</div>
          <nav className="chip-row" aria-label="Group by">
            {GROUP_ORDER.map((g) => (
              <a key={g} className="pill" href={balanceHref(ws, query, { groupBy: g })} aria-current={g === groupBy ? "true" : undefined}>{GROUP_LABEL[g]}</a>
            ))}
          </nav>
        </div>
        {groups.length === 0 ? (
          <p className="unobs-text"><Unobs text="Unobservable" /> No positions match these filters, so there is nothing to draw.</p>
        ) : (
          <Treemap
            items={groups.map((g) => ({ key: g.key, value: g.totalNotional ?? 0 }))}
            labelOf={(k) => k}
            valueOf={(k) => { const t = byKey.get(k)?.totalNotional; return t == null ? "Unobservable" : usdMM(t); }}
            width={1000}
            height={240}
          />
        )}
        <details className="viz-table">
          <summary>Show table</summary>
          <table className="table">
            <thead><tr><th scope="col">{GROUP_LABEL[groupBy]}</th><th scope="col" className="num">Positions</th><th scope="col" className="num">Total notional</th><th scope="col" className="num">Weighted avg rate</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <th scope="row" className="mono">{g.key}</th>
                  <td className="num">{formatValue("count", g.positionCount)}</td>
                  <td className="num lvl" title={g.totalNotional == null ? undefined : usd(g.totalNotional)}>{g.totalNotional == null ? "Unobservable" : usdMM(g.totalNotional)}</td>
                  <td className="num">{g.weightedAvgRate == null ? <Unobs text="Unobservable" /> : pct(g.weightedAvgRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <figcaption>Source: {aggRoute}, basis: {basis}</figcaption>
      </figure>

      <RunoffCard model={model} />

      <section className="card table-card" aria-labelledby="positions-title">
        <div className="table-head">
          <div className="card-title" id="positions-title">Positions</div>
          {groupBy === "family" && (
            <nav className="chip-row" aria-label="Family filter">
              <a className="pill" href={balanceHref(ws, query, { familyId: null, offset: null })} aria-current={filters.familyId === undefined ? "true" : undefined}>All families</a>
              {familyGroups.filter((g) => g.key !== "(none)").map((g) => (
                <a key={g.key} className="pill" href={balanceHref(ws, query, { familyId: g.key, offset: null })} aria-current={filters.familyId === g.key ? "true" : undefined}>{g.key}</a>
              ))}
            </nav>
          )}
          <form className="filter-row" onSubmit={onFilter} aria-label="Filter positions">
            <label className="field"><span className="field-label">COA node</span><input className="input" name="coaNodeId" defaultValue={filters.coaNodeId ?? ""} /></label>
            <label className="field"><span className="field-label">Instrument type</span><input className="input" name="instrumentType" defaultValue={filters.instrumentType ?? ""} /></label>
            <button className="btn" type="submit">Apply filters</button>
            {hasFilter && <a className="btn btn-quiet" href={balanceHref(ws, query, { familyId: null, coaNodeId: null, instrumentType: null, offset: null })}>Clear filters</a>}
          </form>
        </div>
        <PositionsBody ws={ws} positions={positions} query={query} />
      </section>
    </>
  );
}
