// apps/studio/src/pages/results/ViewsTab.tsx
/**
 * Views tab (Studio S3a), as the viewer's ViewsPanel does it: pick a view, a
 * metric and a scenario; the rows are GET /api/runs/:id/pivot verbatim; open
 * a row to read each cell's stored numbers off the envelope's byCell arms
 * (cellDetail). Nothing here sums or falls back to a family number. A refused
 * pivot prints the server's message, which carries the engine's reason; every
 * blank cell carries its reason as a title.
 */
import { useState } from "react";
import type { PivotMetric, PivotResult, RunResult, ViewResult } from "@alm/engine";
import {
  cellDetail, cellDetailValues, EVE_PV_CAVEAT, getPivot, PIVOT_METRICS, pivotHeaders, pivotRowValues, pivotTotalValues, usdMM,
} from "@alm/reader";
import { errText } from "../../errText";

import { useLoad, type LoadState } from "../../useLoad";
import { blockOf, NotInRun, ScenarioPicker, selectedScenario, tabHref, type TabProps } from "./common";
import { DynamicViewsNote } from "./ViewsDynamicNote";

export interface ViewPick {
  views: ViewResult[];
  viewId: string | null;
  metric: PivotMetric;
  scenarioId: string | null;
}

export function viewPick(result: RunResult, query: Record<string, string>): ViewPick {
  const views = blockOf(result, "views") ?? [];
  const viewId = views.some((v) => v.viewId === query.view) ? query.view! : views[0]?.viewId ?? null;
  const metric = (PIVOT_METRICS as readonly string[]).includes(query.metric ?? "") ? (query.metric as PivotMetric) : "balance";
  const ids = (blockOf(result, "nii")?.byScenario ?? []).map((s) => s.scenarioId);
  return { views, viewId, metric, scenarioId: selectedScenario(ids, query) };
}

const TOTAL_COUNTS_BLANK = "The served total carries no position or cell count";
const NII_TOTAL_BLANK = "The route's nii total is the net12 sum only; it serves no total for this column";
const TOTAL_VALUE_BLANK = "The served total carries no value for this column";
const CELL_COUNT_BLANK = "A cell row is one cell";
const NO_CELL_REF = "The envelope's cell dictionary (cashflows.cells) does not list this cell id, so its position count is not stored";
const NO_CELL_NUMBERS = "the envelope in hand carries no byCell entry for this cell, although the served pivot rolled it up";

export function PivotTable(props: { pivot: PivotResult; result: RunResult; initialOpen?: ReadonlySet<number> }) {
  const { pivot, result } = props;
  const [open, setOpen] = useState<ReadonlySet<number>>(props.initialOpen ?? new Set());
  const toggle = (i: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  const headers = pivotHeaders(pivot);
  const total = pivotTotalValues(pivot);
  const width = pivot.groupBy.length + 2 + headers.length;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {pivot.groupBy.map((d) => <th scope="col" key={d}>{d}</th>)}
            <th scope="col" className="num">Positions</th><th scope="col" className="num">Cells</th>
            {headers.map((h) => <th scope="col" key={h} className="num" title={pivot.metric === "evePv" ? EVE_PV_CAVEAT : undefined}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {pivot.rows.map((row, i) => (
            <PivotRowView key={i} index={i} row={row} pivot={pivot} result={result} open={open.has(i)} toggle={toggle} width={width} />
          ))}
          {total !== undefined ? (
            <tr>
              <td colSpan={pivot.groupBy.length}><strong>Total (served)</strong></td>
              <td title={TOTAL_COUNTS_BLANK} /><td title={TOTAL_COUNTS_BLANK} />
              {total.map((v, k) => <td key={k} className="num">{usdMM(v)}</td>)}
              {headers.slice(total.length).map((h) => <td key={h} title={pivot.metric === "nii" ? NII_TOTAL_BLANK : TOTAL_VALUE_BLANK} />)}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function PivotRowView(props: { index: number; row: PivotResult["rows"][number]; pivot: PivotResult; result: RunResult; open: boolean; toggle(i: number): void; width: number }) {
  const { row, pivot } = props;
  return (
    <>
      <tr>
        {pivot.groupBy.map((d, k) => (
          <td key={d}>
            {k === 0 ? (
              <button type="button" className="btn btn-quiet btn-flush" aria-expanded={props.open} onClick={() => props.toggle(props.index)}>
                {props.open ? "▾" : "▸"} {row.key[d]}
              </button>
            ) : row.key[d]}
          </td>
        ))}
        <td className="num">{row.positionCount}</td>
        <td className="num">{row.cellIds.length}</td>
        {pivotRowValues(pivot, row).map((v, k) => <td key={k} className="num">{usdMM(v)}</td>)}
      </tr>
      {props.open ? row.cellIds.map((cellId) => <CellRowView key={cellId} cellId={cellId} pivot={pivot} result={props.result} width={props.width} />) : null}
    </>
  );
}

function CellRowView(props: { cellId: string; pivot: PivotResult; result: RunResult; width: number }) {
  const { cellId, pivot } = props;
  const detail = cellDetail(props.result, pivot.metric, pivot.scenarioId, cellId);
  const nums = cellDetailValues(detail);
  const ref = detail.ref;
  const tags = ref === undefined ? "" : Object.keys(ref.tags).sort().map((k) => `${k}=${ref.tags[k]}`).join(" ");
  return (
    <tr className="cell-row">
      <td colSpan={pivot.groupBy.length}><span className="mono muted">{ref?.familyId ?? cellId}</span> {tags}</td>
      <td className="num">{ref === undefined ? <span className="status status-unobs" title={NO_CELL_REF}>Unobservable</span> : ref.positionCount}</td>
      <td title={CELL_COUNT_BLANK} />
      {nums === undefined ? (
        <td colSpan={Math.max(1, props.width - pivot.groupBy.length - 2)}>
          <span className="status status-unobs" title={NO_CELL_NUMBERS}>Unobservable</span> no stored cell numbers for this metric on this scenario: {NO_CELL_NUMBERS}
        </td>
      ) : nums.map((v, k) => <td key={k} className="num">{usdMM(v)}</td>)}
    </tr>
  );
}

/** The stored fields this tab does not paint for a metric, named so none is silently hidden. */
function unpainted(metric: PivotMetric): string | null {
  switch (metric) {
    case "repricing":
    case "gapPrincipal":
      return "Not painted: each band's stored startMonth and endMonth (the header is the band label), and an open cell's stored assets, liabilities and cumulativeGap (its value is the band gap).";
    case "nii":
      return "Not painted: an open cell's stored interestIncome24, interestExpense24, byHorizon and netMonthly.";
    default:
      return null;
  }
}

/** The pivot card for a given load state, so each branch renders without a fetch. */
export function ViewsBody(props: { load: LoadState<PivotResult>; result: RunResult; runId: string; viewId: string; metric: PivotMetric; scenarioId: string }) {
  const { load } = props;
  const rest = unpainted(props.metric);
  return (
    <section className="card table-card" aria-label="Pivot">
      {props.metric === "evePv" ? <p className="card-desc">{EVE_PV_CAVEAT}</p> : null}
      {load.state === "loading" ? <p className="card-desc">Reading the pivot</p> : null}
      {load.state === "error" ? (
        <div className="unobs-panel" role="alert"><span className="status status-unobs">No pivot</span><p className="unobs-text">{errText(load.error)}</p></div>
      ) : null}
      {load.state === "ok" && load.value.rows.length === 0 ? (
        <div className="unobs-panel">
          <span className="status status-unobs">No rows</span>
          <p className="unobs-text">The served pivot has no rows: the view has no groups for this metric and scenario.</p>
        </div>
      ) : null}
      {load.state === "ok" && load.value.rows.length > 0 ? (
        <PivotTable key={`${props.viewId}:${props.metric}:${props.scenarioId}`} pivot={load.value} result={props.result} />
      ) : null}
      <p className="card-foot">
        Source: /api/runs/{props.runId}/pivot?view={props.viewId}&amp;metric={props.metric}&amp;scenarioId={props.scenarioId}; an open row reads each cell&apos;s stored byCell arm.{rest === null ? null : ` ${rest}`}
      </p>
    </section>
  );
}

export function ViewsTab(p: TabProps) {
  const pick = viewPick(p.result, p.query);
  const { viewId, metric, scenarioId } = pick;
  const load = useLoad<PivotResult>(
    () => (viewId === null || scenarioId === null
      ? Promise.reject(new Error("no view or scenario to pivot on"))
      : getPivot(p.runId, { view: viewId, metric, scenarioId })),
    [p.runId, viewId, metric, scenarioId],
  );
  if (viewId === null) {
    return <NotInRun title="Views" reason="The run declared no views, so it accumulated at family grain: the envelope carries no views block and no cells to pivot." />;
  }
  if (scenarioId === null) return <NotInRun title="Views" reason="The envelope's NII block lists no scenarios, so there is no scenario to pivot on." />;
  const ids = p.result.nii.byScenario.map((s) => s.scenarioId);
  return (
    <>
      <nav className="chip-row" aria-label="View">
        {pick.views.map((v) => <a key={v.viewId} className="pill" href={tabHref(p.ws, p.query, { view: v.viewId })} aria-current={v.viewId === viewId ? "true" : undefined}>{v.label}</a>)}
      </nav>
      <nav className="chip-row" aria-label="Metric">
        {PIVOT_METRICS.map((m) => <a key={m} className="pill" href={tabHref(p.ws, p.query, { metric: m })} aria-current={m === metric ? "true" : undefined}>{m}</a>)}
      </nav>
      <ScenarioPicker ws={p.ws} ids={ids} selected={scenarioId} query={p.query} label={p.scenarioLabel} />
      <DynamicViewsNote result={p.result} scenarioId={scenarioId} />
      <ViewsBody load={load} result={p.result} runId={p.runId} viewId={viewId} metric={metric} scenarioId={scenarioId} />
    </>
  );
}
