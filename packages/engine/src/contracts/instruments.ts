/**
 * The per-position results file (schema 1.9.0). The server
 * writes it AFTER result.json, as a separate document, so the run envelope is
 * never touched by it. RunResult.instrumentsFile is declared but nothing writes
 * it; the route is the way in. Types and one constant; the compute lives in the
 * server's instruments pass.
 *
 * Units: dollars and decimals. Months are 1-based month offsets. Ordered arrays
 * only, no Float64Array or Map, no NaN. An absent optional field is
 * left out, never null.
 */
import type { DimensionBag } from "./dimensions";

/**
 * The schema a file is written at. 1.1.0 (Spec P1): a balance held at book is valued at par in every scenario. A
 * stored 1.0.0 file, written before, reads 0 for it and stays as it is (slice K1 widened the type to both).
 */
export const INSTRUMENTS_SCHEMA_VERSION = "1.1.0";

/** The first schema whose rows value a balance held at book at par; an older file reads 0 for it. */
export const INSTRUMENTS_PAR_SINCE = "1.1.0";

/** Every schema a stored file may carry. */
export type InstrumentsSchemaVersion = "1.0.0" | "1.1.0";

/** One position under one scenario. */
export interface InstrumentScenarioRow {
  scenarioId: string;
  /** Present value on the run's discount basis. */
  pv: number;
  /** Net interest income over the first 12 months. */
  nii12: number;
  /** Balance at month 12. */
  balance12: number;
  /** Principal received in the first 12 months. */
  principal12: number;
}

export interface InstrumentRow {
  positionId: string;
  parentPositionId?: string;
  familyId: string;
  coaNodeId: string;
  /**
   * "derivative" for a swap position: its family is declared on the derivative
   * side and its rows are net settlements.
   */
  side: "asset" | "liability" | "derivative";
  type: string;
  notional: number;
  dimensions: DimensionBag;
  discountSpreadBp?: number;
  /**
   * Principal-weighted average life, in months, of the base scenario's in-horizon
   * runoff. Left out when the position has no positive in-horizon principal
   * (a commitment, a swap, a position past the horizon): the engine does not
   * print 0 where "undefined" is the truth.
   */
  walMonths?: number;
  /**
   * First month in which the position reprices; null when it never does inside
   * the horizon.
   */
  firstRepricingMonth: number | null;
  byScenario: InstrumentScenarioRow[];
  /**
   * Present when the run opted in to seg. The arrays are included only on a
   * book of at most 100 positions.
   */
  seg?: {
    niiBase12: number;
    niiUp12: number;
    niiDown12: number;
    segPeak: number;
    segOutstanding?: number[];
    ebp?: number[];
  };
}

export interface InstrumentsFile {
  schemaVersion: InstrumentsSchemaVersion;
  runId: string;
  asOf: string;
  horizonMonths: number;
  discountBasis: string;
  scenarios: string[];
  positions: InstrumentRow[];
}
