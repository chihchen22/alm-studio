/**
 * The one check of a requested NII report-horizon list (spec decisions 111 and
 * 116). `computeNII` clamps a horizon past the grid without a word, so the run route and the pipeline refuse
 * one before anything is computed: the list is non-empty, every entry a positive whole number of months,
 * strictly ascending, and at most the grid horizon. The NII window (decision 118) is checked here too: a
 * positive whole number of months, at most the grid horizon.
 */
import { NII_HORIZONS_MONTHS } from "./computeNII";

/**
 * True when `list` is the engine's own default horizon list (NII_HORIZONS_MONTHS, [12, 24]), the list a run gets
 * without asking. The setup compile and the run route write the option only when this is false (decision 115).
 */
export function isEngineReportHorizons(list: readonly number[]): boolean {
  return list.length === NII_HORIZONS_MONTHS.length && list.every((m, i) => m === NII_HORIZONS_MONTHS[i]);
}

const shown = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * The NII window a run setup opens Results > NII on when it names none (spec decision 118, the setup's "Default NII
 * window"). `NIIResult.windowMonths` is written only when a run asked for another window.
 */
export const DEFAULT_NII_WINDOW_MONTHS = 60;

/** Why `value` is not an NII window for a grid of `gridHorizonMonths` months, naming `path`; undefined when it is one. */
export function windowMonthsConfigError(value: unknown, path: string, gridHorizonMonths: number): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return `${path} must be a whole number of months, at least 1, got ${shown(value)}`;
  }
  if (value > gridHorizonMonths) {
    return `${path} must be at most the grid horizon (${gridHorizonMonths}), got ${value}`;
  }
  return undefined;
}

/** Why `value` is not a report-horizon list for a grid of `gridHorizonMonths` months, naming `path`; undefined when it is one. */
export function reportHorizonsConfigError(value: unknown, path: string, gridHorizonMonths: number): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return `${path} must be a non-empty array of whole months, got ${shown(value)}`;
  }
  for (let i = 0; i < value.length; i++) {
    const m = value[i];
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1) {
      return `${path}[${i}] must be a whole number of months, at least 1, got ${shown(m)}`;
    }
    if (m > gridHorizonMonths) {
      return `${path}[${i}] must be at most the grid horizon (${gridHorizonMonths}), got ${m}`;
    }
    if (i > 0 && m <= (value[i - 1] as number)) {
      return `${path}[${i}]: horizons must be strictly ascending, ${m} follows ${shown(value[i - 1])}`;
    }
  }
  return undefined;
}
