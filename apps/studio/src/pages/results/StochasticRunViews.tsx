// apps/studio/src/pages/results/StochasticRunViews.tsx
/**
 * Stochastic distributions views: one stored Monte Carlo envelope,
 * read through GET /api/runs/:id/stochastic/summary. A row is a statistic of
 * the run's path set, never an EVE or an NII; every value, the context and the
 * calibration gate state are printed as the reply carries them. Nothing here
 * does arithmetic on a result value. The head names the rate model
 * the context row stores, the gate card prints the server's text verbatim, and
 * the Calibration card prints the summary's `calibration` field (either model).
 */
import type { NotImplemented, StochasticCalibrationSummary } from "@alm/engine";
import { INFORMATIONAL_LAYERS } from "./informational";
import {
  stochasticSummaryCsvUrl,
  type RunSummary,
  type StochasticCalibrationGate,
  type StochasticSummaryContextRow,
  type StochasticSummaryRow,
} from "@alm/reader";
import { contextText, statLabel, STOCHASTIC_TABLES } from "../../compare/compareModel";
import {
  calibrationEntries,
  calibrationLead,
  gateChip,
  gateLine,
  modelText,
  stochasticHref,
  stochasticRunRows,
  statText,
  subsetText,
  summaryModel,
} from "../../results/stochasticRun";
import type { StochasticData } from "./loadStochastic";
import { runCurveLine } from "../../results/curveLine";
import { gapViewOf } from "../../results/stochasticGap";
import { StochasticGapCard } from "./StochasticGapCard";

/** One distribution: a row per stored statistic with its value. */
export function StochasticRunTable(props: { title: string; rows: StochasticSummaryRow[] }) {
  return (
    <section className="card" aria-label={props.title}>
      <div className="card-title">{props.title}</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Statistic</th>
              <th scope="col" className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={`${row.stat}-${String(row.p)}`}>
                <th scope="row">{statLabel(row)}</th>
                <td className="num" title={String(row.value)}>{statText(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The calibration gate as the envelope records it; nothing is compared here. */
export function StochasticGateCard(props: { gate: StochasticCalibrationGate }) {
  const chip = gateChip(props.gate.state);
  return (
    <section className="card" aria-label="Calibration gate">
      <div className="card-title">Calibration gate</div>
      <p><span className={chip.className}>{chip.text}</span> {gateLine(props.gate)}</p>
      <p className="card-desc">{props.gate.text}</p>
    </section>
  );
}

/** The summary's `calibration` field, the envelope's calibration arm verbatim, for either model (slice two decision 93). */
export function StochasticCalibrationCard(props: { calibration: StochasticCalibrationSummary }) {
  const subset = subsetText(props.calibration);
  return (
    <section className="card" aria-label="Calibration">
      <div className="card-title">Calibration</div>
      <p className="card-desc">{calibrationLead(props.calibration)}</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {calibrationEntries(props.calibration).map((e) => (
              <tr key={e.key}>
                <th scope="row" className="mono">{e.key}</th>
                <td className="mono">{e.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {subset === null ? null : <p className="card-desc">Subset the fit used (expiry x tenor, years): {subset}</p>}
    </section>
  );
}

/** The run's stored context fields, verbatim. */
export function StochasticRunContextCard(props: { context: StochasticSummaryContextRow[] }) {
  return (
    <section className="card" aria-label="Run context">
      <div className="card-title">Run context</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {props.context.map((c) => (
              <tr key={c.field}>
                <th scope="row" className="mono">{c.field}</th>
                <td className="mono">{contextText(c.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The envelope's notImplemented tags, verbatim. */
export function StochasticNotBuilt(props: { tags: NotImplemented[] }) {
  return (
    <section className="card plan-notes" aria-label="Not built in this mode">
      <div className="card-title">Not built in this mode</div>
      {props.tags.length === 0 ? (
        <p>None: the envelope lists no refusal.</p>
      ) : (
        <ul className="nimpl-list">
          {props.tags.map((t, i) => (
            <li key={i}><span className="status status-unobs">{INFORMATIONAL_LAYERS.has(t.layer) ? "○ Informational" : "○ Not implemented"}</span> <span className="mono">{t.layer}</span> {t.reason}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The reply's reading notes, verbatim. */
export function StochasticRunNotes(props: { notes: string[] }) {
  return (
    <section className="card" aria-label="How to read these statistics">
      <div className="card-title">How to read these statistics</div>
      <ul>
        {props.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </section>
  );
}

/**
 * The page once the run is read: the summary's cards, or the No result card with why. The Gap
 * distributions card, only when the reply carries the stored `gap` block; `query` carries its `stogap` view.
 */
export function StochasticRunBody(props: { runId: string; data: StochasticData; query?: Record<string, string> }) {
  const { detail, summary, note } = props.data;
  const curve = summary?.curve ?? detail.curve;
  if (summary === null) {
    return (
      <section className="card unobs-panel" aria-label="No result"><span className="status status-unobs">No result</span><p className="unobs-text">{note}</p></section>
    );
  }
  const model = summaryModel(summary.context);
  return (
    <>
      <section className="card" aria-label="Stochastic run">
        <div className="card-title">
          Stochastic distributions: run <span className="mono">{props.runId}</span>
        </div>
        {/* The curve the run built on: the summary's line, else the run detail's. */}
        <p className="run-curve">{runCurveLine(curve === undefined ? { state: detail.state } : { state: detail.state, curve })}</p>
        <p className="run-model">Rate model: {modelText(model)} {model === null ? null : <span className="mono">{model}</span>}</p>
        <p>Each row is a statistic of this run's Monte Carlo path set as its envelope stores it, never an EVE or an NII. Download CSV writes the same rows at full precision under a stochastic provenance header.</p>
        <p><a className="btn" href={stochasticSummaryCsvUrl(props.runId)}>Download CSV</a></p>
      </section>
      <StochasticGateCard gate={summary.calibrationGate} />
      {/* A reply from a server before slice two carries no calibration field, and so no card. */}
      {(summary.calibration as StochasticCalibrationSummary | undefined) === undefined ? null : <StochasticCalibrationCard calibration={summary.calibration} />}
      {STOCHASTIC_TABLES.map((t) => <StochasticRunTable key={t.key} title={t.title} rows={summary[t.key].rows} />)}
      <p className="card-foot">Source: GET /api/runs/{props.runId}/stochastic/summary (the run's stored envelope, read by the server; every value verbatim, none derived)</p>
      {summary.gap === undefined ? null : <StochasticGapCard runId={props.runId} gap={summary.gap} gate={summary.calibrationGate} view={gapViewOf(props.query)} />}
      <StochasticRunContextCard context={summary.context} />
      <StochasticNotBuilt tags={summary.notImplemented} />
      <StochasticRunNotes notes={summary.notes} />
    </>
  );
}

/** No run picked: the done stochastic runs, newest first, each linked to this layer. */
export function StochasticRunIndexView(props: { ws: string; runs: RunSummary[] }) {
  const rows = stochasticRunRows(props.runs);
  if (rows.length === 0) {
    return (
      <section className="card unobs-panel" aria-label="Stochastic runs">
        <span className="status status-unobs">No stochastic run</span>
        <p className="unobs-text">No done stochastic run. Studio does not run stochastic runs; submit one in stochastic mode on the workbench Run page.</p>
      </section>
    );
  }
  return (
    <section className="card" aria-label="Stochastic runs">
      <div className="card-title">Done stochastic runs</div>
      <ul className="run-list">
        {rows.map((r) => (
          <li key={r.runId}>
            <a className="btn btn-quiet btn-flush mono" href={stochasticHref(props.ws, r.runId)}>{r.runId}</a>
            <span className="muted">{r.label ?? ""}</span>
            <span className="num muted">{r.submittedAt}</span>
          </li>
        ))}
      </ul>
      <p className="card-foot">Source: /api/runs, state done, mode stochastic</p>
    </section>
  );
}
