import type { BucketedCashflowResult } from "@alm/engine";
import { usdMM, years } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

const ANCHORS = [0, 12, 24, 60, 120, 240];

/**
 * Compact balance runoff for the selected scenario, read from the COA roll-up
 * nodes the engine already summed (total assets and total liabilities+equity).
 * No family balances are summed on the client; the roll-up series are taken
 * verbatim, sampled at a few month anchors plus the terminal bucket.
 */
export function CashflowRunoff({
  cashflows,
  selected,
}: {
  cashflows: BucketedCashflowResult;
  selected: string;
}) {
  const scenarioLabel = useScenarioLabel();
  const scen =
    cashflows.byScenario.find((s) => s.scenarioId === selected) ?? cashflows.byScenario[0];
  const horizon = cashflows.grid.horizonMonths;
  const last = horizon - 1;
  const assets = scen.byCoaNode.find((n) => n.coaNodeId === "coa-assets");
  const liab = scen.byCoaNode.find((n) => n.coaNodeId === "coa-liab-equity");

  const cols = [...ANCHORS.filter((m) => m <= last), last];
  const rows: Array<{ label: string; series: number[] | undefined }> = [
    { label: "Total assets", series: assets?.series.balance },
    { label: "Total liabilities & equity", series: liab?.series.balance },
  ];

  return (
    <section className="panel">
      <h2>Balance runoff</h2>
      <p className="desc">
        {scenarioLabel(scen.scenarioId)} scenario. Outstanding balance at the start of each bucket, sampled from
        the engine COA roll-up over the {horizon}-month horizon.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Roll-up</th>
              {cols.map((m) => (
                <th key={m}>{m === last ? `M${last} (terminal)` : `M${m}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                {cols.map((m) => (
                  <td key={m} className="num">
                    {r.series ? usdMM(r.series[m]) : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="desc" style={{ marginTop: 16 }}>
        Family weighted average life: the engine&rsquo;s principal-runoff WAL of each family&rsquo;s
        projected in-horizon principal, years from as-of, verbatim. For positions outliving the horizon it is
        the WAL of the in-horizon runoff only (disclosed by the engine, not extrapolated here).
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Family</th>
              <th>WAL (years)</th>
            </tr>
          </thead>
          <tbody>
            {scen.byFamily.map((f) => (
              <tr key={f.familyId}>
                <td>{f.familyId}</td>
                <td className="num">
                  {f.walYears !== undefined ? (
                    years(f.walYears)
                  ) : (
                    <span
                      className="muted"
                      title="The family's in-horizon principal total is not positive, or the envelope predates schemaVersion 1.2.0. An empty family has no WAL; the engine does not print 0 where undefined is the truth."
                    >
                      n/a (no in-horizon principal, or pre-1.2.0 envelope)
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
