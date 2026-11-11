/**
 * The observational seam behind the per-position results file (schema 1.9.0). The run keeps no per-position output, so the server's pass after
 * the run recomputes each position; to compute on exactly what the run
 * computed on, the pipeline hands it the effective books, the rate paths and
 * the curve legs the walk used, once, after the envelope is assembled.
 *
 * Purely observational, like onProgress: the pipeline passes nothing back and
 * reads nothing from the observer, so its presence cannot move a number. The
 * values are live in-process objects (Map, RatePath, ZeroCurve), never
 * serialized; a throwing observer aborts the run. A failure to build the
 * environment does not: the observer receives the Error as a value and the run
 * completes, because the pass is optional and the envelope is already whole.
 */
import type { RatePath, TLPCurve, ZeroCurve } from "@alm/kernel";
import type { PortfolioSpec } from "../contracts/position";
import type { RateIndexTable } from "../contracts/rateIndex";
import type { DiscountBasis } from "../eve";
import type { RunMacro } from "../macro/runMacro";
import type { PositionSegRow } from "../seg";

export interface InstrumentEnvironment {
  baseScenarioId: string;
  /**
   * The effective book (behavioral overlays applied, deposit convention applied
   * when the run named it) per assumption set a scenario references, in
   * scenario first-appearance order. Every book holds the same positions in the
   * same order, so an index into one is an index into all.
   */
  booksBySet: ReadonlyMap<string, PortfolioSpec>;
  /** The rate path each scenario was projected on, in request order. */
  ratePaths: ReadonlyMap<string, RatePath>;
  /** The risk-free leg the scenarios' shocks are built from. */
  baseCurve: ZeroCurve;
  /** The all-in funding overlay. */
  tlp: TLPCurve;
  /** The basis the EVE block discounted on ("all-in" when the run named none). */
  discountBasis: DiscountBasis;
  rateIndices?: RateIndexTable;
  macro?: RunMacro;
  /** The SEG block's per-position rows; present only when the run opted in to seg. */
  perPositionSeg?: ReadonlyMap<string, PositionSegRow>;
  /**
   * The deposit warmup history per scenario id, present only when the
   * run named nmdWarmup; a deposit is then rebuilt on its scenario's history
   * (MakeInstrumentOptions nmdWarmup) so its row sums to the family the run
   * reported.
   */
  nmdWarmupByScenario?: ReadonlyMap<string, readonly number[]>;
  /**
   * Each scenario's short-rate shift in percent, present only when the run's sets bind a
   * full beta form; a full-form deposit is rebuilt at its scenario's level so its row sums to the family.
   */
  depositShiftByScenario?: ReadonlyMap<string, number>;
}
