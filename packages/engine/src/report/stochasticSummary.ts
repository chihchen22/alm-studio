/**
 * Single-run stochastic summary. This reader works over one stored
 * StochasticRunResult envelope and nothing else: it lays the
 * envelope out as context rows, statistic rows, the stored calibration gate
 * state, the verbatim notImplemented list and fixed notes. Every statistic is
 * read verbatim and none is derived. A distribution here is a statistic of the
 * Monte Carlo path set, never an EVE or an NII.
 *
 * The summary carries the envelope's
 * calibration arm verbatim in the additive `calibration` field (the BGM
 * parameters reach the Studio here, not through the compare); the gate reads
 * both calibrated arms, Hull-White on the at-the-money column of the
 * short-rate volatility surface and BGM on the default subset of the
 * long-yield volatility surface; the override text names the model. Every
 * text is computed on read, so no stored byte moves.
 */
import type { StochasticCalibrationSummary } from "../contracts/stochastic";
import type { NotImplemented } from "../contracts/errors";
import type { StochasticCompareSide } from "./stochasticCompare";
import {
  contextValues,
  statRows,
  type StochasticContextValue,
  type StochasticStat,
} from "./stochasticFields";

/** One statistic of the run, read verbatim from the envelope. */
export interface StochasticSummaryRow {
  stat: StochasticStat;
  /** Cumulative probability for a quantile row, otherwise null. */
  p: number | null;
  value: number;
}

/** One context field of the run, read verbatim. */
export interface StochasticSummaryContextRow {
  field: string;
  value: StochasticContextValue;
}

export type CalibrationGateState = "within-gate" | "gate-breached" | "no-gate";

/** The calibration gate as the envelope records it; nothing is compared here. */
export interface StochasticCalibrationGate {
  state: CalibrationGateState;
  rmseBp: number | null;
  rmseGateBp: number | null;
  text: string;
}

export interface StochasticSummaryDistribution {
  rows: StochasticSummaryRow[];
}

export interface StochasticRunSummary {
  kind: "stochastic-run-summary";
  runId: string;
  context: StochasticSummaryContextRow[];
  calibrationGate: StochasticCalibrationGate;
  eveDistribution: StochasticSummaryDistribution;
  nii12mDistribution: StochasticSummaryDistribution;
  notImplemented: NotImplemented[];
  notes: string[];
  /** The envelope's calibration arm, verbatim (additive, slice two decision 93). */
  calibration: StochasticCalibrationSummary;
}

/** An envelope that fails the summary's one check; the message is shown verbatim. */
export class StochasticSummaryError extends Error {
  readonly field: string;
  readonly value: string;
  constructor(message: string, field: string, value: string) {
    super(message);
    this.name = "StochasticSummaryError";
    this.field = field;
    this.value = value;
  }
}

const HW_TARGET = "the at-the-money column of the short-rate volatility surface";
const bgmTarget = (nPoints: number): string =>
  `the default subset of the long-yield volatility surface (${nPoints} points)`;

const gateWithin = (target: string): string =>
  `Calibrated to ${target} of the run's market snapshot. The fit RMSE is within the acceptance gate, as the envelope records (calibration.rmseGateBreached false).`;
const gateBreached = (target: string): string =>
  `Calibrated to ${target} of the run's market snapshot. The fit RMSE exceeds the acceptance gate, as the envelope records (calibration.rmseGateBreached true). The breach is reported, never refused: the distributions rest on a fit outside the gate.`;
const gateNone = (model: string): string =>
  `The ${model} parameters were supplied by the caller (calibration.source override), not calibrated to the market snapshot, so no fit RMSE exists and no gate applies. The caller's reason is in calibration.reason.`;

const N1 =
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every statistic is read verbatim from the run's stored envelope, and portfolioId and marketId from its stored submission; none is derived.";
const N2 =
  "The standard error is the standard error of the mean, computed by the engine over antithetic-pair averages (nPaths / 2 independent samples). The standard deviation is the per-path dispersion, not a standard error.";
const N3 =
  "Each quantile is the engine's interpolation between order statistics at the pinned p. Per-path values are not stored, so no other quantile is available.";
const N4 =
  "The distributions are for the base scenario only, the scenario the context names in scenarioId.";

/**
 * The gate as the envelope records it: Hull-White on the at-the-money column of the short-rate
 * volatility surface, BGM on the default subset of the long-yield volatility surface (its point count
 * read from calibration.nQuotes); an override of either model has no gate and its text names the model.
 */
function gateOf(e: StochasticCompareSide["envelope"]): StochasticCalibrationGate {
  const c = e.calibration;
  if (c.source === "cap-atm-calibration" || c.source === "long-yield-atm-calibration") {
    const target = c.source === "cap-atm-calibration" ? HW_TARGET : bgmTarget(c.nQuotes);
    return c.rmseGateBreached
      ? { state: "gate-breached", rmseBp: c.rmseBp, rmseGateBp: c.rmseGateBp, text: gateBreached(target) }
      : { state: "within-gate", rmseBp: c.rmseBp, rmseGateBp: c.rmseGateBp, text: gateWithin(target) };
  }
  // A saved fit carries the gate verdict it was saved with, and the reason when it was saved outside it.
  if (c.source === "saved-calibration") {
    const what = `The run used the saved calibration ${c.calibrationId}, fitted on market snapshot "${c.marketId}" (calibration.source saved-calibration).`;
    return c.rmseGateBreached
      ? { state: "gate-breached", rmseBp: c.rmseBp, rmseGateBp: c.rmseGateBp, text: `${what} Its fit is outside its gate; it was saved with the reason: ${c.outsideGateReason ?? "none recorded"}` }
      : { state: "within-gate", rmseBp: c.rmseBp, rmseGateBp: c.rmseGateBp, text: `${what} Its fit is within its gate.` };
  }
  return { state: "no-gate", rmseBp: null, rmseGateBp: null, text: gateNone("model" in c ? "BGM" : "Hull-White") };
}

/**
 * Reads one stored stochastic envelope as rows. Refuses
 * (StochasticSummaryError) only an envelope whose kind is not
 * stochastic-distribution.
 */
export function summarizeStochastic(side: StochasticCompareSide): StochasticRunSummary {
  const e = side.envelope;
  if (e.kind !== "stochastic-distribution") {
    throw new StochasticSummaryError(
      `stochastic summary: run "${e.runId}" is not a stochastic distribution envelope (kind ${String(e.kind)})`,
      "kind",
      String(e.kind),
    );
  }
  return {
    kind: "stochastic-run-summary",
    runId: e.runId,
    context: contextValues(e, side),
    calibrationGate: gateOf(e),
    eveDistribution: { rows: statRows(e.eveDistribution) },
    nii12mDistribution: { rows: statRows(e.nii12mDistribution) },
    notImplemented: [...e.notImplemented],
    notes: [N1, N2, N3, N4],
    calibration: structuredClone(e.calibration),
  };
}
