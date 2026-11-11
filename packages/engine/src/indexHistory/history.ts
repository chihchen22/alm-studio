/**
 * The index history document's validator and its reads. Browser-safe: Studio imports this file
 * by path for the chart, the gap to the cut-off and the start fill. The validator is the one authority on a stored
 * document's shape; the server's import builds documents that pass it, and a run re-checks every document it is given.
 */
import {
  INDEX_HISTORY_ID_PATTERN,
  INDEX_HISTORY_LABEL_MAX_LENGTH,
  MAX_INDEX_HISTORY_MONTHS,
  type IndexHistory,
} from "../contracts/indexHistory";
import { monthAdd } from "../macro/macroFactors";
import { round12 } from "../rateIndex/record";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const KEYS = ["label", "firstMonth", "values", "source"];
const SOURCE_KEYS = ["fileName", "fileSha256", "format", "frequency", "rows", "unit"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : String(v));

export function isIndexHistoryId(v: unknown): v is string {
  return typeof v === "string" && INDEX_HISTORY_ID_PATTERN.test(v);
}

export function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

export function historyLastMonth(h: IndexHistory): string {
  return monthAdd(h.firstMonth, h.values.length - 1);
}

/** The month-end fixing of `month`, or undefined outside the series. */
export function historyValueAt(h: IndexHistory, month: string): number | undefined {
  const k = monthIndex(month) - monthIndex(h.firstMonth);
  return k >= 0 && k < h.values.length ? h.values[k] : undefined;
}

/**
 * The start value of a beta index from its own history (decision 53): the as-of month's fixing minus the basis, in
 * basis points, so that start plus basis, the index's month-0 value, is the published fixing (B3b ruling D2). A
 * history with no value at the as-of month refuses, naming its last (or first) month; the user types the start.
 */
export function startFromHistory(h: IndexHistory, asOfMonth: string, basisBp: number): { startBp: number } | { refusal: string } {
  const v = historyValueAt(h, asOfMonth);
  if (v === undefined) {
    return monthIndex(asOfMonth) > monthIndex(historyLastMonth(h))
      ? { refusal: `the history ends ${historyLastMonth(h)}, before the cut-off month ${asOfMonth}; type the start value` }
      : { refusal: `the history starts ${h.firstMonth}, after the cut-off month ${asOfMonth}; type the start value` };
  }
  return { startBp: round12(v * 10000 - basisBp) };
}

/** The history ids the indices of a market name, distinct and sorted. Tolerant: a malformed block names none. */
export function namedHistoryIdsOf(market: unknown): string[] {
  const block = isObj(market) ? market.rateIndices : undefined;
  if (!Array.isArray(block)) return [];
  const ids = new Set<string>();
  for (const e of block as unknown[]) {
    const h = isObj(e) ? e.historyId : undefined;
    if (typeof h === "string") ids.add(h);
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function validateIndexHistory(doc: unknown): string[] {
  if (!isObj(doc)) return ["an index history is an object with label, firstMonth, values and source"];
  const out: string[] = [];
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) out.push(`unknown field ${JSON.stringify(k)}; an index history carries label, firstMonth, values and source`);
  const label = typeof doc.label === "string" ? doc.label.trim() : "";
  if (label.length === 0 || label.length > INDEX_HISTORY_LABEL_MAX_LENGTH) out.push(`label must be 1 to ${INDEX_HISTORY_LABEL_MAX_LENGTH} characters`);
  const firstOk = typeof doc.firstMonth === "string" && MONTH.test(doc.firstMonth);
  if (!firstOk) out.push(`firstMonth must be a month YYYY-MM; got ${show(doc.firstMonth)}`);
  const v = doc.values;
  if (!Array.isArray(v) || v.length === 0) out.push("values must list 1 to 1,200 monthly values");
  else if (v.length > MAX_INDEX_HISTORY_MONTHS) out.push(`values must list 1 to 1,200 monthly values; got ${v.length}`);
  else {
    v.forEach((x: unknown, i) => {
      if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1) {
        const where = firstOk ? ` (${monthAdd(doc.firstMonth as string, i)})` : "";
        out.push(`values[${i}]${where} must be a finite decimal rate from -1 to 1; got ${show(x)}`);
      }
    });
  }
  const s = doc.source;
  if (!isObj(s)) {
    out.push("source must be an object with fileName, fileSha256, format, frequency, rows and unit");
    return out;
  }
  for (const k of Object.keys(s)) if (!SOURCE_KEYS.includes(k)) out.push(`unknown field ${JSON.stringify(k)} in source; a source carries fileName, fileSha256, format, frequency, rows and unit`);
  if (typeof s.fileName !== "string" || s.fileName.length === 0 || s.fileName.length > 255) out.push("source.fileName must be 1 to 255 characters");
  if (typeof s.fileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.fileSha256)) out.push("source.fileSha256 must be 64 lowercase hex characters");
  if (s.format !== "csv" && s.format !== "xlsx") out.push(`source.format must be csv or xlsx; got ${show(s.format)}`);
  if (s.frequency !== "daily" && s.frequency !== "monthly") out.push(`source.frequency must be daily or monthly; got ${show(s.frequency)}`);
  if (typeof s.rows !== "number" || !Number.isInteger(s.rows) || s.rows < 1) out.push(`source.rows must be a whole number of at least 1; got ${show(s.rows)}`);
  if (s.unit !== "percent" && s.unit !== "decimal") out.push(`source.unit must be percent or decimal; got ${show(s.unit)}`);
  return out;
}
