// apps/studio/src/pages/results/LensesTab.tsx
/**
 * Lenses tab (Studio S3a): GET /api/runs/:id/lenses. Value, limit, headroom
 * and basis per constraint as returned; an unobservable constraint shows its
 * reason and no number, and each of its blank cells carries the reason as its
 * title. One refused lens refuses the whole call (a server rule), and the
 * refusal prints verbatim.
 */
import { Fragment } from "react";
import { getRunLenses, sig, signedPct } from "@alm/reader";
import { errText } from "../../errText";
import { headroomText, lensRows, lensStatusClass, paramsText, type LensReadingView, type LensRow } from "../../results/lensRows";
import { useLoad } from "../../useLoad";
import type { TabProps } from "./common";

export const NO_LENS_HEADLINE =
  "No lens headline is stored: no scenario has an observable constraint with a nonzero limit (fraction basis), and the engine sets the headline from those only";

export const NO_SCENARIO_HEADLINE =
  "No headline is stored for this scenario: it has no observable constraint with a fraction basis (a nonzero limit), and the engine sets a scenario headline from those only";

/** Each scenario's stored roll-up: status, and the headline at its worst constraint when both are stored. */
function ScenarioRollups(props: { reading: LensReadingView; label: (id: string) => string }) {
  return (
    <dl className="kv" aria-label="Scenario roll-ups">
      {props.reading.byScenario.map((s) => (
        <Fragment key={s.scenarioId}>
          <dt>{props.label(s.scenarioId)}</dt>
          <dd>
            <span className={lensStatusClass(s.status)}>{s.status}</span>{" "}
            {s.headline !== undefined && s.worstConstraintId !== undefined ? (
              <>min headroom <span className="num">{signedPct(s.headline)}</span> at constraint <span className="mono">{s.worstConstraintId}</span></>
            ) : (
              <><span className="status status-unobs" title={NO_SCENARIO_HEADLINE}>Unobservable</span> <span className="muted">{NO_SCENARIO_HEADLINE}.</span></>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** A cell the reading leaves empty for this row: no number, the reason as its title. */
function BlankCell(props: { row: LensRow; className?: string }) {
  return <td className={props.className} title={props.row.reason ?? "absent from the lens reading"}></td>;
}

function LensHeadline(props: { reading: LensReadingView; label: (id: string) => string }) {
  const r = props.reading;
  if (r.headline === undefined) {
    return <p className="card-desc">Min headroom vs limit: <span className="status status-unobs" title={NO_LENS_HEADLINE}>Unobservable</span> <span className="muted">{NO_LENS_HEADLINE}.</span></p>;
  }
  return (
    <p className="card-desc">
      Min headroom vs limit, fraction basis: <span className="num">{signedPct(r.headline)}</span>
      {r.worst !== undefined ? <> at {props.label(r.worst.scenarioId)}, constraint <span className="mono">{r.worst.constraintId}</span></> : null}
    </p>
  );
}

export function LensCard(props: { reading: LensReadingView; label: (id: string) => string }) {
  const r = props.reading;
  return (
    <section className="card table-card" aria-label={`Lens ${r.lensId}`}>
      <div className="card-title"><span className="mono">{r.lensId}</span> <span className={lensStatusClass(r.status)}>{r.status}</span></div>
      <p className="card-desc">Objective {r.objective}; base scenario {r.baseScenarioId}.</p>
      <LensHeadline reading={r} label={props.label} />
      <ScenarioRollups reading={r} label={props.label} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Scenario</th><th scope="col">Constraint</th><th scope="col">Reader</th><th scope="col">Test</th><th scope="col" className="num">Value</th><th scope="col" className="num">Headroom</th><th scope="col">Basis</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {lensRows(r).map((row) => (
              <tr key={`${row.scenarioId}:${row.constraintId}`}>
                <th scope="row">{props.label(row.scenarioId)}</th>
                <td className="mono">{row.constraintId}</td>
                <td className="mono">{row.reader}{row.params !== undefined ? <span className="muted"> {paramsText(row)}</span> : null}</td>
                <td className="num">{row.op} {sig(row.limit)}</td>
                {row.value === null ? <BlankCell row={row} className="num" /> : <td className="num">{sig(row.value)}</td>}
                {row.headroom === null ? <BlankCell row={row} className="num" /> : <td className="num">{headroomText(row)}</td>}
                {row.basis === null ? <BlankCell row={row} /> : <td>{row.basis}</td>}
                <td><span className={lensStatusClass(row.status)}>{row.status}</span>{row.reason !== null ? <span className="muted"> {row.reason}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function LensesTab(p: TabProps) {
  const load = useLoad(() => getRunLenses(p.runId), [p.runId]);
  if (load.state === "loading") return <div className="card muted">Reading the lenses for {p.runId}</div>;
  if (load.state === "error") {
    return <section className="card plan-banner" role="alert"><div><span className="status status-breach">✕ Lenses refused</span> {errText(load.error)}</div></section>;
  }
  if (load.value.lenses.length === 0) {
    return (
      <section className="card unobs-panel" aria-label="Lenses">
        <span className="status status-unobs">Unobservable</span>
        <p className="unobs-text">The store holds no lens definition, so /api/runs/{p.runId}/lenses returned none.</p>
      </section>
    );
  }
  return (
    <>
      {load.value.lenses.map((l) => <LensCard key={l.lensId} reading={l} label={p.scenarioLabel} />)}
      <p className="card-foot">Source: /api/runs/{p.runId}/lenses, base scenario {load.value.baseScenarioId}</p>
    </>
  );
}
