/**
 * The Views tab. Three pickers (view, metric, scenario), one table
 * whose rows are the server's pivot verbatim, and a per-row drill-down into
 * the stored numbers of each cell. Nothing here computes: the rows come from
 * GET /api/runs/:id/pivot and the cell numbers from the envelope already in
 * hand, laid out by the tested helpers in format.ts. A refusal renders the
 * server's message in place of the table; the pickers stay live.
 */
import { useEffect, useState } from "react";
import type { PivotMetric, PivotResult, RunResult } from "@alm/engine";
import { getPivot } from "@alm/reader";
import {
  EVE_PV_CAVEAT,
  PIVOT_METRICS,
  cellDetail,
  cellDetailValues,
  pivotHeaders,
  pivotRowValues,
  pivotTotalValues,
  signClass,
  usdMM,
} from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

type Fetch =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; pivot: PivotResult }
  | { status: "error"; message: string };

export function ViewsPanel({
  runId,
  result,
  scenario,
  errorText,
}: {
  runId: string;
  result: RunResult;
  scenario: string;
  errorText: (err: unknown) => string;
}) {
  const scenarioLabel = useScenarioLabel();
  const views = result.views ?? [];
  const [viewId, setViewId] = useState<string>(views[0]?.viewId ?? "");
  const [metric, setMetric] = useState<PivotMetric>("balance");
  const [state, setState] = useState<Fetch>({ status: "idle" });
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    if (viewId === "") return;
    let cancelled = false;
    setState({ status: "loading" });
    setOpen(new Set());
    getPivot(runId, { view: viewId, metric, scenarioId: scenario }).then(
      (pivot) => {
        if (!cancelled) setState({ status: "ok", pivot });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorText(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId, viewId, metric, scenario, errorText]);

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <section className="panel">
      <h2>Views</h2>
      <p className="desc">
        {scenarioLabel(scenario)} scenario. One row per group of the declared view, rolled up on the server from
        the stored cells; open a row to read each cell&rsquo;s own stored numbers.
      </p>
      <div className="controls">
        <span style={{ alignSelf: "center", color: "var(--muted)", fontSize: 12, marginRight: 4 }}>View:</span>
        <select value={viewId} onChange={(e) => setViewId(e.target.value)} style={fieldStyle}>
          {views.map((v) => (
            <option key={v.viewId} value={v.viewId}>
              {v.label}
            </option>
          ))}
        </select>
        <span style={{ alignSelf: "center", color: "var(--muted)", fontSize: 12, marginLeft: 8, marginRight: 4 }}>
          Metric:
        </span>
        <select value={metric} onChange={(e) => setMetric(e.target.value as PivotMetric)} style={fieldStyle}>
          {PIVOT_METRICS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      {metric === "evePv" ? <p className="footnote">{EVE_PV_CAVEAT}</p> : null}
      {state.status === "loading" ? <p className="desc">Loading pivot&hellip;</p> : null}
      {state.status === "error" ? (
        <p className="error" style={{ whiteSpace: "pre-wrap" }}>
          {state.message}
        </p>
      ) : null}
      {state.status === "ok" ? (
        <PivotTable pivot={state.pivot} result={result} open={open} toggle={toggle} />
      ) : null}
    </section>
  );
}

function PivotTable({
  pivot,
  result,
  open,
  toggle,
}: {
  pivot: PivotResult;
  result: RunResult;
  open: ReadonlySet<number>;
  toggle: (i: number) => void;
}) {
  const headers = pivotHeaders(pivot);
  const total = pivotTotalValues(pivot);
  const width = pivot.groupBy.length + 2 + headers.length;
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {pivot.groupBy.map((d) => (
              <th key={d}>{d}</th>
            ))}
            <th>positions</th>
            <th>cells</th>
            {headers.map((h) => (
              <th key={h} title={pivot.metric === "evePv" ? EVE_PV_CAVEAT : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pivot.rows.map((row, i) => (
            <RowWithCells key={i} index={i} row={row} pivot={pivot} result={result} open={open.has(i)} toggle={toggle} width={width} />
          ))}
          {total !== undefined ? (
            <tr>
              <td colSpan={pivot.groupBy.length}>
                <strong>total</strong>
              </td>
              <td />
              <td />
              {total.map((v, k) => (
                <td key={k} className={`num ${signClass(v)}`}>
                  {usdMM(v)}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function RowWithCells({
  index,
  row,
  pivot,
  result,
  open,
  toggle,
  width,
}: {
  index: number;
  row: PivotResult["rows"][number];
  pivot: PivotResult;
  result: RunResult;
  open: boolean;
  toggle: (i: number) => void;
  width: number;
}) {
  const values = pivotRowValues(pivot, row);
  return (
    <>
      <tr>
        {pivot.groupBy.map((d, k) => (
          <td key={d}>
            {k === 0 ? (
              <button className="linkish" onClick={() => toggle(index)} aria-expanded={open}>
                {open ? "▾" : "▸"} {row.key[d]}
              </button>
            ) : (
              row.key[d]
            )}
          </td>
        ))}
        <td className="num">{row.positionCount}</td>
        <td className="num">{row.cellIds.length}</td>
        {values.map((v, k) => (
          <td key={k} className={`num ${signClass(v)}`}>
            {usdMM(v)}
          </td>
        ))}
      </tr>
      {open
        ? row.cellIds.map((cellId) => {
            const detail = cellDetail(result, pivot.metric, pivot.scenarioId, cellId);
            const nums = cellDetailValues(detail);
            const tags =
              detail.ref === undefined
                ? cellId
                : Object.keys(detail.ref.tags)
                    .sort()
                    .map((k) => `${k}=${detail.ref!.tags[k]}`)
                    .join(" ");
            return (
              <tr key={cellId} className="cellrow">
                <td colSpan={pivot.groupBy.length}>
                  <span className="zero">{detail.ref?.familyId ?? "?"}</span> {tags}
                </td>
                <td className="num">{detail.ref?.positionCount ?? ""}</td>
                <td />
                {nums === undefined ? (
                  <td colSpan={Math.max(1, width - pivot.groupBy.length - 2)} className="zero">
                    no stored cell numbers for this metric on this scenario
                  </td>
                ) : (
                  nums.map((v, k) => (
                    <td key={k} className={`num ${signClass(v)}`}>
                      {usdMM(v)}
                    </td>
                  ))
                )}
              </tr>
            );
          })
        : null}
    </>
  );
}

const fieldStyle = {
  font: "inherit",
  fontSize: 13,
  padding: "3px 8px",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  background: "var(--panel)",
  color: "var(--ink)",
} as const;
