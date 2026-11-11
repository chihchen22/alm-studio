/**
 * The model convention of a run: which K1 corrections it applies.
 *
 * The run names one grouped value (`ModelConvention`); every stage reads the resolved switches below, one per
 * correction, so a test can name the correction it pins. Absent means the original convention: every switch off, and the
 * run is byte-identical to a run made before the corrections.
 */
import type { ModelConvention } from "../contracts/run";

/** The corrections, one switch each. */
export interface ModelCorrections {
  /**
   * K1 points 1 and 2: the CD walk reads the curve of the rate path it is projected on (the run's market, shifted by
   * the scenario) plus the run's funding spread, for its offer prices, its moneyness and its own discounting. Off, it
   * walks the kernel's fixed 2026-03-31 grid and ignores the scenario.
   */
  cdScenarioCurve: boolean;
  /** K1 point 3: the CD walk drops a cohort below $1 of walk balance, the kernel header's figure, not $1,000. */
  cdMinimumBalance: boolean;
  /** K1 point 4 (D6): an SEG replacement deposit vintage reads the run's deposit history, not the kernel's series. */
  segVintageHistory: boolean;
}

/** Every model convention a run may name, in the order a control lists them. */
export const MODEL_CONVENTIONS: readonly ModelConvention[] = ["corrected-v1", "book"];

/** The convention a new setup carries. */
export const CURRENT_MODEL_CONVENTION: ModelConvention = "corrected-v1";

/** The CD minimum live balance the correction uses, in walk dollars: the kernel header's "$1 minimum live balance". */
export const CD_MINIMUM_LIVE_BALANCE_CORRECTED = 1;

const BOOK: ModelCorrections = { cdScenarioCurve: false, cdMinimumBalance: false, segVintageHistory: false };
const CORRECTED_V1: ModelCorrections = { cdScenarioCurve: true, cdMinimumBalance: true, segVintageHistory: true };

/** The switches of a convention; absent is the original convention. */
export function modelCorrectionsOf(convention: ModelConvention | undefined): ModelCorrections {
  return convention === "corrected-v1" ? { ...CORRECTED_V1 } : { ...BOOK };
}

/** True when any correction is on. */
export function anyCorrection(c: ModelCorrections): boolean {
  return c.cdScenarioCurve || c.cdMinimumBalance || c.segVintageHistory;
}

/** The shape check every entry point runs: undefined when `value` is a convention, else one sentence naming `path`. */
export function modelConventionConfigError(value: unknown, path: string): string | undefined {
  if (value === "book" || value === "corrected-v1") return undefined;
  return `${path} must be "corrected-v1" (the corrections) or "book" (the original convention), got ${JSON.stringify(value)}`;
}

/** Plain words for a convention, for a screen or a CSV header. */
export function modelConventionLabel(convention: ModelConvention | undefined): string {
  if (convention === "corrected-v1") return "Corrected (2026-11)";
  if (convention === "book") return "Original convention";
  return "Original convention (made before the corrections)";
}
