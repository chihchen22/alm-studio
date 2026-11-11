// apps/studio/src/pages/results/MetricsTab.tsx
/**
 * Metrics tab (Studio S3a): the envelope's custom metrics, laid out by
 * declared key order and formatted by declared unit (customMetricRows). A key
 * a row leaves out prints "unobservable" with the reason as its title, never 0.
 * Each key's stored id is painted under its label.
 */
import type { CustomMetricResult } from "@alm/engine";
import { familyRows, formatValue, scenarioRows, UNOBSERVABLE, unitSuffix, type MetricRow } from "@alm/reader";
import { blockOf, NotInRun, ScenarioPicker, selectedScenario, type TabProps } from "./common";

export const NO_CUSTOM_BLOCK =
  "The envelope carries no custom block: the engine writes one only when a custom metric stage published a result, and no custom metric stage published a result in this run.";

const absentReason = (keyId: string) =>
  `The metric left key ${keyId} out of this row: it could not observe that value, and the engine never writes 0 in its place`;

function MetricTable(props: { m: CustomMetricResult; rows: MetricRow[]; head: string; label: (id: string) => string }) {
  const { m } = props;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{props.head}</th>
            {m.keys.map((k) => (
              <th scope="col" key={k.id} className="num">
                {k.label}{unitSuffix(k.unit) === "" ? "" : ` (${unitSuffix(k.unit)})`} <span className="mono muted">{k.id}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{props.label(r.id)}</th>
              {r.values.map((v, i) => {
                const k = m.keys[i]!;
                return (
                  <td key={k.id} className="num">
                    {v === null ? <span className="status status-unobs" title={absentReason(k.id)}>{UNOBSERVABLE}</span> : formatValue(k.unit, v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricCard(props: { m: CustomMetricResult; scenarioId: string | null; label: (id: string) => string }) {
  const { m, scenarioId } = props;
  const fam = scenarioId === null ? null : familyRows(m, scenarioId);
  return (
    <section className="card table-card" aria-label={m.label}>
      <div className="card-title">{m.label} <span className="mono muted">{m.metricId}</span></div>
      <MetricTable m={m} rows={scenarioRows(m)} head="Scenario" label={props.label} />
      {scenarioId === null ? null : fam !== null ? (
        <>
          <p className="card-desc">By family, {props.label(scenarioId)}</p>
          <MetricTable m={m} rows={fam} head="Family" label={(id) => id} />
        </>
      ) : (
        <p className="card-desc muted">No family rows are stored for {props.label(scenarioId)}: the metric reports no family grain for this scenario (byFamily absent).</p>
      )}
      <p className="card-foot">Source: result.custom[{m.metricId}]</p>
    </section>
  );
}

export function MetricsTab(p: TabProps) {
  const custom = blockOf(p.result, "custom");
  const metrics = custom === undefined ? [] : Object.values(custom);
  if (metrics.length === 0) return <NotInRun title="Metrics" reason={NO_CUSTOM_BLOCK} />;
  const ids = metrics[0]!.byScenario.map((s) => s.scenarioId);
  const sel = selectedScenario(ids, p.query);
  return (
    <>
      {sel === null ? null : <ScenarioPicker ws={p.ws} ids={ids} selected={sel} query={p.query} label={p.scenarioLabel} />}
      {metrics.map((m) => <MetricCard key={m.metricId} m={m} scenarioId={sel} label={p.scenarioLabel} />)}
    </>
  );
}
