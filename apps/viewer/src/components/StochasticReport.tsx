/**
 * Stochastic distribution report: renders the verbatim
 * StochasticRunResult envelope as a TABLE. A fan chart is a
 * declared stretch, not this wave.
 *
 * Honesty rules, enforced by construction:
 *  - This page renders ONLY the stochastic envelope. No deterministic figure
 *    appears anywhere on it, so a distribution mean can never sit beside a
 *    deterministic EVE in a confusable way (the server refuses the cross-reads
 *    typed; this page never even fetches them).
 *  - Every statistic row leads with its path count N and the standard error of
 *    the mean; the mean is labeled a statistic, not an EVE / NII.
 *  - The calibration block renders in full, with the RMSE gate breach flag
 *    (`rmseGateBreached`) surfaced prominently wherever calibration quality
 *    appears — a breach is a disclosure, never absorbed. An override
 *    calibration renders the caller's reason verbatim and is visibly NOT a
 *    market calibration.
 *  - Quantile columns come from the envelope's own quantile list; nothing is
 *    interpolated or extended client-side.
 *  - The envelope's typed refusals render verbatim via NotImplementedPanel.
 *  - Either rate model (envelope 0.3.0): the calibration
 *    block lays out the arm the envelope carries, Hull-White or BGM, calibrated
 *    or override; a BGM run adds its simulation block (guard counts, saved
 *    tenors, fixed cost). A stored 0.2.0 Hull-White envelope renders as before.
 */
import type {
  BgmLongYieldCalibration,
  BgmOverrideCalibration,
  StochasticCalibrationSummary,
  StochasticDistribution,
  StochasticRunResult,
  StochasticSimulationSummary,
} from "@alm/engine";
import { sig, stat } from "@alm/reader";
import { NotImplementedPanel } from "./NotImplementedPanel";

function DistributionRow({ label, d }: { label: string; d: StochasticDistribution }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{d.nPaths.toLocaleString("en-US")}</td>
      <td className="num">{stat(d.mean)}</td>
      <td className="num">{stat(d.standardError)}</td>
      <td className="num">{stat(d.stdev)}</td>
      <td className="num">{stat(d.min)}</td>
      {d.quantiles.map((q) => (
        <td key={q.p} className="num">
          {stat(q.value)}
        </td>
      ))}
      <td className="num">{stat(d.max)}</td>
    </tr>
  );
}

/** The RMSE gate line of a calibrated arm: a breach is flagged, never absorbed. */
function GateLine({ rmseBp, rmseGateBp, breached, why }: { rmseBp: number; rmseGateBp: number; breached: boolean; why: string }) {
  return breached ? (
    <p>
      <span className="flag" title={why}>
        RMSE gate BREACHED: {sig(rmseBp)} bp vs the {rmseGateBp} bp gate
      </span>
    </p>
  ) : (
    <p className="emptynote">RMSE gate passed: {sig(rmseBp)} bp vs the {rmseGateBp} bp gate.</p>
  );
}

/** The six Rebonato columns, envelope key names, in envelope order. */
const REBONATO_HEADS = ["a", "b", "c", "d", "beta", "volScalar"] as const;

function RebonatoCells({ p }: { p: BgmLongYieldCalibration | BgmOverrideCalibration }) {
  return (
    <>
      {REBONATO_HEADS.map((k) => (
        <td key={k} className="num">
          {sig(p[k])}
        </td>
      ))}
    </>
  );
}

const REBONATO_FORM = (
  <p className="footnote">
    Rebonato two-factor volatility of the forward resetting at T, at time t with tau = T - t: sigma(t) =
    volScalar &times; ((a + b tau) e<sup>-c tau</sup> + d), with the two factor loadings at angle beta tau, so
    two forwards correlate as cos(beta (T<sub>i</sub> - T<sub>j</sub>)). The forward is shifted-CEV: its
    volatility scales with (F + displacement)<sup>CEV exponent</sup>.
  </p>
);

/**
 * The calibration arm the envelope carries, for either model. Hull-White: the calibrated arm with its
 * 5 bp gate, or the caller's override. BGM: the calibrated arm on the long-yield volatility surface with
 * its 10 bp gate and the subset it used, or the caller's override (told apart by its `model` key).
 */
function CalibrationBlock({ cal }: { cal: StochasticCalibrationSummary }) {
  if (cal.source === "cap-atm-calibration") {
    return (
      <>
        <p className="desc">
          Hull-White parameters calibrated to the at-the-money column of the short-rate volatility surface of
          the snapshot. Fit quality is judged against the {cal.rmseGateBp} bp gate and a breach is surfaced,
          never absorbed.
        </p>
        <GateLine
          rmseBp={cal.rmseBp}
          rmseGateBp={cal.rmseGateBp}
          breached={cal.rmseGateBreached}
          why="The fit RMSE exceeds the acceptance gate. Surfaced by the engine as a disclosure; a one-factor model can legitimately fit above the gate on a steep short-rate volatility term structure."
        />
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>a (mean reversion, 1/y)</th>
                <th>sigma (normal vol)</th>
                <th>RMSE (bp)</th>
                <th>Gate (bp)</th>
                <th>Gate breached</th>
                <th>Quotes</th>
                <th>Underlying tau (y)</th>
                <th>Iterations</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{cal.source}</td>
                <td className="num">{sig(cal.a)}</td>
                <td className="num">{sig(cal.sigma)}</td>
                <td className="num">{sig(cal.rmseBp)}</td>
                <td className="num">{sig(cal.rmseGateBp)}</td>
                <td>{cal.rmseGateBreached ? "true" : "false"}</td>
                <td className="num">{cal.nQuotes}</td>
                <td className="num">{sig(cal.underlyingTau)}</td>
                <td className="num">{cal.iterations}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </>
    );
  }
  if (cal.source === "long-yield-atm-calibration") {
    return (
      <>
        <p className="desc">
          BGM parameters calibrated to the default subset of the long-yield volatility surface of the snapshot
          ({cal.nQuotes} points). The model is the shifted-CEV LIBOR market model with Rebonato two-factor
          volatility; displacement and the CEV exponent are held fixed at the default engine. Fit quality is
          judged against the {cal.rmseGateBp} bp gate; a breach is reported, never refused.
        </p>
        <GateLine
          rmseBp={cal.rmseBp}
          rmseGateBp={cal.rmseGateBp}
          breached={cal.rmseGateBreached}
          why="The fit RMSE exceeds the acceptance gate. Reported by the engine as a disclosure, never refused: the distributions rest on a fit outside the gate."
        />
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                {REBONATO_HEADS.map((k) => (
                  <th key={k}>{k}</th>
                ))}
                <th>Displacement</th>
                <th>CEV exponent</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{cal.source}</td>
                <RebonatoCells p={cal} />
                <td className="num">{sig(cal.displacement)}</td>
                <td className="num">{sig(cal.cevBeta)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>RMSE (bp)</th>
                <th>Gate (bp)</th>
                <th>Gate breached</th>
                <th>Subset points</th>
                <th>Iterations</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{sig(cal.rmseBp)}</td>
                <td className="num">{sig(cal.rmseGateBp)}</td>
                <td>{cal.rmseGateBreached ? "true" : "false"}</td>
                <td className="num">{cal.nQuotes}</td>
                <td className="num">{cal.iterations}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {REBONATO_FORM}
        <details className="values">
          <summary>Subset points ({cal.subset.length})</summary>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Expiry (y)</th>
                  <th>Tenor (y)</th>
                </tr>
              </thead>
              <tbody>
                {cal.subset.map((pt, i) => (
                  <tr key={i} className="subset">
                    <td className="num">{sig(pt.expiryYears)}</td>
                    <td className="num">{sig(pt.tenorYears)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </>
    );
  }
  if (cal.source === "saved-calibration") {
    // The run used a saved fit; its diagnostics and verdict are the ones it was saved with.
    return (
      <p className="desc">
        {`Saved calibration ${cal.calibrationId} (${cal.model}), fitted on market snapshot ${cal.marketId}: ${cal.rmseBp.toFixed(2)} bp against a ${cal.rmseGateBp} bp gate, ${cal.rmseGateBreached ? `outside its gate (saved with the reason: ${cal.outsideGateReason ?? "none recorded"})` : "within its gate"}. Parameters: ${JSON.stringify(cal.parameters)}.`}
      </p>
    );
  }
  if ("model" in cal) {
    return (
      <>
        <p className="desc">
          <span
            className="flag"
            title="The Rebonato parameters were SUPPLIED by the caller (a verification seam and stress lever), recorded verbatim. This is not a market calibration and carries no fit diagnostics."
          >
            BGM parameters supplied by override, not a market calibration
          </span>
        </p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                {REBONATO_HEADS.map((k) => (
                  <th key={k}>{k}</th>
                ))}
                <th style={{ textAlign: "left" }}>Caller&rsquo;s stated reason (verbatim)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{cal.source}</td>
                <RebonatoCells p={cal} />
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>{cal.reason}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="footnote">
          Displacement and the CEV exponent are not overridable; they stay at the default engine.
        </p>
        {REBONATO_FORM}
      </>
    );
  }
  return (
    <>
      <p className="desc">
        <span className="flag" title="The Hull-White parameters were SUPPLIED by the caller (a verification seam and stress lever), recorded verbatim. This is not a market calibration and carries no fit diagnostics.">
          Parameters supplied by override — not a market calibration
        </span>
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>a (mean reversion, 1/y)</th>
              <th>sigma (normal vol)</th>
              <th style={{ textAlign: "left" }}>Caller&rsquo;s stated reason (verbatim)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{cal.source}</td>
              <td className="num">{sig(cal.a)}</td>
              <td className="num">{sig(cal.sigma)}</td>
              <td style={{ textAlign: "left", whiteSpace: "normal" }}>{cal.reason}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The BGM simulation block (envelope 0.3.0, BGM runs only): the kernel's guard counts, the saved tenors
 * and the fixed cost, verbatim. A guard fire is flagged, never absorbed.
 */
function SimulationBlock({ sim, horizonMonths }: { sim: StochasticSimulationSummary; horizonMonths: number }) {
  const fired = sim.nCapFires > 0 || sim.nFloorFires > 0;
  return (
    <section className="panel">
      <h2>Simulation guards</h2>
      <p className="desc">
        The BGM simulation&rsquo;s safety guards on log-forward excursions, verbatim from the envelope: a fire
        is one evolution clamped at the ceiling or the floor, zero in normal operation. The simulation always
        covers 360 months; this run reads its first {horizonMonths}. The fixed cost is calibration plus
        simulation plus discount reconstruction, timed inside the BGM environment build: a wall-clock reading
        of this run, the one envelope field that is not a function of the inputs and the seed.
      </p>
      {fired ? (
        <p>
          <span className="flag" title="A guard clamped at least one log-forward evolution. Reported by the engine, never absorbed.">
            Simulation guard FIRED: {sim.nCapFires.toLocaleString("en-US")} ceiling and{" "}
            {sim.nFloorFires.toLocaleString("en-US")} floor clamps over {sim.nTotalEvolutions.toLocaleString("en-US")}{" "}
            evolutions
          </span>
        </p>
      ) : null}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Ceiling guard fires</th>
              <th>Floor guard fires</th>
              <th>Forward evolutions</th>
              <th>Fixed cost (ms)</th>
              <th style={{ textAlign: "left" }}>Saved tenors (y)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="num">{sim.nCapFires.toLocaleString("en-US")}</td>
              <td className="num">{sim.nFloorFires.toLocaleString("en-US")}</td>
              <td className="num">{sim.nTotalEvolutions.toLocaleString("en-US")}</td>
              <td className="num">{sig(sim.fixedCostMs)}</td>
              <td style={{ textAlign: "left", whiteSpace: "normal" }}>{sim.savedTenors.map((t) => sig(t)).join(", ")}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function StochasticReport({ sto, jsonUrl }: { sto: StochasticRunResult; jsonUrl: string }) {
  // Column headers come from the envelope's own quantile set (both
  // distributions carry the same pinned list; the EVE row's list names the
  // columns and each row renders its own values in envelope order).
  const quantileHeads = sto.eveDistribution.quantiles.map((q) => `p${Math.round(q.p * 100)}`);
  return (
    <>
      <div className="provbar" style={{ marginTop: 12 }}>
        <span>
          Run <code>{sto.runId}</code>
        </span>
        <span>
          Kind <code>{sto.kind}</code>
        </span>
        <span>
          Schema <code>{sto.schemaVersion}</code>
        </span>
        <span>
          Model <code>{sto.model}</code>
        </span>
        <span>
          Seed <code>{sto.seed}</code>
        </span>
        <span>
          Paths <code>{sto.nPaths}</code>
        </span>
        <span>
          Horizon <code>{sto.horizonMonths}M</code>
        </span>
        <span>
          Discounting <code>{sto.discountBasis}</code>
        </span>
        <span>
          Scenario <code>{sto.scenarioId}</code>
        </span>
      </div>

      <section className="panel" style={{ marginTop: 14 }}>
        <h2>Monte Carlo distributions</h2>
        <p className="desc">
          This run&rsquo;s result is a DISTRIBUTION envelope, not a deterministic result. Every figure below
          is a sample statistic over the stated N paths, shown with the standard error of its mean; the mean
          is a statistic of the path set, <strong>not</strong> an EVE or an NII. All values are verbatim
          envelope fields in dollars.
        </p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Distribution</th>
                <th>N (paths)</th>
                <th>Mean (statistic)</th>
                <th>SE of mean</th>
                <th>Stdev</th>
                <th>Min</th>
                {quantileHeads.map((h) => (
                  <th key={h}>{h}</th>
                ))}
                <th>Max</th>
              </tr>
            </thead>
            <tbody>
              <DistributionRow label="EVE across paths ($)" d={sto.eveDistribution} />
              <DistributionRow label="NII 12M across paths ($)" d={sto.nii12mDistribution} />
            </tbody>
          </table>
        </div>
        <p className="footnote">
          SE is computed over antithetic-pair averages (N/2 independent samples). Quantiles are the
          envelope&rsquo;s pinned set, interpolated between real order statistics by the engine; finer tails
          are refused, never extrapolated. Full envelope: <a href={jsonUrl}>stochastic result (JSON, verbatim)</a>.
        </p>
      </section>

      <section className="panel">
        <h2>Calibration</h2>
        <CalibrationBlock cal={sto.calibration} />
      </section>

      {sto.simulation === undefined ? null : <SimulationBlock sim={sto.simulation} horizonMonths={sto.horizonMonths} />}

      <section className="panel">
        <h2>Martingale diagnostics</h2>
        {sto.model === "bgm-lmm-2f" ? (
          <p className="desc">
            Discount-factor martingale check of this run&rsquo;s own path set, verbatim from the envelope, read on
            the 1-day saved forward of the BGM simulation (the short-rate analog its discounting uses). The raw
            drift is the uncorrected money-market discount factor (trapezoid accrual) against the curve at the
            run horizon; the multiplicative correction absorbs it and the corrected residual is what the
            discounting relies on.
          </p>
        ) : (
          <p className="desc">
            Discount-factor martingale check of this run&rsquo;s own path set, verbatim from the envelope. The
            raw drift is honestly nonzero (the vendored short rate omits the deterministic convexity shift);
            the multiplicative correction absorbs it and the corrected residual is what the discounting relies
            on.
          </p>
        )}
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Corrected max |err| (bp)</th>
                <th>Raw terminal drift (bp)</th>
                <th>Terminal DF SE (antithetic pairs)</th>
                <th>Terminal horizon (y)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{sig(sto.martingale.correctedMaxAbsErrBp)}</td>
                <td className="num">{sig(sto.martingale.rawTerminalErrBp)}</td>
                <td className="num">{sig(sto.martingale.terminalDfStandardError)}</td>
                <td className="num">{sig(sto.martingale.terminalYears)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <NotImplementedPanel tags={sto.notImplemented} />
    </>
  );
}
