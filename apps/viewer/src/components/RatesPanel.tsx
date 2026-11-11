/**
 * Rates tab: draws a run's rate document (GET /api/runs/:id/rates) as three charts: the zero curve per scenario against the base
 * curve, the monthly one-month rate path per scenario, and on a stochastic run
 * the short-rate fan of the base scenario.
 *
 * Honesty rules this panel enforces:
 *  - Every plotted number is a stored document field times 100 (percent for
 *    the axis; src/rateChartRows.ts, unit-tested) or a [low, high] pair of such
 *    values that recharts draws as a band. Nothing here computes a statistic.
 *  - A scenario whose path the document omitted is listed with the document's
 *    own reason; no path is invented for it.
 *  - The fan draws the stored mean and quantiles only; no individual Monte
 *    Carlo path is stored, so none is drawn.
 *  - A refusal reaches the reader verbatim on both paths. A missing document (a
 *    run that predates piece 4a) renders the server's 404 message; a document
 *    the row builders refuse to chart (a reserved scenario id, a node-count or
 *    path-length mismatch, a missing quantile) renders the builder's own
 *    message. Neither is softened, and neither throws out of this panel: a bad
 *    document costs this tab its charts, never the rest of the viewer.
 *  - Colors follow the entity: a scenario keeps its hue across both charts.
 *    Six validated series tokens; a seventh series onward is muted and dashed,
 *    never a cycled hue. Under every chart a collapsed values table carries
 *    every series, so identity is never color-alone.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BgmRateFan, RateDocument, StochasticRateFan } from "@alm/engine";
import { getRates } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";
import {
  BASE_SERIES_ID,
  curveRows,
  curveSeriesIds,
  fanRows,
  pathRows,
  pctPoints,
  type CurveRow,
  type FanRow,
  type OmittedPath,
  type PathRow,
} from "@alm/reader";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; doc: RateDocument };

const SERIES_TOKENS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
] as const;

/** Stroke for the series at draw index `i` (0 = base). Past the tokens: muted, dashed. */
function seriesStroke(i: number): string {
  return i < SERIES_TOKENS.length ? SERIES_TOKENS[i] : "var(--muted)";
}
function seriesDash(i: number): string | undefined {
  return i < SERIES_TOKENS.length ? undefined : "4 3";
}

const TICK = { fontSize: 11, fill: "var(--muted)" } as const;
const TOOLTIP_STYLE = {
  background: "var(--panel)",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  fontSize: 12,
} as const;
const GRID_STROKE = "var(--line)";

function formatTooltipValue(v: unknown): string {
  if (Array.isArray(v) && v.length === 2) return `${pctPoints(Number(v[0]))} to ${pctPoints(Number(v[1]))}`;
  return pctPoints(Number(v));
}

export function RatesPanel({
  runId,
  errorText,
  marketId,
}: {
  runId: string;
  errorText: (e: unknown) => string;
  /** The run's market snapshot id (refs.marketId); links the header to the Data page's vol surfaces when known. */
  marketId?: string;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    getRates(runId)
      .then((doc) => live && setState({ status: "ready", doc }))
      .catch((err: unknown) => live && setState({ status: "error", message: errorText(err) }));
    return () => {
      live = false;
    };
  }, [runId, errorText]);

  if (state.status === "loading") return <p className="emptynote">Loading rate document for run {runId}…</p>;
  if (state.status === "error") {
    return (
      <section className="panel">
        <h2>Rate document not available</h2>
        <p className="desc">
          The platform returned the following for run <code>{runId}</code>. The message is shown verbatim;
          nothing is drawn for a document that does not exist.
        </p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{state.message}</pre>
      </section>
    );
  }
  return <RatesReport doc={state.doc} runId={runId} marketId={marketId} />;
}

/**
 * Every row set of the report, built in one guarded place. The builders refuse
 * a document they cannot chart honestly (src/rateChartRows.ts throws on a
 * reserved scenario id, a node-count or path-length mismatch, a missing
 * quantile p). That refusal is caught here and rendered, never thrown out of
 * the panel, so a bad document cannot unmount the viewer's root.
 */
type RowsState =
  | {
      ok: true;
      curveIds: string[];
      curves: CurveRow[];
      pathIds: string[];
      paths: PathRow[];
      omitted: OmittedPath[];
      fan: FanRow[] | undefined;
    }
  | { ok: false; message: string };

function buildRows(doc: RateDocument): RowsState {
  try {
    const { rows: paths, omitted } = pathRows(doc);
    const fan = doc.stochastic;
    return {
      ok: true,
      curveIds: curveSeriesIds(doc),
      curves: curveRows(doc),
      pathIds: doc.scenarios.filter((s) => s.path !== undefined).map((s) => s.scenarioId),
      paths,
      omitted,
      fan: fan !== undefined ? fanRows(fan) : undefined,
    };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function RatesReport({ doc, runId, marketId }: { doc: RateDocument; runId: string; marketId?: string }) {
  const scenarioLabel = useScenarioLabel();
  // Draw index per series id, fixed from the document's scenario order so a
  // scenario keeps its hue on every chart (color follows the entity).
  const drawIndex = useMemo(() => {
    const m = new Map<string, number>();
    curveSeriesIds(doc).forEach((id, i) => m.set(id, i));
    return m;
  }, [doc]);
  const rows = useMemo(() => buildRows(doc), [doc]);
  const seriesName = (id: string) => (id === BASE_SERIES_ID ? "Base curve" : scenarioLabel(id));
  const overflow = doc.scenarios.length + 1 > SERIES_TOKENS.length;
  const fan = doc.stochastic;

  if (!rows.ok) {
    return (
      <section className="panel">
        <h2>Rate document cannot be charted</h2>
        <p className="desc">
          The rate document for run <code>{runId}</code> exists but cannot be charted: the row builders
          refused it. The refusal is shown verbatim; nothing is drawn for a document that would have to be
          repaired or resampled to plot.
        </p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{rows.message}</pre>
      </section>
    );
  }

  return (
    <>
      <div className="provbar" style={{ marginTop: 12 }}>
        <span>
          Document <code>{doc.kind}</code>
        </span>
        <span>
          Schema <code>{doc.schemaVersion}</code>
        </span>
        <span>
          Mode <code>{doc.mode}</code>
        </span>
        <span>
          Horizon <code>{doc.grid.horizonMonths}M</code>
        </span>
        <span>
          As of <code>{doc.grid.asOf}</code>
        </span>
        <span>
          <a href={`/api/runs/${encodeURIComponent(runId)}/rates`}>rates.json</a>
        </span>
        {marketId === undefined ? null : (
          <span>
            Market <code>{marketId}</code>:{" "}
            <a href={`#/data?tab=market&market=${encodeURIComponent(marketId)}`}>vol surfaces</a>
          </span>
        )}
      </div>

      <CurvesSection rows={rows.curves} ids={rows.curveIds} drawIndex={drawIndex} seriesName={seriesName} />
      <PathsSection
        rows={rows.paths}
        ids={rows.pathIds}
        omitted={rows.omitted}
        drawIndex={drawIndex}
        seriesName={seriesName}
      />
      {fan !== undefined && rows.fan !== undefined ? (
        <FanSection fan={fan} rows={rows.fan} seriesName={seriesName} />
      ) : null}
      {overflow ? (
        <p className="footnote">
          This run has more scenarios than the six validated series colors. The seventh series onward is
          drawn muted and dashed; the legend and the values tables still name every series.
        </p>
      ) : null}
    </>
  );
}

function CurvesSection({
  rows,
  ids,
  drawIndex,
  seriesName,
}: {
  rows: CurveRow[];
  ids: string[];
  drawIndex: Map<string, number>;
  seriesName: (id: string) => string;
}) {
  return (
    <section className="panel">
      <h2>Zero curves</h2>
      <p className="desc">
        The bootstrapped base zero curve and each scenario's shocked zero curve at the base curve's own
        nodes, continuously compounded, read verbatim from the rate document and scaled to percent.
      </p>
      <div style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 12, bottom: 8 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              tick={TICK}
              tickFormatter={(v: number) => `${v}y`}
              domain={[0, "dataMax"]}
            />
            <YAxis tick={TICK} tickFormatter={(v: number) => pctPoints(v)} width={64} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(t) => `${t} years`}
              formatter={(v, name) => [formatTooltipValue(v), String(name)]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {ids.map((id) => {
              const i = drawIndex.get(id) ?? SERIES_TOKENS.length;
              return (
                <Line
                  key={id}
                  dataKey={id}
                  name={seriesName(id)}
                  type="monotone"
                  stroke={seriesStroke(i)}
                  strokeDasharray={seriesDash(i)}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ValuesTable
        keyHeader="Tenor (y)"
        keyOf={(r: CurveRow) => String(r.t)}
        columns={ids.map((id) => ({ id, label: seriesName(id) }))}
        rows={rows}
      />
    </section>
  );
}

function PathsSection({
  rows,
  ids,
  omitted,
  drawIndex,
  seriesName,
}: {
  rows: PathRow[];
  ids: string[];
  omitted: OmittedPath[];
  drawIndex: Map<string, number>;
  seriesName: (id: string) => string;
}) {
  return (
    <section className="panel">
      <h2>Rate paths</h2>
      <p className="desc">
        The monthly one-month forward rate each deterministic scenario ran on: at month k, the rate a
        one-month floater reads over [k, k+1). Read verbatim from the rate document and scaled to percent.
      </p>
      {rows.length === 0 ? (
        <p className="emptynote">No scenario on this run carries a deterministic rate path.</p>
      ) : (
        <>
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 8, right: 12, left: 12, bottom: 8 }}>
                <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                <XAxis dataKey="month" type="number" tick={TICK} domain={["dataMin", "dataMax"]} />
                <YAxis tick={TICK} tickFormatter={(v: number) => pctPoints(v)} width={64} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={(m) => `Month ${m}`}
                  formatter={(v, name) => [formatTooltipValue(v), String(name)]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {ids.map((id) => {
                  const i = drawIndex.get(id) ?? SERIES_TOKENS.length;
                  return (
                    <Line
                      key={id}
                      dataKey={id}
                      name={seriesName(id)}
                      type="monotone"
                      stroke={seriesStroke(i)}
                      strokeDasharray={seriesDash(i)}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <ValuesTable
            keyHeader="Month"
            keyOf={(r: PathRow) => String(r.month)}
            columns={ids.map((id) => ({ id, label: seriesName(id) }))}
            rows={rows}
          />
        </>
      )}
      {omitted.length > 0 ? (
        <p className="footnote">
          {omitted.map((o) => (
            <span key={o.scenarioId} style={{ display: "block" }}>
              {seriesName(o.scenarioId)}: {o.reason}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The stochastic run's fan, for either model. A 1.2.0 BGM
 * fan carries `model` and the Rebonato block and summarises the 1-day saved forward, the short-rate
 * analog its discounting uses; the Hull-White fan carries a and sigma. Each reads its own parameters.
 */
export function FanSection({
  fan,
  rows,
  seriesName,
}: {
  fan: StochasticRateFan | BgmRateFan;
  rows: FanRow[];
  seriesName: (id: string) => string;
}) {
  const hue = SERIES_TOKENS[0];
  const bgm = "model" in fan;
  return (
    <section className="panel">
      <h2>Short-rate fan</h2>
      {bgm ? (
        <p className="desc">
          The BGM run's 1-day saved forward, the short-rate analog its discounting uses, across paths for{" "}
          {seriesName(fan.scenarioId)}: the stored mean and quantiles at each simulation step, scaled to
          percent. Bands are the stored p5 to p95 and p25 to p75 quantiles across paths; no individual path is
          stored or drawn.
        </p>
      ) : (
        <p className="desc">
          The stochastic run's short rate across paths for {seriesName(fan.scenarioId)}: the stored mean and
          quantiles at each simulation step, scaled to percent. Bands are the stored p5 to p95 and p25 to p75
          quantiles of the short rate across paths; no individual path is stored or drawn.
        </p>
      )}
      <div style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 12, bottom: 8 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              tick={TICK}
              tickFormatter={(v: number) => `${v.toFixed(1)}y`}
              domain={["dataMin", "dataMax"]}
            />
            <YAxis tick={TICK} tickFormatter={(v: number) => pctPoints(v)} width={64} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(t) => `${Number(t).toFixed(3)} years`}
              formatter={(v, name) => [formatTooltipValue(v), String(name)]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              dataKey="outer"
              name="p5 to p95"
              type="monotone"
              stroke="none"
              fill={hue}
              fillOpacity={0.15}
              isAnimationActive={false}
            />
            <Area
              dataKey="inner"
              name="p25 to p75"
              type="monotone"
              stroke="none"
              fill={hue}
              fillOpacity={0.3}
              isAnimationActive={false}
            />
            <Line dataKey="p50" name="p50" type="monotone" stroke={hue} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line
              dataKey="mean"
              name="mean"
              type="monotone"
              stroke={hue}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <FanValuesTable rows={rows} />
      {"model" in fan ? (
        <p className="footnote">
          Paths <code>{fan.nPaths}</code>, model <code>{fan.model}</code>, Rebonato a <code>{fan.bgm.a}</code>, b{" "}
          <code>{fan.bgm.b}</code>, c <code>{fan.bgm.c}</code>, d <code>{fan.bgm.d}</code>, beta{" "}
          <code>{fan.bgm.beta}</code>, volScalar <code>{fan.bgm.volScalar}</code>, displacement{" "}
          <code>{fan.bgm.displacement}</code>, CEV exponent <code>{fan.bgm.cevBeta}</code>, as the rate document
          reports them.
        </p>
      ) : (
        <p className="footnote">
          Paths <code>{fan.nPaths}</code>, Hull-White a <code>{fan.a}</code>, sigma <code>{fan.sigma}</code>, as the
          envelope reports them.
        </p>
      )}
    </section>
  );
}

/** The relief table: every series of a chart, verbatim rows, collapsed by default. */
function ValuesTable<R extends Record<string, number>>({
  keyHeader,
  keyOf,
  columns,
  rows,
}: {
  keyHeader: string;
  keyOf: (r: R) => string;
  columns: { id: string; label: string }[];
  rows: R[];
}) {
  return (
    <details className="values">
      <summary>Values ({rows.length} rows)</summary>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>{keyHeader}</th>
              {columns.map((c) => (
                <th key={c.id}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{keyOf(r)}</td>
                {columns.map((c) => (
                  <td key={c.id} className="num">
                    {pctPoints(r[c.id])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function FanValuesTable({ rows }: { rows: FanRow[] }) {
  return (
    <details className="values">
      <summary>Values ({rows.length} rows)</summary>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Step (y)</th>
              <th>p5</th>
              <th>p25</th>
              <th>p50</th>
              <th>mean</th>
              <th>p75</th>
              <th>p95</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.t.toFixed(4)}</td>
                <td className="num">{pctPoints(r.outer[0])}</td>
                <td className="num">{pctPoints(r.inner[0])}</td>
                <td className="num">{pctPoints(r.p50)}</td>
                <td className="num">{pctPoints(r.mean)}</td>
                <td className="num">{pctPoints(r.inner[1])}</td>
                <td className="num">{pctPoints(r.outer[1])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
