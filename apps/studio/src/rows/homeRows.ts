/**
 * Home rows. Field copies out of the served envelope sections, in envelope
 * order. No arithmetic: every number here is the route's own value.
 */
import type { CatalogLineage } from "@alm/reader";
import type { EVEResult, NIIResult } from "@alm/engine";

export interface EveRow { scenarioId: string; eve: number; deltaEveVsBase: number; deltaEvePct: number }
export interface NiiRow { scenarioId: string; totalNet12: number; totalNet24: number }

/** eve.byScenario in envelope order, four fields copied. */
export function eveRows(eve: EVEResult): EveRow[] {
  return eve.byScenario.map((s) => ({ scenarioId: s.scenarioId, eve: s.eve, deltaEveVsBase: s.deltaEveVsBase, deltaEvePct: s.deltaEvePct }));
}

/** nii.byScenario in envelope order, the two pinned horizon totals copied. */
export function niiRows(nii: NIIResult): NiiRow[] {
  return nii.byScenario.map((s) => ({ scenarioId: s.scenarioId, totalNet12: s.totalNet12, totalNet24: s.totalNet24 }));
}

/** The row for the base scenario, or undefined when the envelope has none. */
export function baseRow<T extends { scenarioId: string }>(rows: T[], baseScenarioId: string): T | undefined {
  return rows.find((r) => r.scenarioId === baseScenarioId);
}

/**
 * The newest finished run that consumed this document: consumedBy entries
 * with state "done", greatest endedAt by string comparison (ISO 8601 sorts
 * lexically). A done run with no endedAt never wins over one that has one.
 * null when no done run exists.
 */
export function newestDoneRun(lineage: CatalogLineage): string | null {
  return doneRunsNewestFirst(lineage)[0] ?? null;
}

/** Every done run that consumed this document, greatest endedAt first (same ordering rule as newestDoneRun; ties keep lineage order). */
export function doneRunsNewestFirst(lineage: CatalogLineage): string[] {
  return lineage.consumedBy
    .filter((c) => c.state === "done")
    .map((c, i) => ({ runId: c.runId, endedAt: c.endedAt ?? "", i }))
    .sort((a, b) => (a.endedAt < b.endedAt ? 1 : a.endedAt > b.endedAt ? -1 : a.i - b.i))
    .map((c) => c.runId);
}
