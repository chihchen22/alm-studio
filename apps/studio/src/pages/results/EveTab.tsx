// apps/studio/src/pages/results/EveTab.tsx
/**
 * EVE tab (Studio S3a): result.eve as stored, with key-rate durations and the
 * channel decomposition only when the envelope carries them. The equity
 * duration cell shows one of four stored states: the value; "n/a (base-only)"
 * when base-only durationMode computed none for the scenario; the value with
 * a "family gate failed" mark when a family duration gate failed and the
 * engine kept the equity duration; and "flagged" when the equity-level gate
 * failed and no value is stored. Only the first and third print a number.
 */
import type { EveChannelsResult, KeyRateResult, ScenarioEVE } from "@alm/engine";
import { eveHasDerivatives, NOT_IN_RUN, sig, signedMM, signedPct, usdMM, years } from "@alm/reader";
import { pairDuration } from "../../results/readouts";
import { blockOf, NotInRun, type TabProps } from "./common";

/** The notImplemented layer the engine writes when key-rate durations are refused on a book with a regime amplifier (run/stages/assemble.ts). */
const REGIME_AMPLIFIER_TAG = "eve.key-rate.regime-amplifier";
export const FAMILY_GATE_REASON = "A family duration gate failed; the equity-level gate passed, and the engine kept the equity duration it computed";
/** The sentence printed beside the mark; the longer reason stays as the mark's title. */
export const FAMILY_GATE_SENTENCE = "A family duration gate failed; the equity duration shown is the one the engine kept.";
/** True when a stored schema version reads older than 1.2.0, the first envelope that can carry eve.keyRate and eve.channels. */
function before120(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor) ? false : major < 1 || (major === 1 && minor < 2);
}

/**
 * Why an opt-in EVE block is absent, read off the run's own envelope: its schema version, then the missing field. It
 * names the run's engine options, never a plan run, so it cannot contradict a box ticked on a run setup.
 */
function absentReason(subject: string, field: "keyRate" | "channels", what: string, version: string, amplifierRefused = false): string {
  if (field === "keyRate" && amplifierRefused) return `${subject} not in this run: the engine refused them because a position on this book carries a one-sided regime amplifier.`;
  if (before120(version)) return `${subject} not in this run: its stored envelope is schema ${version}, older than 1.2.0, the first to carry eve.${field}.`;
  return `${subject} not in this run: its stored envelope (schema ${version}) has no eve.${field}, which the engine writes only when the run's engine options request ${what}.`;
}

export const EQUITY_GATE_REASON ="The equity-level duration gate did not pass; the engine stores no equity duration for this scenario";

/**
 * Four stored states, kept apart (results.ts ScenarioEVE). Not a Section 7
 * headline, so this cell differs from the frozen viewer, which folds a failed
 * family gate into "flagged" and hides the equity duration the engine kept.
 */
function DurationCell(props: { s: ScenarioEVE }) {
  const s = props.s;
  if (s.durationSanityPassed && s.effectiveDurationEquity !== undefined) return <td className="num">{years(s.effectiveDurationEquity)}</td>;
  if (s.durationSanityPassed) {
    return <td className="num"><span className="status status-unobs" title="Not computed: base-only durationMode measures durations at the base environment only">n/a (base-only)</span></td>;
  }
  if (s.effectiveDurationEquity !== undefined) {
    return (
      <td className="num">
        {years(s.effectiveDurationEquity)} <span className="status status-breach" title={FAMILY_GATE_REASON}>family gate failed</span>
        <span className="field-help">{FAMILY_GATE_SENTENCE}</span>
      </td>
    );
  }
  return <td className="num"><span className="status status-breach" title={EQUITY_GATE_REASON}>flagged</span></td>;
}

function KeyRateCard(props: { k: KeyRateResult }) {
  const { k } = props;
  const c = k.convergence;
  return (
    <section className="card table-card" aria-label="Key-rate durations">
      <div className="card-title">Key-rate durations</div>
      <p className="card-desc">Equity key-rate durations at {k.scenarioId}, {k.discountBasis} basis, {k.bumpBp} bp tent bumps, as stored.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col" className="num">Node tenor (years)</th><th scope="col" className="num">Equity KRD (years)</th></tr></thead>
          <tbody>
            {k.nodes.map((n) => <tr key={n.tenorYears}><th scope="row" className="num">{sig(n.tenorYears)}</th><td className="num">{sig(n.duration)}</td></tr>)}
            <tr><th scope="row">Sum over nodes</th><td className="num">{sig(k.sum)}</td></tr>
            <tr><th scope="row">Parallel reference</th><td className="num">{sig(k.parallelReference)}</td></tr>
          </tbody>
        </table>
      </div>
      <dl className="kv">
        <dt>Residual at {k.bumpBp} bp</dt><dd className="num">{sig(c.residualYears)}</dd>
        <dt>Residual at {c.halvedBumpBp} bp</dt><dd className="num">{sig(c.residualYearsAtHalvedBump)}</dd>
        <dt>Halving ratio</dt><dd className="num">{c.ratio !== undefined ? sig(c.ratio) : "n/a (residual below the negligibility floor)"}</dd>
        <dt>Verdict</dt><dd><span className={c.converged ? "status status-pass" : "status status-breach"}>{c.converged ? "converged" : "not converged (reported, never patched)"}</span></dd>
      </dl>
      <p className="card-foot">Source: result.eve.keyRate</p>
    </section>
  );
}

function ChannelsCard(props: { c: EveChannelsResult; label: (id: string) => string }) {
  return (
    <section className="card table-card" aria-label="EVE channel decomposition">
      <div className="card-title">EVE channel decomposition</div>
      <p className="card-desc">Full-life EVE change per shocked scenario, {props.c.discountBasis} basis: projection leg, discounting leg, and the interaction residual in its own column.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Scenario</th><th scope="col" className="num">EVE base</th><th scope="col" className="num">EVE shocked</th><th scope="col" className="num">Total change</th><th scope="col" className="num">Projection</th><th scope="col" className="num">Discounting</th><th scope="col" className="num">Interaction residual</th></tr></thead>
          <tbody>
            {props.c.byScenario.map((r) => (
              <tr key={r.scenarioId}>
                <th scope="row">{props.label(r.scenarioId)}</th>
                <td className="num">{usdMM(r.eveBase)}</td>
                <td className="num">{usdMM(r.eveShocked)}</td>
                <td className="num">{signedMM(r.totalDelta)}</td>
                <td className="num">{signedMM(r.projectionDelta)}</td>
                <td className="num">{signedMM(r.discountingDelta)}</td>
                <td className="num">{signedMM(r.interactionResidual)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">Source: result.eve.channels</p>
    </section>
  );
}

export function EveTab(p: TabProps) {
  const eve = blockOf(p.result, "eve");
  if (eve === undefined) return <NotInRun title="EVE" reason="The envelope carries no eve block." />;
  const withDer = eveHasDerivatives(eve);
  const amplifierRefused = (p.result.notImplemented ?? []).some((t) => t.layer === REGIME_AMPLIFIER_TAG);
  // The convention the run valued deposits on: a run that recorded none is behavioral. The pair duration is
  // the book's own 200bp formula on the stored scenario PVs; it needs the SRP31 parallel pair or the plus
  // and minus 200bp parallel pair. The deposit history the run valued deposits on is named only when it carries one.
  const convention = p.result.nmdConvention ?? "behavioral";
  const warmup = p.result.nmdWarmup;
  const pair = pairDuration(p.result, p.detail);
  return (
    <>
      <section className="card table-card" aria-label="EVE by scenario">
        <div className="card-title">Economic value of equity</div>
        <p className="card-desc">PV of assets minus PV of liabilities{withDer ? ", plus PV of derivatives on the risk-free curve" : ""}, discounted on the {eve.discountBasis} basis. Every figure is the stored field.</p>
        <p className="card-desc" title="eve.discountBasis and nmdConvention">Discount basis: {eve.discountBasis}. NMD convention: {convention}.</p>
        {warmup !== undefined ? (
          <p className="card-desc" title="nmdWarmup">
            {warmup.kind === "history"
              ? `Deposit history: ${warmup.label}, ${warmup.months} months from ${warmup.firstMonth} to ${warmup.lastMonth}, the same in every scenario.`
              : `Deposit history: flat ${warmup.months} months at r0, re-levelled in each scenario by its short-end shock.`}
          </p>
        ) : null}
        {pair === null ? (
          <p className="card-desc">200bp pair duration: not in this run, which needs the base and either the SRP31 parallel pair (SRP-PUP and SRP-PDN) or the plus and minus 200bp parallel scenarios.</p>
        ) : (
          <p className="card-desc" title={`(PV at ${pair.downId} less PV at ${pair.upId}) / (2 x PV at base x 0.02)`}>
            200bp pair duration (from the stored {pair.downId} and {pair.upId} PVs): assets {years(pair.assets)} years, liabilities {years(pair.liabilities)} years, duration gap {years(pair.gap)} years.
          </p>
        )}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Scenario</th><th scope="col" className="num">PV assets</th><th scope="col" className="num">PV liabilities</th>
                {withDer ? <th scope="col" className="num">PV derivatives</th> : null}
                <th scope="col" className="num">EVE</th><th scope="col" className="num">Change vs base</th><th scope="col" className="num">Change vs base, percent</th><th scope="col" className="num">Duration of equity</th>
              </tr>
            </thead>
            <tbody>
              {eve.byScenario.map((s) => (
                <tr key={s.scenarioId}>
                  <th scope="row">{p.scenarioLabel(s.scenarioId)} <span className="mono muted">{s.scenarioId}</span></th>
                  <td className="num">{usdMM(s.pvAssets)}</td>
                  <td className="num">{usdMM(s.pvLiabilities)}</td>
                  {withDer ? <td className="num">{s.pvDerivatives === undefined ? <span className="status status-unobs" title={`pvDerivatives is absent for ${s.scenarioId}`}>{NOT_IN_RUN}</span> : signedMM(s.pvDerivatives)}</td> : null}
                  <td className="num">{usdMM(s.eve)}</td>
                  <td className="num">{signedMM(s.deltaEveVsBase)}</td>
                  <td className="num">{signedPct(s.deltaEvePct)}</td>
                  <DurationCell s={s} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-foot">Source: /api/runs/{p.runId}/result eve.byScenario. The percent change is stored as a decimal fraction and multiplied by 100 for display only.</p>
      </section>
      {eve.keyRate !== undefined ? <KeyRateCard k={eve.keyRate} /> : (
        <NotInRun title="Key-rate durations" reason={absentReason("Key-rate durations are", "keyRate", "key-rate durations", p.result.schemaVersion, amplifierRefused)} />
      )}
      {eve.channels !== undefined ? <ChannelsCard c={eve.channels} label={p.scenarioLabel} /> : (
        <NotInRun title="EVE channel decomposition" reason={absentReason("The channel decomposition is", "channels", "the channel decomposition", p.result.schemaVersion)} />
      )}
    </>
  );
}
