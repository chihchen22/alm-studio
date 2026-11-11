/**
 * The index history contract. Types and
 * constants only, no runtime imports, so the validator, the rate index validator and Studio can import it.
 *
 * A history is one immutable store document per series: monthly month-end fixings as decimals, from firstMonth on,
 * with no gap (an import refuses a whole month without a value, decision 55). Its store id is `ih-` plus 16 hex of
 * its canonical content hash (indexHistory/id.ts), so identical content is the same document. A rate index carries
 * only that id (`historyId`); a run receives the documents by id (RunRequest.indexHistories).
 */
export const INDEX_HISTORY_ID_PATTERN = /^ih-[0-9a-f]{16}$/;
/** Monthly values after conversion (decision 47; the v3 decision 20 cap, now in months). */
export const MAX_INDEX_HISTORY_MONTHS = 1200;
export const INDEX_HISTORY_LABEL_MAX_LENGTH = 120;

export type IndexHistoryUnit = "percent" | "decimal";
export type IndexHistoryFrequency = "daily" | "monthly";
export type IndexHistoryFormat = "csv" | "xlsx";

/** Where the series came from: the uploaded file by name and hash, how it was read, and the unit it was declared in. */
export interface IndexHistorySource {
  fileName: string;
  /** 64 lowercase hex: SHA-256 of the uploaded bytes. */
  fileSha256: string;
  format: IndexHistoryFormat;
  /** daily: the file held more than one row in some month and was cut to month-end fixings; monthly: one row per month. */
  frequency: IndexHistoryFrequency;
  /** Dated data rows read, header and blank rows excluded. */
  rows: number;
  /** The unit the import declared; values are stored as decimals whatever it was. */
  unit: IndexHistoryUnit;
}

export interface IndexHistory {
  label: string;
  /** YYYY-MM of values[0]. */
  firstMonth: string;
  /** One decimal per month, contiguous: values[k] is the month-end fixing of firstMonth + k months. */
  values: number[];
  source: IndexHistorySource;
}

/** A history as a run receives it: the store id beside the document (RunRequest.indexHistories, sorted by id). */
export interface IndexHistoryEntry {
  id: string;
  history: IndexHistory;
}

/** What a run reads from one history: for readiness and the results note (decisions 49 and 52). */
export interface IndexHistoryReading {
  /** The index that carries the history: the parent of a lagged formula the run reads. */
  indexId: string;
  historyId: string;
  /** The lagged formulas that read it, sorted. */
  readBy: string[];
  firstMonth: string;
  lastMonth: string;
  /** The market's as-of month: the cut-off. */
  asOfMonth: string;
  /**
   * Months a lag reads that read flat (the anchor): those after the history's last month, and, when the history starts
   * at or after the as-of month, those before its first month (no look-ahead).
   */
  flatAfter: number;
  /** Months a lag reads that fall before a first month dated before the as-of month: they read its first value (ruling D3). */
  flatBefore: number;
  /** The history's value at the as-of month, or null when it has none there. */
  asOfValue: number | null;
  /** The index's value at month 0 on the run's unshocked curve (its readers' parentAtCutoff). */
  curveMonth0: number;
}
