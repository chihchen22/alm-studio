import type { EVEResult } from "@alm/engine";
import { eveHasDerivatives } from "@alm/reader";
import { signClass, signedMM, signedPct, usdMM, years } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

/**
 * EVE by scenario: PV of assets and liabilities, EVE, delta vs base, and the
 * effective duration of equity. The duration is shown only when the run's sanity
 * gate passed; a rejected duration is flagged, never presented as trusted (the
 * Lab rule that a surprising duration is a finding, not a number to display).
 */
export function EveTable({ eve }: { eve: EVEResult }) {
  const scenarioLabel = useScenarioLabel();
  const withDerivatives = eveHasDerivatives(eve);
  return (
    <section className="panel">
      <h2>Economic Value of Equity</h2>
      <p className="desc">
        PV assets minus PV liabilities per scenario, discounted on the {eve.discountBasis} basis
        {withDerivatives ? ", plus PV derivatives, which swap legs always discount on the risk-free curve" : ""}, with change
        versus base.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th>PV assets</th>
              <th>PV liabilities</th>
              {withDerivatives ? <th>PV derivatives (risk-free)</th> : null}
              <th>EVE</th>
              <th>&Delta; EVE</th>
              <th>&Delta; EVE %</th>
              <th>Eff. dur. equity</th>
            </tr>
          </thead>
          <tbody>
            {eve.byScenario.map((s) => (
              <tr key={s.scenarioId}>
                <td>{scenarioLabel(s.scenarioId)}</td>
                <td className="num">{usdMM(s.pvAssets)}</td>
                <td className="num">{usdMM(s.pvLiabilities)}</td>
                {withDerivatives ? <td className="num">{s.pvDerivatives === undefined ? "n/a" : signedMM(s.pvDerivatives)}</td> : null}
                <td className="num">{usdMM(s.eve)}</td>
                <td className={`num ${signClass(s.deltaEveVsBase)}`}>{signedMM(s.deltaEveVsBase)}</td>
                <td className={`num ${signClass(s.deltaEvePct)}`}>{signedPct(s.deltaEvePct)}</td>
                <td className="num">
                  {s.durationSanityPassed && s.effectiveDurationEquity !== undefined ? (
                    years(s.effectiveDurationEquity)
                  ) : s.durationSanityPassed ? (
                    <span className="muted" title="Not computed: base-only durationMode measures durations at the base environment only">
                      n/a (base-only)
                    </span>
                  ) : (
                    <span className="flag" title="Duration sanity gate did not pass; value not trusted">
                      flagged
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="footnote">
        Effective duration of equity is reported only where the sign/magnitude sanity gate passed. Where it did
        not, the cell reads &ldquo;flagged&rdquo; rather than surfacing an untrusted number; where base-only
        durationMode simply did not compute it, the cell reads &ldquo;n/a (base-only)&rdquo;.
      </p>
    </section>
  );
}
