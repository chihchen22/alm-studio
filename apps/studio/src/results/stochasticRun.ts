// apps/studio/src/results/stochasticRun.ts
/**
 * The Stochastic distributions layer's view model. The server's
 * summary reply carries every statistic, the context and the calibration gate
 * state verbatim; this file only picks the runs to list, writes the layer
 * address and turns stored values into text. Nothing here does arithmetic on a
 * result value. The model the context
 * row stores and the summary's `calibration` field (the envelope arm verbatim)
 * are printed for either model.
 */
import type { StochasticCalibrationSummary } from "@alm/engine";
import type { CalibrationGateState, RunSummary, StochasticCalibrationGate, StochasticSummaryContextRow } from "@alm/reader";
import { BGM_MODEL_ID, cellText } from "../compare/compareModel";
import { screenHref } from "../pageLinks";

/** This screen for one run: the run is the result picker's choice, and no other page state travels with it. */
export function stochasticHref(ws: string, runId: string): string {
  return screenHref({ ws, section: "results", screen: "stochastic" }, { run: runId });
}

export interface StochasticRunRow {
  runId: string;
  label: string | null;
  submittedAt: string;
}

/** Done stochastic runs, newest first by the stored submittedAt. */
export function stochasticRunRows(runs: RunSummary[]): StochasticRunRow[] {
  return runs
    .filter((r) => r.state === "done" && r.mode === "stochastic")
    .sort((x, y) => (x.submittedAt < y.submittedAt ? 1 : x.submittedAt > y.submittedAt ? -1 : 0))
    .map((r) => ({ runId: r.runId, label: r.label ?? null, submittedAt: r.submittedAt }));
}

/** A stored statistic as text: the Compare page's 6-decimal display; null prints none. */
export function statText(v: number | null): string {
  return cellText(v, "A", true);
}

/** The gate state as a chip: within passes, breached breaches, an override has no gate. */
export function gateChip(state: CalibrationGateState): { className: string; text: string } {
  switch (state) {
    case "within-gate": return { className: "status status-pass", text: "Within the gate" };
    case "gate-breached": return { className: "status status-breach", text: "Gate breached" };
    case "no-gate": return { className: "status status-unobs", text: "No gate" };
  }
}

/** The stored fit RMSE against the stored gate, or why there is none. */
export function gateLine(gate: StochasticCalibrationGate): string {
  if (gate.state === "no-gate") return "Parameters supplied by override, not calibrated.";
  return `Fit RMSE ${statText(gate.rmseBp)} bp against the ${statText(gate.rmseGateBp)} bp gate.`;
}

/** The rate model a run names, in words (slice two decision 80); an unknown id prints as itself, a missing row says so. */
export function modelText(model: string | null): string {
  if (model === null) return "not recorded";
  if (model === "hull-white-1f") return "Hull-White 1F";
  if (model === BGM_MODEL_ID) return "BGM, the shifted-CEV LIBOR market model with Rebonato two-factor volatility";
  return model;
}

/** The summary's stored `model` context row, verbatim; null when the reply carries none. */
export function summaryModel(context: StochasticSummaryContextRow[]): string | null {
  const v = context.find((c) => c.field === "model")?.value;
  return typeof v === "string" ? v : null;
}

/**
 * The calibration arm's scalar keys in the arm's own order, each value as text at full precision (a number or a
 * boolean via String). An array (the BGM subset) is left out here and listed by subsetText.
 */
export function calibrationEntries(c: StochasticCalibrationSummary): Array<{ key: string; value: string }> {
  // A saved fit's parameters are one object; its values are listed by name after the arm's own keys.
  const params = c.source === "saved-calibration" ? Object.entries(c.parameters).filter(([k]) => k !== "model").map(([key, v]) => ({ key, value: String(v) })) : [];
  return [
    ...Object.entries(c)
      .filter(([, v]) => !Array.isArray(v) && (typeof v !== "object" || v === null))
      .map(([key, v]) => ({ key, value: String(v) })),
    ...params,
  ];
}

/** The BGM subset the fit used, as expiry x tenor in years; null for an arm without one. */
export function subsetText(c: StochasticCalibrationSummary): string | null {
  if (c.source !== "long-yield-atm-calibration") return null;
  return c.subset.map((p) => `${p.expiryYears}x${p.tenorYears}`).join(", ");
}

const HW_PARAMS = "a is the mean-reversion speed per year and sigma the instantaneous normal volatility.";

/** One sentence on what the arm is and what its parameters mean; every value itself is in the table. */
export function calibrationLead(c: StochasticCalibrationSummary): string {
  switch (c.source) {
    case "cap-atm-calibration":
      return `Hull-White 1F, calibrated to the at-the-money column of the short-rate volatility surface: ${HW_PARAMS}`;
    case "long-yield-atm-calibration":
      return "BGM, calibrated to the default subset of the long-yield volatility surface: a, b, c and d shape the Rebonato volatility, volScalar scales it and beta sets the correlation between forwards; the displacement and the CEV exponent (cevBeta) of the shifted-CEV forward are held fixed at the default engine.";
    case "override":
      return "model" in c
        ? "BGM, parameters supplied by the caller, not calibrated: the six Rebonato values as supplied; the displacement and the CEV exponent are not overridable and stay at the default engine."
        : `Hull-White 1F, parameters supplied by the caller, not calibrated: ${HW_PARAMS}`;
    case "saved-calibration":
      return `${c.model === "bgm-lmm-2f" ? "BGM" : "Hull-White 1F"}, from the saved calibration ${c.calibrationId}, fitted on market snapshot ${c.marketId}: ${c.rmseBp.toFixed(2)} bp against a ${c.rmseGateBp} bp gate, ${c.rmseGateBreached ? `outside its gate (saved with the reason: ${c.outsideGateReason ?? "none recorded"})` : "within its gate"}.`;
  }
}
