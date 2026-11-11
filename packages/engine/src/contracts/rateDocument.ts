/**
 * The rate document: what a run ran on, kept beside its result.
 *
 * A run builds one shocked zero curve and one monthly rate path per scenario,
 * projects the book on them, and keeps only the numbers they produced. This
 * document keeps the objects themselves, rebuilt AFTER the run from the request
 * by the same functions the run used, so a chart can be drawn from a stored run
 * without recomputation. It is its own file (`rates.json`) and its own schema:
 * the result envelope does not change (ruling 1, 2026-09-17).
 *
 * A stochastic run keeps a FAN of its base scenario's short rate, per step the
 * mean and the five pinned quantiles across paths, and never an individual path
 * (ruling 2).
 */
import type { CurveConvention } from "@alm/kernel";
import type { DimensionPredicate } from "./dimensions";

/**
 * 1.1.0 adds the optional `clientRates` arm on a scenario. Stored 1.0.0
 * documents carry none and stay readable.
 *
 * 1.2.0 adds the BGM arm of the
 * stochastic fan (`BgmRateFan`). The one constant is stamped on every document,
 * deterministic and Hull-White included, so a document written after the slice
 * differs from a 1.1.0 build of the same request in `schemaVersion` alone. Stored
 * 1.0.0 and 1.1.0 documents stay readable.
 */
export const RATE_DOCUMENT_SCHEMA_VERSION = "1.2.0";

/** A zero curve sampled at its own nodes. `df[i] = exp(-z[i] * t[i])`. */
export interface CurveNodes {
  /** Tenors in years, ascending, the curve's own node grid. */
  t: number[];
  /** Continuously compounded zero rates at `t`. */
  z: number[];
  /** Discount factors at `t`. */
  df: number[];
}

/** The monthly deterministic path the kernel read for one scenario. */
export interface MonthlyRatePath {
  /** Time grid in years, length `horizonMonths + 1`, `times[0] = 0`. */
  times: number[];
  /**
   * `rate[k]` is the path's `rateAt(k)` for `k` in `0 .. horizonMonths - 1`: the
   * one-month forward swap rate over `[times[k], times[k + 1]]`, the same value a
   * one-month floater reads at step `k`. Length `horizonMonths`.
   */
  rate: number[];
}

/**
 * One flat-carry client-rate path: the 10-year benchmark on the
 * scenario's shocked curve plus one constant total spread. Both arrays are
 * decimals (0.0425 = 4.25%) of length `grid.horizonMonths`, and index k is month
 * k + 1. No floor and no cap is applied, so a negative value is written as
 * computed. Nothing in the run reads this path.
 */
export interface ClientRateRow {
  assumptionSetId: string;
  familyId: string;
  /** The binding's selector as stored; absent when the binding covers the whole family. */
  selector?: DimensionPredicate;
  model: "flat-carry";
  /** Read off the scenario's shocked curve, never written as a literal. */
  curveConvention: CurveConvention;
  benchmarkTenorYears: number;
  /** The one total spread over the benchmark, in basis points. */
  totalSpreadBp: number;
  /**
   * `benchmark[k]` is `path.forwardRateAt(k, 10)` in decimals: the 10-year forward
   * par yield on the curve's own convention (the forward Treasury CMT par yield
   * on a semiannual_bond curve).
   */
  benchmark: number[];
  /** `benchmark[k] + totalSpreadBp / 1e4`. */
  clientRate: number[];
}

export interface ScenarioRates {
  scenarioId: string;
  /** The scenario's `rateSpec.kind`, copied so a chart can label the line. */
  rateSpecKind: "base" | "parallel" | "twist" | "custom";
  /** The scenario's `ratePathModel`, or `"deterministic"` when it named none. */
  ratePathModel: string;
  /** The shocked zero curve the scenario ran on. Present on every scenario. */
  curve: CurveNodes;
  /**
   * Present when `ratePathModel` is `"deterministic"`. Absent otherwise, with
   * `pathOmitted` saying why: the builder recomputes the deterministic path only,
   * and never fakes a path for a model it did not run.
   */
  path?: MonthlyRatePath;
  pathOmitted?: string;
  /**
   * One row per loan-client-rate binding of the scenario's assumption
   * set, in binding order. Present only when the scenario has a deterministic
   * path and its set carries at least one such binding.
   */
  clientRates?: ClientRateRow[];
}

/** The short-rate fan of a stochastic run's base scenario. */
export interface StochasticRateFan {
  scenarioId: string;
  nPaths: number;
  /** Hull-White parameters the simulation used, as the envelope reports them. */
  a: number;
  sigma: number;
  /** Simulation step times in years, length `nSteps` (the kernel's `sim.times`). */
  times: number[];
  /** Sample mean of the short rate across paths at each step. Length `nSteps`. */
  mean: number[];
  /**
   * One entry per pinned quantile, in `STOCHASTIC_QUANTILES` order. `values[k]` is
   * the quantile of the short rate across paths at step `k`, by the same
   * order-statistic interpolation the envelope's distributions use.
   */
  quantiles: { p: number; values: number[] }[];
}

/**
 * The BGM twin of the fan (1.2.0): the same per-step summary of a BGM run's base
 * scenario, read off the 1D saved tenor of the kernel simulation (the shortest
 * saved forward, the BGM stand-in for the short rate). The simulation is always
 * 360 months (decision 97); the fan keeps its first `grid.horizonMonths` rows.
 */
export interface BgmRateFan {
  scenarioId: string;
  nPaths: number;
  model: "bgm-lmm-2f";
  /** The Rebonato two-factor parameters and the shifted-CEV pair the simulation used. */
  bgm: {
    a: number;
    b: number;
    c: number;
    d: number;
    beta: number;
    volScalar: number;
    displacement: number;
    cevBeta: number;
  };
  /** Simulation step times in years, the first `horizonMonths` of the kernel's `sim.times`. */
  times: number[];
  /** Sample mean of the 1D saved forward across paths at each step. Length `horizonMonths`. */
  mean: number[];
  /** As on the Hull-White fan, over the 1D saved forward. */
  quantiles: { p: number; values: number[] }[];
}

export interface RateDocument {
  schemaVersion: "1.0.0" | "1.1.0" | "1.2.0";
  kind: "rate-document";
  runId: string;
  mode: "deterministic" | "stochastic";
  grid: { horizonMonths: number; dtYears: number; asOf: string };
  /** The base curve built from the request's market snapshot: its curve setup, or the platform default curve. */
  base: CurveNodes;
  /** One entry per scenario on the request, in request order. */
  scenarios: ScenarioRates[];
  /** Present only on a stochastic run. A BGM fan carries `model`; the Hull-White fan carries none. */
  stochastic?: StochasticRateFan | BgmRateFan;
}
