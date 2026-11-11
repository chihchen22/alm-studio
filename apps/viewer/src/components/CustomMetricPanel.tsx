/**
 * The Metrics tab. One section per custom metric on the envelope:
 * a scenario-by-key table, one small bar chart per key (one hue, no legend;
 * the caption names the key), and the selected scenario's family rows in a
 * collapsed details block. Every number passes through formatValue unchanged;
 * a value the metric left out is the word "unobservable", never 0.
 * Table headers are key ids; the full label rides on the th title attribute.
 */
import type { CustomMetricKey, CustomMetricResult } from "@alm/engine";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { UNOBSERVABLE, familyRows, formatValue, keyBars, scenarioRows, unitSuffix, type MetricRow } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

const GRID_STROKE = "color-mix(in srgb, var(--muted) 25%, transparent)";
const CHART_H = 200;
const CHART_MIN_W = 260;
const Y_AXIS_W = 78;

const TOOLTIP_STYLE = {
  background: "var(--panel)",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  fontSize: 12,
} as const;

export function CustomMetricPanel({
  custom,
  scenario,
}: {
  /** result.custom, already known non-empty by the caller. */
  custom: Record<string, CustomMetricResult>;
  /** The Results page's selected scenario id; picks the family details block. */
  scenario: string;
}) {
  return (
    <>
      {Object.entries(custom).map(([id, m]) => (
        <MetricSection key={id} m={m} scenario={scenario} />
      ))}
    </>
  );
}

function headerText(k: CustomMetricKey): string {
  const s = unitSuffix(k.unit);
  return s === "" ? k.id : `${k.id} (${s})`;
}

function MetricSection({ m, scenario }: { m: CustomMetricResult; scenario: string }) {
  const scenarioLabel = useScenarioLabel();
  const rows = scenarioRows(m);
  const fam = familyRows(m, scenario);
  const notCharted = m.keys.filter((k) => keyBars(m, k.id).length === 0).map((k) => k.id);

  return (
    <section className="panel">
      <h2>{m.label}</h2>
      <p className="desc">
        Custom metric {m.metricId}: {m.keys.length} keys, one row per scenario. A value the metric did not
        observe is shown as unobservable, never as 0.
      </p>

      <MetricTable m={m} firstHeader="Scenario" rows={rows} labelOf={scenarioLabel} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 16 }}>
        {m.keys.map((k) => {
          const bars = keyBars(m, k.id);
          if (bars.length === 0) return null;
          const data = bars.map((b) => ({ name: scenarioLabel(b.scenarioId), value: b.value }));
          return (
            <div key={k.id} style={{ minWidth: CHART_MIN_W, flex: `1 1 ${CHART_MIN_W}px` }}>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{k.label}</div>
              <div style={{ width: "100%", height: CHART_H }}>
                <ResponsiveContainer>
                  <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                    <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--muted)" }} />
                    <YAxis
                      tickFormatter={(v: number) => formatValue(k.unit, v)}
                      tick={{ fontSize: 11, fill: "var(--muted)" }}
                      width={Y_AXIS_W}
                    />
                    <Tooltip
                      cursor={{ fill: "color-mix(in srgb, var(--muted) 12%, transparent)" }}
                      formatter={(v: unknown) => [formatValue(k.unit, Number(v)), k.label]}
                      contentStyle={TOOLTIP_STYLE}
                    />
                    <Bar dataKey="value" fill="var(--series-1)" isAnimationActive={false} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>
      {notCharted.length > 0 ? (
        <p className="footnote">Not charted, unobservable at scenario grain: {notCharted.join(", ")}.</p>
      ) : null}

      {fam === null ? (
        <p className="footnote">No family rows for {scenarioLabel(scenario)}.</p>
      ) : (
        <details className="values">
          <summary>
            Family rows, {scenarioLabel(scenario)} ({fam.length} families)
          </summary>
          <MetricTable m={m} firstHeader="Family" rows={fam} labelOf={(id) => id} />
        </details>
      )}
    </section>
  );
}

function MetricTable({
  m,
  firstHeader,
  rows,
  labelOf,
}: {
  m: CustomMetricResult;
  firstHeader: string;
  rows: MetricRow[];
  labelOf: (id: string) => string;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>{firstHeader}</th>
            {m.keys.map((k) => (
              <th key={k.id} title={k.label}>
                {headerText(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{labelOf(row.id)}</td>
              {row.values.map((v, i) => (
                <td key={m.keys[i].id} className="num">
                  {v === null ? <span className="muted">{UNOBSERVABLE}</span> : formatValue(m.keys[i].unit, v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
