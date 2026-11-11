/**
 * Shared stochastic field helpers. Internal to the report
 * readers and not exported from report/index.ts, except calibrationParametersText
 * (for the summary CSV): the single-run summary and
 * the two-run compare read one stored StochasticRunResult envelope through the
 * same field list and the same statistic rows, so the two cannot drift. Every
 * value is read verbatim; nothing here derives a number.
 */
import { BGM_CEV_BETA_OF_RECORD, BGM_DISPLACEMENT_OF_RECORD } from "@alm/kernel";
import type {
  StochasticCalibrationSummary,
  StochasticDistribution,
  StochasticRunResult,
} from "../contracts/stochastic";

export type StochasticContextValue = string | number | boolean | null;

/** Which statistic a row compares. */
export type StochasticStat = "mean" | "standardError" | "stdev" | "min" | "max" | "quantile";

/** Platform metadata read from a run's submission, not a result number. */
export interface StochasticSideMeta {
  portfolioId?: string;
  marketId?: string;
}

type CalibrationFlat = Record<
  | "source"
  | "a"
  | "sigma"
  | "rmseBp"
  | "rmseGateBp"
  | "rmseGateBreached"
  | "nQuotes"
  | "reason"
  | "parameters",
  StochasticContextValue
>;

/**
 * The model parameters of a calibration arm as one text, every number read verbatim:
 * "a=..., sigma=..." for HW; the six Rebonato values with displacement and CEV for BGM (spec v2
 * decision 93). The BGM override arm carries no displacement or CEV, which stay fixed at the
 * engine of record, so its text reads the kernel's constants of record.
 */
export function calibrationParametersText(c: StochasticCalibrationSummary): string {
  if (c.source === "long-yield-atm-calibration") {
    return rebonatoText(c, c.displacement, c.cevBeta);
  }
  if (c.source === "override" && "model" in c) {
    return rebonatoText(c, BGM_DISPLACEMENT_OF_RECORD, BGM_CEV_BETA_OF_RECORD);
  }
  // A saved fit's parameters, read verbatim off the arm.
  if (c.source === "saved-calibration") {
    const p = c.parameters;
    return p.model === "bgm-lmm-2f" ? rebonatoText(p, p.displacement, p.cevBeta) : `a=${p.a}, sigma=${p.sigma}`;
  }
  return `a=${c.a}, sigma=${c.sigma}`;
}

function rebonatoText(
  p: { a: number; b: number; c: number; d: number; beta: number; volScalar: number },
  displacement: number,
  cevBeta: number,
): string {
  return (
    `a=${p.a}, b=${p.b}, c=${p.c}, d=${p.d}, beta=${p.beta}, volScalar=${p.volScalar}, ` +
    `displacement=${displacement}, cevBeta=${cevBeta}`
  );
}

function flatCalibration(c: StochasticCalibrationSummary): CalibrationFlat {
  const parameters = calibrationParametersText(c);
  switch (c.source) {
    case "cap-atm-calibration":
      return {
        source: c.source,
        a: c.a,
        sigma: c.sigma,
        rmseBp: c.rmseBp,
        rmseGateBp: c.rmseGateBp,
        rmseGateBreached: c.rmseGateBreached,
        nQuotes: c.nQuotes,
        reason: null,
        parameters,
      };
    case "long-yield-atm-calibration":
      // BGM has no a-and-sigma pair: the HW rows read null.
      return {
        source: c.source,
        a: null,
        sigma: null,
        rmseBp: c.rmseBp,
        rmseGateBp: c.rmseGateBp,
        rmseGateBreached: c.rmseGateBreached,
        nQuotes: c.nQuotes,
        reason: null,
        parameters,
      };
    case "override":
      return {
        source: c.source,
        a: "model" in c ? null : c.a,
        sigma: "model" in c ? null : c.sigma,
        rmseBp: null,
        rmseGateBp: null,
        rmseGateBreached: null,
        nQuotes: null,
        reason: c.reason,
        parameters,
      };
    case "saved-calibration":
      // The saved fit's diagnostics as it was saved; the reason row reads the outside-gate reason, if any.
      return {
        source: c.source,
        a: c.parameters.model === "hull-white-1f" ? c.parameters.a : null,
        sigma: c.parameters.model === "hull-white-1f" ? c.parameters.sigma : null,
        rmseBp: c.rmseBp,
        rmseGateBp: c.rmseGateBp,
        rmseGateBreached: c.rmseGateBreached,
        nQuotes: null,
        reason: c.outsideGateReason ?? null,
        parameters,
      };
  }
}

/** The 23 like-for-like context fields of one envelope, in their fixed order. */
export function contextValues(
  e: StochasticRunResult,
  meta: StochasticSideMeta,
): Array<{ field: string; value: StochasticContextValue }> {
  const c = flatCalibration(e.calibration);
  return [
    { field: "runId", value: e.runId },
    { field: "portfolioId", value: meta.portfolioId ?? null },
    { field: "marketId", value: meta.marketId ?? null },
    { field: "schemaVersion", value: e.schemaVersion },
    { field: "model", value: e.model },
    { field: "scenarioId", value: e.scenarioId },
    { field: "assumptionSetId", value: e.assumptionSetId },
    { field: "seed", value: e.seed },
    { field: "nPaths", value: e.nPaths },
    { field: "horizonMonths", value: e.horizonMonths },
    { field: "discountBasis", value: e.discountBasis },
    { field: "calibration.source", value: c.source },
    { field: "calibration.a", value: c.a },
    { field: "calibration.sigma", value: c.sigma },
    { field: "calibration.rmseBp", value: c.rmseBp },
    { field: "calibration.rmseGateBp", value: c.rmseGateBp },
    { field: "calibration.rmseGateBreached", value: c.rmseGateBreached },
    { field: "calibration.nQuotes", value: c.nQuotes },
    { field: "calibration.reason", value: c.reason },
    { field: "martingale.correctedMaxAbsErrBp", value: e.martingale.correctedMaxAbsErrBp },
    { field: "martingale.rawTerminalErrBp", value: e.martingale.rawTerminalErrBp },
    { field: "martingale.terminalDfStandardError", value: e.martingale.terminalDfStandardError },
    { field: "martingale.terminalYears", value: e.martingale.terminalYears },
  ];
}

/**
 * The statistic rows of one distribution: mean, standardError, stdev, min and
 * max (p null), then one quantile row per stored quantile in envelope order.
 */
export function statRows(
  d: StochasticDistribution,
): Array<{ stat: StochasticStat; p: number | null; value: number }> {
  const rows: Array<{ stat: StochasticStat; p: number | null; value: number }> = [
    { stat: "mean", p: null, value: d.mean },
    { stat: "standardError", p: null, value: d.standardError },
    { stat: "stdev", p: null, value: d.stdev },
    { stat: "min", p: null, value: d.min },
    { stat: "max", p: null, value: d.max },
  ];
  for (const q of d.quantiles) rows.push({ stat: "quantile", p: q.p, value: q.value });
  return rows;
}
