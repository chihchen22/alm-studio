/** The macroFactors block: limits, validator and table. Types-only imports, browser-safe. */
import type { DerivationProblem } from "../contracts/derivation";
import type { MacroSeries } from "../contracts/macroFactors";

/** Restated from rateIndex/rateIndices.ts, which this module may not import (Section 8 fence); a test pins equality. */
export const MACRO_SERIES_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const MACRO_SERIES_ID_MAX_LENGTH = 40;
export const MAX_MACRO_SERIES = 8;
export const MAX_MACRO_VALUES = 1200;
export const INDEX_PROJECTION_MIN = 0.25;
export const INDEX_PROJECTION_MAX = 4;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const SERIES_KEYS = ["id", "label", "kind", "role", "unit", "firstMonth", "values", "source"];
const HISTORY_SOURCE_KEYS = ["seriesId", "provider", "url", "retrievedOn", "vintage", "endMonth", "rawFileSha256", "knownGaps"];

export function monthAdd(month: string, k: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const n = y * 12 + (m - 1) + k;
  return `${String(Math.floor(n / 12)).padStart(4, "0")}-${String((n % 12) + 1).padStart(2, "0")}`;
}

/** The market's as-of month YYYY-MM, or null when its calibrationDate is missing or does not start with a month; each caller refuses null by name. */
export function asOfMonthOf(market: { calibrationDate?: unknown }): string | null {
  const d = market.calibrationDate;
  if (typeof d !== "string") return null;
  const month = d.slice(0, 7);
  return MONTH.test(month) ? month : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): boolean => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : String(v));

export function validateMacroFactors(block: unknown, asOfMonth: string, at = "macroFactors"): DerivationProblem[] {
  const out: DerivationProblem[] = [];
  const add = (path: string, message: string): void => void out.push({ at: path, message: `${path}: ${message}` });
  if (!MONTH.test(asOfMonth)) { add(at, `the market's as-of month is not a month YYYY-MM (got ${show(asOfMonth)}), so no series can be checked against it`); return out; }
  if (!Array.isArray(block)) { add(at, "expected a list of macro series"); return out; }
  if (block.length > MAX_MACRO_SERIES) add(at, `at most ${MAX_MACRO_SERIES} series; got ${block.length}`);
  const seen = new Set<string>(); const dups: string[] = [];
  block.forEach((entry: unknown, i) => {
    const p = `${at}[${i}]`;
    if (!isObj(entry)) { add(p, "expected a macro series object"); return; }
    for (const k of Object.keys(entry)) if (!SERIES_KEYS.includes(k)) add(p, `unknown field ${JSON.stringify(k)}; a series carries id, label, kind, role, unit, firstMonth, values and source`);
    const { id, label, kind, role, unit, firstMonth, values, source } = entry;
    if (typeof id !== "string" || id.length > MACRO_SERIES_ID_MAX_LENGTH || !MACRO_SERIES_ID_PATTERN.test(id)) add(`${p}.id`, `expected a lowercase id of letters, digits and single hyphens, starting with a letter, at most 40 characters; got ${show(id)}`);
    else if (seen.has(id)) { if (!dups.includes(id)) dups.push(id); } else seen.add(id);
    if (!text(label, 120)) add(`${p}.label`, "expected a non-empty label of at most 120 characters");
    if (!text(unit, 40)) add(`${p}.unit`, "expected a non-empty unit of at most 40 characters");
    if (kind !== "index" && kind !== "rate") add(`${p}.kind`, `expected index or rate; got ${show(kind)}`);
    if (role !== "history" && role !== "projection") add(`${p}.role`, `expected history or projection; got ${show(role)}`);
    if (typeof firstMonth !== "string" || !MONTH.test(firstMonth)) { add(`${p}.firstMonth`, `expected a month YYYY-MM; got ${show(firstMonth)}`); return; }
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_MACRO_VALUES) { add(`${p}.values`, `expected 1 to ${MAX_MACRO_VALUES} monthly values`); return; }
    if (role === "projection") {
      if (firstMonth !== monthAdd(asOfMonth, 1)) add(`${p}.firstMonth`, `a projection starts the month after the as-of, ${monthAdd(asOfMonth, 1)}; got ${firstMonth}`);
      values.forEach((v: unknown, j) => {
        if (typeof v !== "number" || !Number.isFinite(v)) add(`${p}.values[${j}]`, `a projection carries a finite number every month; got ${show(v)}`);
        else if (kind === "index" && !(v >= INDEX_PROJECTION_MIN && v <= INDEX_PROJECTION_MAX)) add(`${p}.values[${j}]`, `an index projection lies from ${INDEX_PROJECTION_MIN} to ${INDEX_PROJECTION_MAX}; got ${v}`);
        else if (kind === "rate" && !(v >= 0 && v <= 1)) add(`${p}.values[${j}]`, `a rate is a decimal from 0 to 1; got ${v}`);
      });
      if (!isObj(source) || source.authored !== true || !text(source.note, 400) || Object.keys(source).some((k) => k !== "authored" && k !== "note"))
        add(`${p}.source`, "a projection's source is { authored: true, note } with a note of at most 400 characters");
      return;
    }
    if (role !== "history") return;
    const end = monthAdd(firstMonth, values.length - 1);
    if (end !== asOfMonth) add(p, `a history ends at the market as-of month ${asOfMonth}; this one ends at ${end}`);
    const s = isObj(source) ? source : {};
    for (const k of Object.keys(s)) if (!HISTORY_SOURCE_KEYS.includes(k)) add(`${p}.source`, `unknown field ${JSON.stringify(k)} on a history source`);
    for (const k of ["seriesId", "provider", "url", "vintage"]) if (!text(s[k], 400)) add(`${p}.source.${k}`, "expected non-empty text");
    if (typeof s.retrievedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.retrievedOn)) add(`${p}.source.retrievedOn`, "expected a date YYYY-MM-DD");
    if (typeof s.rawFileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.rawFileSha256)) add(`${p}.source.rawFileSha256`, "expected 64 lowercase hex characters");
    if (s.endMonth !== asOfMonth) add(`${p}.source.endMonth`, `expected the as-of month ${asOfMonth}; got ${show(s.endMonth)}`);
    const gaps = Array.isArray(s.knownGaps) ? (s.knownGaps as unknown[]) : null;
    if (gaps === null) { add(`${p}.source.knownGaps`, "expected a list of months, empty when the provider published every month"); return; }
    const gapSet = new Set<string>();
    for (const g of gaps) {
      if (typeof g !== "string" || !MONTH.test(g) || g < firstMonth || g > end || gapSet.has(g)) { add(`${p}.source.knownGaps`, `expected unique months inside ${firstMonth} to ${end}; got ${show(g)}`); continue; }
      gapSet.add(g);
    }
    values.forEach((v: unknown, j) => {
      const month = monthAdd(firstMonth, j);
      if (v === null) { if (!gapSet.has(month)) add(`${p}.values[${j}]`, `${month} is null; a history may carry null only at a month its source lists in knownGaps`); return; }
      if (gapSet.has(month)) { add(`${p}.source.knownGaps`, `${month} is listed as a gap the provider did not publish, but the series carries a value there`); return; }
      if (typeof v !== "number" || !Number.isFinite(v)) add(`${p}.values[${j}]`, `expected a finite number or a listed gap; got ${show(v)}`);
      else if (kind === "index" && !(v > 0)) add(`${p}.values[${j}]`, `a history index is above 0; got ${v}`);
      else if (kind === "rate" && !(v >= 0 && v <= 1)) add(`${p}.values[${j}]`, `a rate is a decimal from 0 to 1; got ${v}`);
    });
  });
  for (const id of dups) add(at, `series id ${JSON.stringify(id)} appears more than once`);
  return out;
}

export function macroSeriesTable(block: readonly MacroSeries[] | undefined): ReadonlyMap<string, MacroSeries> {
  const m = new Map<string, MacroSeries>();
  for (const s of block ?? []) m.set(s.id, s);
  return m;
}
