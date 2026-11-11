// apps/studio/src/pages/results/RatesTab.tsx
/**
 * Rates tab (Studio S3a): the run's rate document (GET /api/runs/:id/rates).
 * Every plotted value is a stored decimal times 100 (rateChartRows). A path
 * the document omitted is named with the document's reason; a document the
 * row builders refuse shows their message. A scenario keeps one line style on
 * both charts: the six series colours in turn over the scenarios, dashed from
 * the seventh on, and the base curve a dashed muted line drawn last. Each scenario is named by its label and its id, as the Value (EVE)
 * layer names it (item 2), and by its id alone when the label is the id. Each scenario's stored spec kind and path model are
 * painted; the fields not drawn are named in the footer. Both charts are
 * LinePlots (Polish 10 T2): the zero curves with tenors to scale on a
 * square-root axis, the paths with a drag zoom; each tooltip and table adds the
 * scenario's gap to the base in bp (ruling 3), the one computed figure.
 */
import type { RateDocument } from "@alm/engine";
import { BASE_SERIES_ID, curveRows, curveSeriesIds, getRates, pathRows, pctPoints } from "@alm/reader";
import { LinePlot, type PlotSeries, type PlotTone } from "../../charts/LinePlot";
import { monthTicks, stepDecimals } from "../../charts/plotScale";
import { tenorLabel } from "../../format/tenor";
import { errText } from "../../errText";
import { useLoad, type LoadState } from "../../useLoad";
import type { TabProps } from "./common";

const TONES: ReadonlyArray<PlotTone> = ["accent", "second", "third", "fourth", "fifth", "sixth"];

/** The line style of the scenario at place i among the scenarios: the six colours in turn, dashed from the seventh, so twelve stay distinct. */
export function styleAt(i: number): { tone: PlotTone; dash: boolean } {
  return { tone: TONES[i % TONES.length] ?? "muted", dash: i >= TONES.length };
}

type Built =
  | { ok: true; ids: string[]; curves: ReturnType<typeof curveRows>; paths: ReturnType<typeof pathRows> }
  | { ok: false; message: string };

/** The row builders throw on a document they refuse to chart; their message is kept verbatim. */
function build(doc: RateDocument): Built {
  try {
    return { ok: true, ids: curveSeriesIds(doc), curves: curveRows(doc), paths: pathRows(doc) };
  } catch (e) {
    return { ok: false, message: errText(e) };
  }
}

/** Each scenario's stored spec kind and path model, and whether its path is drawn or omitted (with the document's reason). */
function ScenarioTable(props: { doc: RateDocument; label: (id: string) => string; omitted: Map<string, string> }) {
  return (
    <section className="card table-card" aria-label="Rate scenarios">
      <div className="card-title">Scenarios in the rate document</div>
      <p className="card-desc">
        As of {props.doc.grid.asOf}; {props.doc.mode} run; horizon {props.doc.grid.horizonMonths} months on a grid step of {tenorLabel(props.doc.grid.dtYears)}.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Scenario</th><th scope="col">Rate spec</th><th scope="col">Path model</th><th scope="col">Path</th></tr></thead>
          <tbody>
            {props.doc.scenarios.map((s) => {
              const reason = props.omitted.get(s.scenarioId);
              return (
                <tr key={s.scenarioId}>
                  <th scope="row">{props.label(s.scenarioId)} <span className="mono muted">{s.scenarioId}</span></th>
                  <td className="mono">{s.rateSpecKind}</td>
                  <td className="mono">{s.ratePathModel}</td>
                  <td>{reason === undefined ? "drawn" : <><span className="status status-unobs" title={reason}>Unobservable</span> <span className="muted">{reason}</span></>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A percent-unit tick: 4.2%, at the decimals the tick step needs. */
const pctTick = (v: number, step: number) => `${v.toFixed(stepDecimals(step))}%`;

/** The one scenario whose stored spec kind is base, when there is exactly one: the path chart's delta series. */
export function baseScenarioId(doc: RateDocument): string | undefined {
  const bases = doc.scenarios.filter((s) => s.rateSpecKind === "base");
  return bases.length === 1 ? bases[0]!.scenarioId : undefined;
}

export function RatesView(props: { doc: RateDocument; label: (id: string) => string; runId: string }) {
  const built = build(props.doc);
  if (!built.ok) {
    return <section className="card" role="alert"><span className="status status-breach">✕ Rate document not drawable</span> {built.message}</section>;
  }
  const { ids, curves, paths } = built;
  const scenarioIds = ids.filter((id) => id !== BASE_SERIES_ID);
  // Label and id, so two scenarios of one shape never share a name (the base curve is not a scenario); a label that
  // is the id itself prints once, S100 rather than S100 S100, which keeps the tooltip narrow (Polish 11, F11).
  const name = (id: string) => {
    if (id === BASE_SERIES_ID) return "Base curve";
    const label = props.label(id);
    return label === id ? id : `${label} ${id}`;
  };
  const styleOf = (id: string) => styleAt(scenarioIds.indexOf(id));
  const omitted = new Map(paths.omitted.map((o) => [o.scenarioId, o.reason]));
  const pathIds = scenarioIds.filter((id) => !omitted.has(id));
  const baseId = baseScenarioId(props.doc);
  const pathBase = baseId !== undefined && pathIds.includes(baseId) ? baseId : undefined;
  const fan = props.doc.stochastic;
  return (
    <>
      <figure className="card viz" aria-label="Zero curves">
        <div className="viz-head"><div className="card-title">Zero curve by scenario</div></div>
        <LinePlot
          series={[
            ...scenarioIds.map((id): PlotSeries => ({ id, label: name(id), points: curves.map((r) => [r.t, r[id] ?? null]), ...styleOf(id) })),
            // Drawn last: over a base scenario's line, which has the same points, the base curve shows as a dashed grey. The
            // tooltip names the base once: deltaTwin leaves the base scenario's row out where it equals the base curve.
            { id: BASE_SERIES_ID, label: name(BASE_SERIES_ID), points: curves.map((r) => [r.t, r[BASE_SERIES_ID] ?? null]), tone: "muted", dash: true },
          ]}
          xScale="sqrt"
          xDomain={[0, curves[curves.length - 1]?.t ?? 1]}
          xTicks={curves.map((r) => ({ value: r.t, label: tenorLabel(r.t) }))}
          xLabel={tenorLabel}
          yTick={pctTick}
          format={pctPoints}
          unit="continuously compounded zero rate, percent; tenor to scale on a square-root axis"
          height={340}
          delta={BASE_SERIES_ID}
          deltaTwin={baseId}
        />
        <figcaption className="card-foot">Source: /api/runs/{props.runId}/rates base and scenarios[].curve (t and z). The discount factors stored beside each curve (curve.df) are not drawn. The vs base, bp column (tooltip and Show table) is the scenario rate minus the base curve&apos;s rate at the same tenor, in bp.</figcaption>
      </figure>
      {paths.rows.length > 0 ? (
        <figure className="card viz" aria-label="Rate paths">
          <div className="viz-head"><div className="card-title">One-month rate path by scenario</div></div>
          <LinePlot
            series={pathIds.map((id): PlotSeries => ({ id, label: name(id), points: paths.rows.map((r) => [r.month, r[id] ?? null]), ...styleOf(id) }))}
            xScale="linear"
            xTicks={monthTicks}
            xLabel={(m) => `M${m}`}
            yTick={pctTick}
            format={pctPoints}
            unit="one-month forward, percent; month index from the as-of"
            height={340}
            markers={false}
            zoom
            delta={pathBase}
          />
          <figcaption className="card-foot">
            Source: /api/runs/{props.runId}/rates scenarios[].path.rate. Point Mk is the one-month forward over months k to k+1 from the as-of, on the stored path.times grid.
            {pathBase === undefined ? null : <> The vs base, bp column (tooltip and Show table) is the scenario rate minus {name(pathBase)}&apos;s rate in the same month, in bp.</>}
          </figcaption>
        </figure>
      ) : null}
      {paths.omitted.length > 0 ? (
        <section className="card unobs-panel" aria-label="Omitted paths">
          <div className="card-title">Paths the document omits</div>
          <ul className="nimpl-list">
            {paths.omitted.map((o) => <li key={o.scenarioId}><span className="status status-unobs" title={o.reason}>Unobservable</span> <span className="mono">{o.scenarioId}</span> {o.reason}</li>)}
          </ul>
        </section>
      ) : null}
      <ScenarioTable doc={props.doc} label={props.label} omitted={omitted} />
      {/* A 1.2.0 BGM fan carries `model` and summarises the 1-day saved forward; a Hull-White fan of any version carries none. */}
      {fan === undefined ? null : "model" in fan ? (
        <p className="card-foot">
          The document also stores a BGM fan for {props.label(fan.scenarioId)} ({fan.nPaths} paths, model <span className="mono">{fan.model}</span>): the 1-day saved forward across paths, the short-rate analog BGM discounting uses; this tab does not draw it.
        </p>
      ) : (
        <p className="card-foot">
          The document also stores a stochastic short-rate fan for {props.label(fan.scenarioId)} ({fan.nPaths} paths); this tab does not draw it.
        </p>
      )}
    </>
  );
}

/** The tab body for a given load state, so each branch renders without a fetch. */
export function RatesBody(props: { load: LoadState<RateDocument>; runId: string; label: (id: string) => string }) {
  const { load } = props;
  if (load.state === "loading") return <div className="card muted">Reading the rate document for {props.runId}</div>;
  if (load.state === "error") {
    return <section className="card unobs-panel" role="alert"><span className="status status-unobs">No rate document</span><p className="unobs-text">{errText(load.error)}</p></section>;
  }
  return <RatesView doc={load.value} label={props.label} runId={props.runId} />;
}

export function RatesTab(p: TabProps) {
  const load = useLoad(() => getRates(p.runId), [p.runId]);
  return <RatesBody load={load} runId={p.runId} label={p.scenarioLabel} />;
}
