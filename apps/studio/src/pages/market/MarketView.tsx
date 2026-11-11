/**
 * Market. Every figure is a value a catalog route returned, formatted by
 * @alm/reader (pct for curve rates, sig for tenor years) or by the viewer
 * heatmap's own cell formatter, with a source line naming the route and field.
 * The vol cards print expiries and swap tenors through Studio's tenorLabel (1M,
 * 3M, 9M, then years) and short-rate strikes in percent; each names the rate
 * model that reads it, and the SABR card previews one short-rate expiry row.
 * The three curves are the snapshot's stored quoted points; no zero or forward
 * curve is bootstrapped here. The vol cells are the reader's capGrid and
 * swaptionGrid values in bp. Nothing is summed, interpolated or derived.
 */
import type { ReactNode } from "react";
import { formatValue, pct, sig, VOL_TO_BP, type CatalogCurveName, type CatalogMarketListItem } from "@alm/reader";
import { LinePlot, type PlotSeries } from "../../charts/LinePlot";
import { stepDecimals } from "../../charts/plotScale";
import { VolExplorer } from "../../charts/VolExplorer";
import { tenorLabel } from "../../format/tenor";
import { screenHref } from "../../pageLinks";
import { compareMarkets } from "../../selection";
import { HarnessFrame, type HarnessFrameProps } from "../../harness/HarnessFrame";
import { curveAxis, curveTable, type CurvePoint } from "../../rows/marketRows";
import { BASE_CURVE_ROUTE, HISTORY_ROUTE, lineageRoute, snapshotRoute, marketCurveRoute, type MarketModel } from "./loadMarket";
import { marketCurveText } from "../../market/marketCurve";
import { SabrSmileCard } from "./SabrSmileCard";

const CURVE_LABEL: Record<CatalogCurveName, string> = {
  "risk-free": "Benchmark discount curve",
  "term-funding": "Term funding curve",
  tlp: "Term liquidity premium spread",
};
const CURVE_TONE: Record<CatalogCurveName, PlotSeries["tone"]> = { "risk-free": "accent", "term-funding": "second", tlp: "third" };
/** The curve names as the source line spells them. */
const CURVE_FIELD: Record<CatalogCurveName, string> = { "risk-free": "benchmark", "term-funding": "term funding", tlp: "TLP" };

/** A Market sub-layer: curves (snapshots, benchmark, history, lineage), vols (short-rate and long-yield volatility surfaces), spreads (term funding and TLP). */
export type MarketSection = "curves" | "vols" | "spreads";

const rate = (v: number) => pct(v, 2);
const yearsLabel = (y: number) => `${sig(y, 4)}Y`;

function Unobs() {
  return <span className="status status-unobs">Unobservable</span>;
}

/** The header meta line for the selected snapshot, from its list item; Unobservable when the id is not listed. */
export function marketMeta(markets: CatalogMarketListItem[], marketId: string | null): ReactNode {
  const m = markets.find((x) => x.id === marketId);
  if (!m) return <>Snapshot Unobservable: {marketId ?? "none"} is not in /api/catalog/markets</>;
  return (
    <>
      <span className="num">{formatValue("count", m.curvePoints)}</span> curve points, <span className="num">{formatValue("count", m.capVolPoints)}</span> short-rate volatility points,{" "}
      <span className="num">{formatValue("count", m.swaptionVolPoints)}</span> long-yield volatility points, as of {m.asOf ?? "Unobservable"}, source /api/catalog/markets
    </>
  );
}

/**
 * Stored curves on one percent axis through LinePlot (Polish 10 T2): each tenor placed to scale on a square-root axis
 * from 0 to the longest stored tenor, a tick at each stored tenor under its stored term, a gap where a curve does not
 * quote a tenor. The benchmark card alone draws the soft area under its one line.
 */
function CurvePlot(props: { lists: CurvePoint[][]; series: Array<Omit<PlotSeries, "points">>; area?: boolean }) {
  const axis = curveAxis(props.lists);
  const label = new Map(axis.tenors.map((t, k) => [t, axis.labels[k]]));
  return (
    <LinePlot
      series={props.series.map((s, i): PlotSeries => ({ ...s, points: axis.tenors.map((t, k) => [t, axis.values[i][k]]) }))}
      xScale="sqrt"
      xDomain={[0, axis.tenors[axis.tenors.length - 1] ?? 1]}
      xTicks={axis.tenors.map((t, k) => ({ value: t, label: axis.labels[k] }))}
      xLabel={(x) => label.get(x) ?? yearsLabel(x)}
      yTick={(v, step) => pct(v, stepDecimals(step * 100))}
      format={rate}
      unit="Rate, percent; tenor to scale on a square-root axis"
      height={280}
      area={props.area}
    />
  );
}

function CurvesCard(props: { model: MarketModel; names: CatalogCurveName[] }) {
  const { marketId, asOf } = props.model;
  const curves = props.model.curves.filter((c) => props.names.includes(c.curve));
  const route = snapshotRoute(marketId);
  return (
    <figure className="card viz">
      <div className="viz-head">
        <div className="card-title">Stored curves</div>
        <p className="viz-sub">Quoted points as stored; the zero and forward curves built from them appear on a run&apos;s Rates tab. As of {asOf ?? "Unobservable"}; a tenor a curve does not quote is left as a gap.</p>
      </div>
      {curves.length === 0 ? (
        <p className="unobs-text"><Unobs /> The snapshot stores no curve.</p>
      ) : (
        <CurvePlot
          lists={curves.map((c) => c.points)}
          series={curves.map((c) => ({ id: c.curve, label: CURVE_LABEL[c.curve], tone: CURVE_TONE[c.curve] }))}
          area={curves.length === 1}
        />
      )}
      <figcaption>Source: {route} curves[{props.names.map((n) => CURVE_FIELD[n]).join(", ")}][].value by term and tYears</figcaption>
    </figure>
  );
}

/**
 * The curves table: zero, par, 1-month forward, discount factor, TLP and all-in at the
 * base curve's own tenors. The zero rate and discount factor are the engine's build of the stored snapshot (the
 * preview route, nothing shocked), named by the curve it is: platform default v2, log-linear on discount factor, for an
 * unmarked market, v1, linear in zero, for a market pinned to it, or the setup the snapshot carries. Par and TLP are the stored points at the tenor; the forward and the all-in are the
 * two figures computed here, named in the source line. A tenor the snapshot does not quote on a curve prints the
 * Unobservable chip in that cell.
 */
/**
 * The base curve line: what this snapshot builds, then, when the workspace has an active curve setup, that the setup
 * wins (a run of the workspace builds its curve from it; B4 Task 9 fix round). `activeSetup` is the setup's label, or
 * its document id when the label was not read.
 */
export function baseCurveSentence(model: Pick<MarketModel, "baseCurve">, activeSetup: string | null): string {
  const own = `Base curve of this snapshot: ${marketCurveText(model.baseCurve)}.`;
  return activeSetup === null ? own : `${own} This workspace's active setup ${activeSetup} wins.`;
}

function CurvesTableCard(props: { model: MarketModel; activeSetup?: string | null }) {
  const { model } = props;
  const route = snapshotRoute(model.marketId);
  if (!model.base) {
    return (
      <section className="card unobs-panel" aria-label="Curves at the stored tenors">
        <div className="card-title">Curves at the stored tenors</div>
        <Unobs />
        <p className="unobs-text">The zero curve could not be read: {model.baseNote ?? "the preview route returned no curve"}</p>
        <p className="card-desc">{baseCurveSentence(model, props.activeSetup ?? null)}</p>
        <p className="card-foot">Source: POST {BASE_CURVE_ROUTE} with the base rate spec on {model.marketId}</p>
      </section>
    );
  }
  const rows = curveTable(model.snapshot, model.base);
  const cell = (v: number | null, f: (x: number) => string) => (v === null ? <Unobs /> : f(v));
  return (
    <section className="card table-card" aria-labelledby="curves-table-title">
      <div className="table-head"><div className="card-title" id="curves-table-title">Curves at the stored tenors</div></div>
      <p className="card-desc">{baseCurveSentence(model, props.activeSetup ?? null)}</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Tenor</th>
              <th scope="col">Zero</th>
              <th scope="col">Par</th>
              <th scope="col">1-month forward</th>
              <th scope="col">Discount factor</th>
              <th scope="col">TLP, bp</th>
              <th scope="col">All-in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tYears} data-tenor={r.tYears}>
                <th scope="row">{r.term}</th>
                <td className="num">{pct(r.zero, 4)}</td>
                <td className="num">{cell(r.par, (v) => pct(v, 4))}</td>
                <td className="num">{pct(r.forward1m, 4)}</td>
                <td className="num">{r.df.toFixed(6)}</td>
                <td className="num">{cell(r.tlp, (v) => (v * 10000).toFixed(1))}</td>
                <td className="num">{cell(r.allIn, (v) => pct(v, 4))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">
        Source: POST {BASE_CURVE_ROUTE} (base rate spec) base.z and base.df, the engine&apos;s build of {route} ({marketCurveText(model.baseCurve)}), the curve named from GET {marketCurveRoute(model.marketId)}; par is curves[benchmark][].value and TLP is
        curves[TLP][].value at the same tenor. Computed here: the 1-month forward, simply compounded over [t, t + 1/12] from the discount factors (zero linear
        between nodes, flat beyond the last), and the all-in, the zero plus the TLP as a continuous spread.
      </p>
    </section>
  );
}

function SurfaceCard(props: { title: string; reader: string; field: string; route: string; children: ReactNode }) {
  return (
    <figure className="card viz">
      <div className="viz-head">
        <div className="card-title">{props.title}</div>
        <p className="viz-sub">{props.reader}</p>
        <p className="viz-sub">Drag the surface to turn it; hover the surface or the grid to read a stored quote, click to pin it. A face joins four stored quotes; nothing is interpolated.</p>
      </div>
      {props.children}
      <figcaption>Source: {props.route} {props.field}[].normalVol, stored as a decimal normal vol, times VOL_TO_BP ({formatValue("count", VOL_TO_BP)}) for bp</figcaption>
    </figure>
  );
}

function HistoryCard(props: { model: MarketModel }) {
  const { history, marketId } = props.model;
  if (history.series.length === 0) {
    return (
      <section className="card unobs-panel" aria-label="Benchmark curve across snapshots">
        <div className="card-title">Benchmark curve across snapshots</div>
        <Unobs />
        <p className="unobs-text">Unobservable: no snapshot stores a benchmark curve.</p>
        <p className="card-foot">Source: {HISTORY_ROUTE}</p>
      </section>
    );
  }
  if (history.series.length === 1) {
    return (
      <section className="card" aria-label="Benchmark curve across snapshots">
        <div className="card-title">Benchmark curve across snapshots</div>
        <p className="muted">One snapshot stored; the comparison draws when a second is loaded.</p>
        <p className="card-foot">Source: {HISTORY_ROUTE}</p>
      </section>
    );
  }
  return (
    <section className="card viz" aria-label="Benchmark curve across snapshots">
      <div className="viz-head">
        <div className="card-title">Benchmark curve across snapshots</div>
        <p className="viz-sub">One line per stored snapshot; the selected one in the accent line, the others in grey.</p>
      </div>
      <CurvePlot
        lists={history.series.map((s) => s.points)}
        series={history.series.map((s) => ({ id: s.marketId, label: `${s.asOf} (${s.marketId})`, tone: s.marketId === marketId ? "accent" : "muted" }))}
      />
      <p className="card-foot">Source: {HISTORY_ROUTE} series[].points[].value</p>
    </section>
  );
}

function LineageCard(props: { model: MarketModel }) {
  const { lineage, marketId } = props.model;
  return (
    <section className="card table-card" aria-labelledby="lineage-title">
      <div className="table-head"><div className="card-title" id="lineage-title">Lineage</div></div>
      {lineage.consumedBy.length === 0 ? (
        <p className="unobs-text"><Unobs /> No run has consumed this snapshot.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Run</th><th scope="col">Role</th><th scope="col">State</th><th scope="col">Ended</th></tr></thead>
            <tbody>
              {lineage.consumedBy.map((c) => (
                <tr key={`${c.runId}:${c.role}`}>
                  <th scope="row" className="mono">{c.runId}</th>
                  <td className="mono">{c.role}</td>
                  <td>{c.state}</td>
                  {/* The stored endedAt is ISO 8601; its first ten characters are the date. */}
                  <td>{c.endedAt?.slice(0, 10) ?? "Unobservable: no end time recorded"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot">Source: {lineageRoute(marketId)} consumedBy[]</p>
    </section>
  );
}

/**
 * `frame` is the harness frame of the screen's module (curves: curve construction; vols: volatility surface), drawn
 * under the charts; absent while its catalog and setups are read.
 */
export function MarketView(props: { ws: string; model: MarketModel; query: Record<string, string>; section: MarketSection; frame?: Omit<HarnessFrameProps, "hrefOf"> | null; activeSetup?: string | null }) {
  const { ws, model, query, section } = props;
  const frameAt = section === "vols" ? "vols" : "curves";
  const frame = props.frame === undefined || props.frame === null ? null : (
    <HarnessFrame {...props.frame} hrefOf={(id) => screenHref({ ws, section: "market", screen: frameAt }, { ...query, instance: id })} />
  );
  const route = snapshotRoute(model.marketId);
  if (section === "vols") {
    return (
      <>
        <SurfaceCard title="Short-rate volatility surface, normal bp (constructed illustrative)" reader="Read by Hull-White 1F: a stochastic run calibrates to the at-the-money column; the strike wings stay unread." field="capVolSurface" route={route}>
          <VolExplorer key={model.marketId} grid={model.cap} kind="cap" rowFormat={tenorLabel} colFormat={(k) => pct(k, 2)} title="Short-rate volatility" />
        </SurfaceCard>
        <SurfaceCard title="Long-yield volatility surface, normal bp (constructed illustrative)" reader="Read by BGM: a stochastic run calibrates to the default subset of this surface (28 points)." field="swaptionVolSurface" route={route}>
          <VolExplorer key={model.marketId} grid={model.swaption} kind="swaption" rowFormat={tenorLabel} colFormat={tenorLabel} title="Long-yield volatility" />
        </SurfaceCard>
        <SabrSmileCard key={model.marketId} marketId={model.marketId} expiries={model.cap.rows} />
        {frame}
      </>
    );
  }
  if (section === "spreads") return <><CurvesCard model={model} names={["term-funding", "tlp"]} />{frame}</>;
  return (
    <>
      <section className="card" aria-labelledby="snapshots-title">
        <div className="viz-head">
          <div className="card-title" id="snapshots-title">Snapshots</div>
          <ul className="chip-row" aria-label="Stored market snapshots">
            {[...model.markets].sort(compareMarkets).map((m) => (
              <li key={m.id}><span className="pill" aria-current={m.id === model.marketId ? "true" : undefined}><span className="num">{m.asOf ?? "Unobservable"}</span></span></li>
            ))}
          </ul>
        </div>
        <p className="card-foot">The workspace pins the marked snapshot <span className="mono">{model.marketId}</span>, content hash <span className="mono">{model.contentHash}</span>. Source: /api/catalog/markets</p>
      </section>

      <CurvesCard model={model} names={["risk-free"]} />
      <CurvesTableCard model={model} activeSetup={props.activeSetup ?? null} />
      <HistoryCard model={model} />
      <LineageCard model={model} />
      {frame}
    </>
  );
}
