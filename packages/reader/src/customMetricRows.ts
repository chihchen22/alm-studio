/**
 * Rows for the Results page Metrics tab. A CustomMetricResult is a
 * fixed scalar table (per scenario, named finite numbers, optional family
 * rows). These helpers lay it out by declared key order and format by declared
 * unit; nothing here sorts, averages, fills, or differences. A key absent from
 * a row is null: unobservable, never 0.
 */
import type { CustomMetricResult, CustomMetricUnit } from "@alm/engine";
import { pct, usdMM } from "./format";

/** The text shown for a value the metric left out of a row. Never 0, never a dash. */
export const UNOBSERVABLE = "unobservable";

/** Display by declared unit; the number is a stored field, the unit its declared label. */
export function formatValue(unit: CustomMetricUnit, v: number): string {
  switch (unit) {
    case "currency":
      return usdMM(v);
    case "fraction":
      return pct(v, 2);
    case "months":
      return `${v.toFixed(1)} mo`;
    case "bp":
      return `${v.toFixed(1)} bp`;
    case "count":
      return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
}

/** Short unit suffix for a column header or an axis: "$M", "%", "mo", "bp", "" (count). */
export function unitSuffix(unit: CustomMetricUnit): string {
  switch (unit) {
    case "currency":
      return "$M";
    case "fraction":
      return "%";
    case "months":
      return "mo";
    case "bp":
      return "bp";
    case "count":
      return "";
  }
}

export interface MetricRow {
  /** scenarioId or familyId. */
  id: string;
  /** One entry per declared key, in `keys` order; null where the row carries no such key. */
  values: Array<number | null>;
}

function rowOf(m: CustomMetricResult, id: string, values: Record<string, number>): MetricRow {
  return {
    id,
    values: m.keys.map((k) => {
      const v = values[k.id];
      return v === undefined ? null : v;
    }),
  };
}

/** One row per scenario, request order; absent keys are null. */
export function scenarioRows(m: CustomMetricResult): MetricRow[] {
  return m.byScenario.map((s) => rowOf(m, s.scenarioId, s.values));
}

/**
 * The family rows of one scenario in envelope order, or null when that
 * scenario carries none (`byFamily` absent) or the scenario is not on the metric.
 */
export function familyRows(m: CustomMetricResult, scenarioId: string): MetricRow[] | null {
  const s = m.byScenario.find((row) => row.scenarioId === scenarioId);
  if (s === undefined || s.byFamily === undefined) return null;
  return s.byFamily.map((f) => rowOf(m, f.familyId, f.values));
}

export interface KeyBar {
  scenarioId: string;
  value: number;
}

/**
 * The observed scenario values of one key, request order, absent scenarios
 * skipped; [] when no scenario observes the key. Throws naming the key when it
 * is not declared.
 */
export function keyBars(m: CustomMetricResult, keyId: string): KeyBar[] {
  if (!m.keys.some((k) => k.id === keyId)) {
    throw new Error(`key ${keyId} is not declared on metric ${m.metricId}`);
  }
  const out: KeyBar[] = [];
  for (const s of m.byScenario) {
    const v = s.values[keyId];
    if (v !== undefined) out.push({ scenarioId: s.scenarioId, value: v });
  }
  return out;
}
