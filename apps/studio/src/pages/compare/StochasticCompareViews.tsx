// apps/studio/src/pages/compare/StochasticCompareViews.tsx
/**
 * Stochastic Compare views: two stored Monte Carlo envelopes side by
 * side. A row is a statistic of one run's path set (never an EVE or an NII);
 * every B - A and the standard-error figure are derived by the server and
 * printed as the reply carries them, labeled "(derived)". Nothing here does
 * arithmetic on a result value. Download CSV links the reply's CSV twin,
 * /api/compare/stochastic.csv. Slice two (spec v2 decisions 93 and
 * 94): a pair of different models prints the reply's `different-models` text
 * and note as it carries them, and a pair naming BGM gets the Calibration
 * parameters card under the context table, read from both runs' summaries.
 */
import type { StochasticCalibrationSummary } from "@alm/engine";
import { stochasticCompareCsvUrl, type RunSummary, type StochasticCompareReply } from "@alm/reader";
import { cellText, contextText, deltaText, parseCompareQuery, statLabel, STOCHASTIC_TABLES } from "../../compare/compareModel";
import { calibrationEntries } from "../../results/stochasticRun";
import { errText } from "../../errText";
import type { LoadState } from "../../useLoad";
import { RunPickers, type PickerScope } from "./CompareViews";
import { CompareGridAsOf, type CompareGrid } from "./CompareGridAsOf";

type Block = StochasticCompareReply["eveDistribution"];

/** One distribution: a row per statistic with both runs' values and the derived B - A, then the standard-error figure. */
export function DistributionTable(props: { title: string; block: Block }) {
  const { block } = props;
  const figure = block.meanDeltaStandardError;
  return (
    <section className="card" aria-label={props.title}>
      <div className="card-title">{props.title}</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Statistic</th>
              <th scope="col" className="num">Run A</th>
              <th scope="col" className="num">Run B</th>
              <th scope="col" className="num">B - A (derived)</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <tr key={`${row.stat}-${String(row.p)}`}>
                <th scope="row">{statLabel(row)}</th>
                <td className="num" title={String(row.a)}>{cellText(row.a, "A", true)}</td>
                <td className="num" title={String(row.b)}>{cellText(row.b, "B", true)}</td>
                <td className="num" title={String(row.delta)}>{deltaText(row.delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="kv">
        <dt>Standard-error figure for B - A of the means (derived)</dt>
        <dd>{figure.value === null ? "none" : cellText(figure.value, "A", true)}</dd>
        <dt>How it was derived</dt>
        <dd>{figure.text}</dd>
      </dl>
    </section>
  );
}

/** The like-for-like fields of both envelopes; `same` is the server's strict equality, shown as the reply has it. */
export function StochasticContextCard(props: { reply: StochasticCompareReply }) {
  return (
    <section className="card" aria-label="Like for like">
      <div className="card-title">Like for like</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Run A</th>
              <th scope="col">Run B</th>
              <th scope="col">Same</th>
            </tr>
          </thead>
          <tbody>
            {props.reply.context.map((c) => (
              <tr key={c.field}>
                <th scope="row" className="mono">{c.field}</th>
                <td className="mono">{contextText(c.a)}</td>
                <td className="mono">{contextText(c.b)}</td>
                <td>{c.same ? "same" : <span className="status status-stale">differs</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Both runs' calibration arms, each read from its single-run summary (the `calibration` field), or why they could not
 * be read. The compare reply carries no BGM parameter, so this card is read beside it.
 */
export type CompareCalibration = { a: StochasticCalibrationSummary; b: StochasticCalibrationSummary } | { error: string };

/** One parameter row per key of either arm: run A's keys in its order, then run B's keys run A lacks. */
function parameterRows(a: StochasticCalibrationSummary, b: StochasticCalibrationSummary) {
  const ea = new Map(calibrationEntries(a).map((e) => [e.key, e.value]));
  const eb = new Map(calibrationEntries(b).map((e) => [e.key, e.value]));
  const keys = [...ea.keys(), ...[...eb.keys()].filter((k) => !ea.has(k))];
  return keys.map((key) => ({ key, a: ea.get(key) ?? "not in run A", b: eb.get(key) ?? "not in run B" }));
}

/** The Calibration parameters card under the context table, for a pair naming BGM; nothing is derived here. */
export function CalibrationParametersCard(props: { runA: string; runB: string; calibration: CompareCalibration }) {
  const { calibration } = props;
  return (
    <section className="card" aria-label="Calibration parameters">
      <div className="card-title">Calibration parameters</div>
      {"error" in calibration ? (
        <p role="alert">The single-run summaries could not be read: {calibration.error}</p>
      ) : (
        <>
          <p className="card-desc">Each run&apos;s calibration arm as its single-run summary carries it, every value verbatim. Hull-White carries a and sigma; BGM carries the six Rebonato values, and on a calibrated arm the displacement and the CEV exponent (cevBeta). A key one arm lacks reads not in that run.</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Parameter</th>
                  <th scope="col">Run A</th>
                  <th scope="col">Run B</th>
                </tr>
              </thead>
              <tbody>
                {parameterRows(calibration.a, calibration.b).map((r) => (
                  <tr key={r.key}>
                    <th scope="row" className="mono">{r.key}</th>
                    <td className="mono">{r.a}</td>
                    <td className="mono">{r.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="card-foot">Source: GET /api/runs/{props.runA}/stochastic/summary and GET /api/runs/{props.runB}/stochastic/summary, field calibration</p>
    </section>
  );
}

/** The reply's reading notes, verbatim. */
export function StochasticNotes(props: { reply: StochasticCompareReply }) {
  return (
    <section className="card" aria-label="How to read B - A">
      <div className="card-title">How to read B - A</div>
      <ul>
        {props.reply.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </section>
  );
}

/** The page once the run list is read and two runs are chosen, at least one of them stochastic. */
export function StochasticCompareBody(props: { ws: string; runs: RunSummary[]; query: Record<string, string>; compare: LoadState<StochasticCompareReply>; calibration?: CompareCalibration | null; scope?: PickerScope; scopeNote?: string | null; grid?: CompareGrid }) {
  const { a, b, table } = parseCompareQuery(props.query);
  let body;
  if (props.compare.state === "loading") {
    body = <div className="card muted">Reading the stochastic comparison of {a} and {b}</div>;
  } else if (props.compare.state === "error") {
    body = <div className="card" role="alert">{errText(props.compare.error)}</div>;
  } else {
    const reply = props.compare.value;
    body = (
      <>
        <section className="card" aria-label="Comparison">
          <div className="card-title">
            Stochastic distributions: run A <span className="mono">{reply.runA}</span>, run B <span className="mono">{reply.runB}</span>
          </div>
          <p>Each row is a statistic of one run's Monte Carlo path set as its envelope stores it; B - A is derived by the server. Download CSV writes the same reply at full precision under a stochastic provenance header.</p>
          <p><a className="btn" href={stochasticCompareCsvUrl(reply.runA, reply.runB)}>Download CSV</a></p>
        </section>
        {STOCHASTIC_TABLES.map((t) => <DistributionTable key={t.key} title={t.title} block={reply[t.key]} />)}
        <p className="card-foot">Source: GET /api/compare/stochastic (the two stored envelopes aligned by the server; every B - A and the standard-error figure are derived there)</p>
        <StochasticContextCard reply={reply} />
        {props.calibration === undefined || props.calibration === null ? null : <CalibrationParametersCard runA={reply.runA} runB={reply.runB} calibration={props.calibration} />}
        <StochasticNotes reply={reply} />
      </>
    );
  }
  return (
    <>
      <RunPickers ws={props.ws} runs={props.runs} a={a} b={b} table={table} query={props.query} scope={props.scope} scopeNote={props.scopeNote} />
      {props.grid === undefined ? null : <CompareGridAsOf a={a} b={b} grid={props.grid} />}
      {body}
    </>
  );
}
