import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Waterfall } from "@alm/reader";
import { driverLabel, signedMM, usdMM } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

type Row = {
  name: string;
  offset: number;
  bar: number;
  amount: number;
  kind: "anchor" | "pos" | "neg";
};

/**
 * Lay out one headline's decomposition as waterfall bars. The financial amounts
 * (base, per-driver steps, residual, scenario) all come from the engine; the
 * running offsets computed here are chart geometry for stacking floating bars,
 * not a recomputation of any balance-sheet figure.
 */
function layout(w: Waterfall): Row[] {
  const rows: Row[] = [];
  rows.push({ name: "Base", offset: 0, bar: w.baseValue, amount: w.baseValue, kind: "anchor" });
  let running = w.baseValue;
  for (const step of w.steps) {
    const after = running + step.amount;
    rows.push({
      name: driverLabel(step.driver),
      offset: Math.min(running, after),
      bar: Math.abs(step.amount),
      amount: step.amount,
      kind: step.amount >= 0 ? "pos" : "neg",
    });
    running = after;
  }
  // Reconcile to the scenario value: scenarioValue = base + sum(steps) - residual.
  const resStep = -w.residual;
  const afterRes = running + resStep;
  rows.push({
    name: "Residual",
    offset: Math.min(running, afterRes),
    bar: Math.abs(resStep),
    amount: resStep,
    kind: resStep >= 0 ? "pos" : "neg",
  });
  rows.push({ name: "Scenario", offset: 0, bar: w.scenarioValue, amount: w.scenarioValue, kind: "anchor" });
  return rows;
}

const FILL: Record<Row["kind"], string> = {
  anchor: "var(--accent)",
  pos: "var(--pos)",
  neg: "var(--neg)",
};

const METRICS: Array<Waterfall["metric"]> = ["eve", "nii-12m", "nii-24m"];
const METRIC_LABEL: Record<Waterfall["metric"], string> = {
  eve: "EVE",
  "nii-12m": "NII 12M",
  "nii-24m": "NII 24M",
};

export function AttributionWaterfall({ waterfalls }: { waterfalls: Waterfall[] }) {
  const scenarioLabel = useScenarioLabel();
  const scenarios = useMemo(
    () => Array.from(new Set(waterfalls.map((w) => w.scenarioId))),
    [waterfalls],
  );
  const [metric, setMetric] = useState<Waterfall["metric"]>("eve");
  const [scenario, setScenario] = useState<string>(scenarios[0] ?? "");

  const w = waterfalls.find((x) => x.metric === metric && x.scenarioId === scenario);
  const rows = w ? layout(w) : [];

  return (
    <section className="panel">
      <h2>Attribution waterfall</h2>
      <p className="desc">
        Decomposition of one headline delta versus base into per-driver contributions, with the unexplained
        residual carried explicitly. Under a static parallel shock the rate driver carries the move; other
        drivers are zero because behavior is held fixed across the grid.
      </p>

      <div className="controls">
        {METRICS.map((m) => (
          <button key={m} className={m === metric ? "active" : ""} onClick={() => setMetric(m)}>
            {METRIC_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="controls">
        {scenarios.map((s) => (
          <button key={s} className={s === scenario ? "active" : ""} onClick={() => setScenario(s)}>
            {scenarioLabel(s)}
          </button>
        ))}
      </div>

      {w ? (
        <>
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ top: 8, right: 12, left: 12, bottom: 8 }}>
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: "var(--muted)" }} />
                <YAxis
                  tickFormatter={(v: number) => usdMM(v)}
                  tick={{ fontSize: 11, fill: "var(--muted)" }}
                  width={78}
                />
                <Tooltip
                  cursor={{ fill: "color-mix(in srgb, var(--muted) 12%, transparent)" }}
                  formatter={(_v, _n, item) => {
                    const r = item?.payload as Row;
                    return [r.kind === "anchor" ? usdMM(r.amount) : signedMM(r.amount), r.name];
                  }}
                  contentStyle={{
                    background: "var(--panel)",
                    border: "1px solid var(--line-strong)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="offset" stackId="w" fill="transparent" isAnimationActive={false} />
                <Bar dataKey="bar" stackId="w" isAnimationActive={false}>
                  {rows.map((r, i) => (
                    <Cell key={i} fill={FILL[r.kind]} />
                  ))}
                  <LabelList
                    dataKey="amount"
                    position="top"
                    formatter={(v: number) => signedMM(v)}
                    style={{ fontSize: 10, fill: "var(--muted)" }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="footnote">
            {METRIC_LABEL[metric]} {scenarioLabel(scenario)}: total &Delta; {signedMM(w.totalDelta)}, residual{" "}
            {signedMM(w.residual)} (sum of contributions minus total delta, reported not hidden).
          </p>
        </>
      ) : (
        <p className="emptynote">No attribution headline for this selection.</p>
      )}
    </section>
  );
}
