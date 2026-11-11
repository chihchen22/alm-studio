/**
 * EVE channel decomposition panel: renders EVEResult.channels
 * verbatim. Per shocked scenario: base and shocked full-life EVE, the
 * total delta, the projection (behavioral) and discounting (valuation) legs,
 * and the interaction residual — which is total − projection − discounting BY
 * DEFINITION and is reported as its own column, never absorbed into a channel.
 * Mounted only when the envelope carries the block (a cost-labeled engine
 * opt-in); every figure is an envelope field through the tested formatter.
 */
import type { EveChannelsResult } from "@alm/engine";
import { signClass, signedMM, usdMM } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

export function ChannelsPanel({ channels }: { channels: EveChannelsResult }) {
  const scenarioLabel = useScenarioLabel();
  return (
    <section className="panel">
      <h2>EVE channel decomposition (opt-in, computed by this run)</h2>
      <p className="desc">
        Each shocked scenario&rsquo;s EVE delta regenerated full-life three ways on the {channels.discountBasis}{" "}
        basis: projection leg shocked (behavioral channel), discounting leg shocked (valuation channel), both
        shocked (total). The interaction residual is the projection&ndash;discounting interaction, definitional,
        reported in its own column.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th>EVE base (full-life)</th>
              <th>EVE shocked (full-life)</th>
              <th>Total &Delta;</th>
              <th>Projection &Delta;</th>
              <th>Discounting &Delta;</th>
              <th>Interaction residual</th>
            </tr>
          </thead>
          <tbody>
            {channels.byScenario.map((row) => (
              <tr key={row.scenarioId}>
                <td>{scenarioLabel(row.scenarioId)}</td>
                <td className="num">{usdMM(row.eveBase)}</td>
                <td className="num">{usdMM(row.eveShocked)}</td>
                <td className={`num ${signClass(row.totalDelta)}`}>{signedMM(row.totalDelta)}</td>
                <td className={`num ${signClass(row.projectionDelta)}`}>{signedMM(row.projectionDelta)}</td>
                <td className={`num ${signClass(row.discountingDelta)}`}>{signedMM(row.discountingDelta)}</td>
                <td className={`num ${signClass(row.interactionResidual)}`}>
                  {signedMM(row.interactionResidual)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="footnote">
        Full-life PV: on books outliving the run horizon the total &Delta; here and the horizon-truncated
        headline &Delta;EVE diverge by the tail (disclosed by the engine, not reconciled here).
      </p>
    </section>
  );
}
