// apps/studio/src/assumptions/clientRatePathModel.ts
/**
 * The Loan repricing page's projected client rate: the rows the run's
 * rate document stores under each scenario's `clientRates`, read at a few
 * sample months. Month M reads index M - 1 (the engine's month convention). No
 * arithmetic is done on a rate: each cell is the stored decimal through the
 * reader's pct. The basis sentence is worded from the row's stored curve
 * convention, so the page never states a basis the run did not use.
 */
import type { ClientRateRow, RateDocument } from "@alm/engine";
import { pct } from "@alm/reader";
import { errText } from "../errText";
import { selectorText } from "./selectorText";

/** The months a row is read at, before the horizon filter. */
const SAMPLE_MONTHS = [1, 12, 24, 60, 120];

/** The sample months up to the horizon, with the horizon appended when it is not already one. Never duplicated, never clamped. */
export function sampleMonths(horizonMonths: number): number[] {
  const months = SAMPLE_MONTHS.filter((m) => m <= horizonMonths);
  if (horizonMonths >= 1 && !months.includes(horizonMonths)) months.push(horizonMonths);
  return months;
}

const BASIS_HEAD = "Benchmark: the 10-year forward par yield on the run's curve, on the curve's own quote basis: ";

/** The basis sentence for one stored curve convention. */
export function basisSentence(convention: ClientRateRow["curveConvention"]): string {
  return convention === "semiannual_bond" ? `${BASIS_HEAD}semi-annual bond-equivalent basis (Treasury CMT on the public pack).` : `${BASIS_HEAD}annual ACT/360 par rate.`;
}

export const PICK_A_RUN = "Pick a run to see its projected client rate.";
export const RUN_PREDATES = "This run finished before client rates were projected; re-run it.";
export const NO_LOAN_REPRICING = "The run's assumption set binds no loan repricing.";

export interface ClientRateCell { month: number; text: string }
export interface ClientRateRowView {
  family: string;
  selector: string;
  spread: string;
  basis: string;
  cells: ClientRateCell[];
}
export interface ClientRateScenarioView {
  scenarioId: string;
  /** The stored reason this scenario carries no path, or null. */
  omitted: string | null;
  rows: ClientRateRowView[];
}
export interface ClientRateModel {
  /** A sentence that stands for the whole section (a state), or null when scenarios follow. */
  message: string | null;
  months: number[];
  scenarios: ClientRateScenarioView[];
}

export type ClientRateSource = { doc: RateDocument | null } | { error: unknown };

const sentence = (message: string): ClientRateModel => ({ message, months: [], scenarios: [] });

export function clientRateModel(src: ClientRateSource, runId: string): ClientRateModel {
  if ("error" in src) return sentence(errText(src.error));
  if (runId === "" || src.doc === null) return sentence(PICK_A_RUN);
  const doc = src.doc;
  if (doc.schemaVersion === "1.0.0") return sentence(RUN_PREDATES);
  const months = sampleMonths(doc.grid.horizonMonths);
  const scenarios: ClientRateScenarioView[] = [];
  let anyRows = false;
  let anyPlain = false;
  for (const sc of doc.scenarios) {
    const stored = sc.clientRates ?? [];
    if (stored.length > 0) anyRows = true;
    else if (sc.pathOmitted === undefined) anyPlain = true;
    if (stored.length === 0 && sc.pathOmitted === undefined) continue;
    scenarios.push({
      scenarioId: sc.scenarioId,
      omitted: stored.length === 0 ? sc.pathOmitted ?? null : null,
      rows: stored.map((r) => ({
        family: r.familyId,
        selector: selectorText(r.selector),
        spread: `${r.totalSpreadBp} bp`,
        basis: basisSentence(r.curveConvention),
        // Month M is index M - 1; a month past the stored array is left out, never read as undefined.
        cells: months.filter((m) => m <= r.clientRate.length).map((m) => ({ month: m, text: pct(r.clientRate[m - 1]!) })),
      })),
    });
  }
  // A run whose every scenario omitted its path says nothing about a binding; only the stored reasons print.
  if (!anyRows && (anyPlain || scenarios.length === 0)) return { message: NO_LOAN_REPRICING, months, scenarios: [] };
  return { message: null, months, scenarios };
}
