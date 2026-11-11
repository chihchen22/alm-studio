/**
 * Rows for the Rates tab's charts, built from a run's rate document
 * (GET /api/runs/:id/rates). Studio Piece 3 adds previewRows, the
 * rows for a served shock preview (POST /api/scenarios/preview). Pure: no
 * React, no fetch, no runtime engine import. Every number returned is a stored
 * document or served preview field, a rate times RATE_TO_PCT (display scaling
 * to percent), or a [low, high] pair of such values that recharts draws as a
 * band. Nothing here computes a statistic.
 */
import type { RateDocument, StochasticRateFan } from "@alm/engine";
import type { ShockPreview } from "./api/client";

/** The document stores decimals; the axis shows percent. Display scaling only. */
export const RATE_TO_PCT = 100;

/** The series id of the base curve on the curve chart. */
export const BASE_SERIES_ID = "base";

/** Row keys a scenario id must not collide with. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["t", "month", BASE_SERIES_ID]);

export interface CurveRow {
  /** Tenor in years, the base curve's own node grid. */
  t: number;
  /** "base" and each scenarioId, zero rate in percent. */
  [seriesId: string]: number;
}

export interface PathRow {
  /** Month index k, 0-based; the rate is the one-month forward over [k, k+1). */
  month: number;
  [scenarioId: string]: number;
}

export interface FanRow {
  /** Step time in years, the fan's own `times[k]`. */
  t: number;
  mean: number;
  p50: number;
  /** [p5, p95] in percent, the outer band. */
  outer: [number, number];
  /** [p25, p75] in percent, the inner band. */
  inner: [number, number];
}

export interface OmittedPath {
  scenarioId: string;
  /** The document's own `pathOmitted` string, verbatim. */
  reason: string;
}

/** A row value (already percent) to two decimals with a percent sign: 4.25 -> "4.25%". */
export function pctPoints(v: number): string {
  return `${v.toFixed(2)}%`;
}

function assertNotReserved(scenarioId: string): void {
  if (RESERVED_KEYS.has(scenarioId)) {
    throw new Error(`scenario id "${scenarioId}" collides with a chart row key and cannot be charted`);
  }
}

/** Series ids in draw order: "base" first, then scenarioIds in document order. */
export function curveSeriesIds(doc: RateDocument): string[] {
  return [BASE_SERIES_ID, ...doc.scenarios.map((s) => s.scenarioId)];
}

/**
 * One row per base-curve node. Every scenario curve shares the base grid
 * (`shockedCurve` bumps the base nodes in place); a scenario with a different
 * node count is an error, never a silently resampled line.
 */
export function curveRows(doc: RateDocument): CurveRow[] {
  const n = doc.base.t.length;
  for (const s of doc.scenarios) {
    assertNotReserved(s.scenarioId);
    if (s.curve.t.length !== n) {
      throw new Error(
        `scenario "${s.scenarioId}" curve has ${s.curve.t.length} nodes; the base curve has ${n}`,
      );
    }
  }
  const rows: CurveRow[] = [];
  for (let i = 0; i < n; i++) {
    const row: CurveRow = { t: doc.base.t[i], [BASE_SERIES_ID]: doc.base.z[i] * RATE_TO_PCT };
    for (const s of doc.scenarios) row[s.scenarioId] = s.curve.z[i] * RATE_TO_PCT;
    rows.push(row);
  }
  return rows;
}

/**
 * One row per month for the scenarios that carry a path; the others are listed
 * with the document's own omission reason. No path is ever invented.
 */
export function pathRows(doc: RateDocument): { rows: PathRow[]; omitted: OmittedPath[] } {
  const omitted: OmittedPath[] = [];
  const withPath: { scenarioId: string; rate: number[] }[] = [];
  for (const s of doc.scenarios) {
    assertNotReserved(s.scenarioId);
    if (s.path === undefined) {
      omitted.push({
        scenarioId: s.scenarioId,
        reason: s.pathOmitted ?? "path omitted without a stated reason",
      });
    } else {
      withPath.push({ scenarioId: s.scenarioId, rate: s.path.rate });
    }
  }
  if (withPath.length === 0) return { rows: [], omitted };
  const h = doc.grid.horizonMonths;
  for (const s of withPath) {
    if (s.rate.length !== h) {
      throw new Error(`scenario "${s.scenarioId}" path has ${s.rate.length} months; the grid horizon is ${h}`);
    }
  }
  const rows: PathRow[] = [];
  for (let k = 0; k < h; k++) {
    const row: PathRow = { month: k };
    for (const s of withPath) row[s.scenarioId] = s.rate[k] * RATE_TO_PCT;
    rows.push(row);
  }
  return { rows, omitted };
}

/**
 * The per-step summary both fan arms carry: the Hull-White fan and the 1.2.0 BGM fan share `times`,
 * `mean` and `quantiles`, and only their model parameters differ, which the rows never read.
 */
type FanSteps = Pick<StochasticRateFan, "times" | "mean" | "quantiles">;

function quantileValues(fan: FanSteps, p: number): number[] {
  const q = fan.quantiles.find((x) => x.p === p);
  if (q === undefined) throw new Error(`fan has no p=${p} quantile`);
  if (q.values.length !== fan.times.length) {
    throw new Error(`fan p=${p} quantile has ${q.values.length} steps; times has ${fan.times.length}`);
  }
  return q.values;
}

/**
 * One row per simulation step. Quantiles are read by their `p`, never by
 * position. The band pairs are chart geometry for recharts' range areas over
 * stored quantiles, not a computed statistic.
 */
export function fanRows(fan: FanSteps): FanRow[] {
  const n = fan.times.length;
  if (fan.mean.length !== n) throw new Error(`fan mean has ${fan.mean.length} steps; times has ${n}`);
  const p5 = quantileValues(fan, 0.05);
  const p25 = quantileValues(fan, 0.25);
  const p50 = quantileValues(fan, 0.5);
  const p75 = quantileValues(fan, 0.75);
  const p95 = quantileValues(fan, 0.95);
  const rows: FanRow[] = [];
  for (let k = 0; k < n; k++) {
    rows.push({
      t: fan.times[k],
      mean: fan.mean[k] * RATE_TO_PCT,
      p50: p50[k] * RATE_TO_PCT,
      outer: [p5[k] * RATE_TO_PCT, p95[k] * RATE_TO_PCT],
      inner: [p25[k] * RATE_TO_PCT, p75[k] * RATE_TO_PCT],
    });
  }
  return rows;
}

/** One row of the Studio P3 shock preview: tenor, both zero rates in percent, the served shift. */
export interface PreviewRow {
  t: number;
  basePct: number;
  shockedPct: number;
  shiftBp: number;
}

/**
 * Rows for the shock preview. Every value is a served field: the two rates
 * times RATE_TO_PCT (display scaling), the tenor and the shift as served. A
 * reply whose arrays disagree in length, or that holds a value that is not a
 * finite number (JSON carries NaN and Infinity as null), is an error, never a
 * shortened table or a 0.00% (Studio Polish 1 S3). The check covers every array
 * the card reads: both tenor arrays, both rate arrays and the shifts. The two
 * discount-factor arrays stay unchecked, since the card never draws them.
 */
export function previewRows(p: ShockPreview): PreviewRow[] {
  const n = p.base.t.length;
  if (p.base.z.length !== n || p.shocked.t.length !== n || p.shocked.z.length !== n || p.shiftBp.length !== n) {
    throw new Error(
      `shock preview arrays disagree: base ${n} tenors and ${p.base.z.length} rates, shocked ${p.shocked.t.length} tenors and ${p.shocked.z.length} rates, ${p.shiftBp.length} shifts`,
    );
  }
  const fields: Array<[string, readonly unknown[]]> = [["base.t", p.base.t], ["base.z", p.base.z], ["shocked.t", p.shocked.t], ["shocked.z", p.shocked.z], ["shiftBp", p.shiftBp]];
  for (const [name, values] of fields) {
    const i = values.findIndex((v) => typeof v !== "number" || !Number.isFinite(v));
    if (i >= 0) throw new Error(`shock preview ${name}[${i}] is not a finite number: ${String(values[i])}`);
  }
  return p.base.t.map((t, i) => ({ t, basePct: p.base.z[i]! * RATE_TO_PCT, shockedPct: p.shocked.z[i]! * RATE_TO_PCT, shiftBp: p.shiftBp[i]! }));
}

/** A served bp shift to one decimal; a value that prints as zero prints unsigned ("0.0", never "-0.0"). */
export function bp1(v: number): string {
  const s = v.toFixed(1);
  return s === "-0.0" ? "0.0" : s;
}
