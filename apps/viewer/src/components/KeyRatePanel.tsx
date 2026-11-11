/**
 * Key-rate durations panel: renders EVEResult.keyRate
 * verbatim — per-node durations, the sum, the same-machinery parallel
 * reference, the working bump, and the additivity-plus-convergence gate.
 *
 * The gate is PART OF THE NUMBER: both residuals, the halving ratio, and the
 * converged verdict render exactly as the engine measured them; a
 * `converged: false` is shown, never suppressed. This panel is mounted only
 * when the envelope carries the block — key-rate durations are a cost-labeled
 * engine opt-in, and a control never appears for a capability the run did not
 * compute. On amplifier-carrying books the engine refuses the block entirely
 * and emits the typed `eve.key-rate.regime-amplifier` register tag, which the
 * Overview register renders verbatim.
 */
import type { KeyRateResult } from "@alm/engine";
import { sig } from "@alm/reader";

export function KeyRatePanel({ keyRate: k }: { keyRate: KeyRateResult }) {
  const c = k.convergence;
  return (
    <section className="panel">
      <h2>Key-rate durations (opt-in, computed by this run)</h2>
      <p className="desc">
        Equity key-rate durations at the base environment ({k.scenarioId}), {k.discountBasis} basis, tent
        bumps of {k.bumpBp}bp at the curve&rsquo;s own nodes; both legs regenerate per bump. The last node
        stands in for the whole flat-extrapolated long end. Numbers are bump-width-specific: comparing this
        sum against the &plusmn;100bp headline duration is a category error unless the bumps match.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Node tenor (y)</th>
              <th>Equity KRD (y)</th>
            </tr>
          </thead>
          <tbody>
            {k.nodes.map((n) => (
              <tr key={n.tenorYears}>
                <td className="num">{sig(n.tenorYears)}</td>
                <td className="num">{sig(n.duration)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Sum over nodes</td>
              <td className="num">{sig(k.sum)}</td>
            </tr>
            <tr className="total">
              <td>Parallel reference (same machinery, same {k.bumpBp}bp bump)</td>
              <td className="num">{sig(k.parallelReference)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="desc" style={{ marginTop: 14 }}>
        Additivity-plus-convergence gate, measured by the engine and reported with the result:
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Residual at {k.bumpBp}bp (y)</th>
              <th>Residual at {c.halvedBumpBp}bp (y)</th>
              <th>Halving ratio (&asymp;4 is clean 2nd order)</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="num">{sig(c.residualYears)}</td>
              <td className="num">{sig(c.residualYearsAtHalvedBump)}</td>
              <td className="num">
                {c.ratio !== undefined ? (
                  sig(c.ratio)
                ) : (
                  <span
                    className="muted"
                    title="The halved-bump residual is below the negligibility floor; a ratio against ~0 is noise, not a measurement."
                  >
                    n/a (residual below negligibility floor)
                  </span>
                )}
              </td>
              <td>
                {c.converged ? (
                  <span className="flag" style={{ background: "var(--pos)", color: "#fff" }}>converged</span>
                ) : (
                  <span
                    className="flag"
                    title="The residual did not fall at the second-order rate; the engine reports this verdict rather than patching it. The decomposition at this bump is not trustworthy as additive."
                  >
                    NOT converged (reported, never patched)
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
