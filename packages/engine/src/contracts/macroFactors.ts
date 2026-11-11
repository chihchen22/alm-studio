/**
 * Macro factors contract.
 *
 * Types only (type imports), so Studio and the reader client can name them by
 * path without pulling the validator into a bundle. A macro series is monthly
 * market data on a derived market: a history ends at the market's as-of month
 * and feeds no run; a projection starts the month after, is authored, and is
 * never an engine forecast.
 *
 * The block lives on the market as an additive, engine-only `macroFactors`
 * list. The kernel MarketSnapshot type is not edited.
 */
import type { MarketSnapshot } from "@alm/kernel";
import type { DimensionPredicate } from "./dimensions";
import type { ProductFamilyId } from "./ids";

/** index: a level rebased to the as-of (ratio); rate: a decimal (0.043 is 4.3 percent). */
export type MacroSeriesKind = "index" | "rate";

/** history: provider data up to the as-of month; projection: authored values from the month after. */
export type MacroSeriesRole = "history" | "projection";

/** Where a history came from: the raw provider file it was cut from, by hash. */
export interface MacroHistorySource {
  seriesId: string;
  provider: string;
  url: string;
  /** YYYY-MM-DD */
  retrievedOn: string;
  vintage: string;
  /** YYYY-MM, equals the market as-of month */
  endMonth: string;
  /** 64 lowercase hex */
  rawFileSha256: string;
  /** YYYY-MM months the provider did not publish; [] when none */
  knownGaps: string[];
}

/** A projection is the author's, never an engine forecast. */
export interface MacroProjectionSource {
  authored: true;
  note: string;
}

/** One monthly macro series. */
export interface MacroSeries {
  id: string;
  label: string;
  kind: MacroSeriesKind;
  role: MacroSeriesRole;
  unit: string;
  /** YYYY-MM */
  firstMonth: string;
  /** null only in role history, only at source.knownGaps */
  values: Array<number | null>;
  source: MacroHistorySource | MacroProjectionSource;
}

/** A market snapshot, optionally carrying the additive macroFactors block. */
export type MarketWithMacro = MarketSnapshot & { macroFactors?: MacroSeries[] };

/** Adds or replaces one macro series by id. */
export interface MacroSeriesSetOp {
  op: "set-macro-series";
  id: string;
  label: string;
  kind: MacroSeriesKind;
  role: MacroSeriesRole;
  unit: string;
  firstMonth: string;
  values: Array<number | null>;
  source: MacroHistorySource | MacroProjectionSource;
}

/** Removes one macro series the market carries at that point in the op list. */
export interface MacroSeriesRemoveOp {
  op: "remove-macro-series";
  seriesId: string;
}

/** One macro series touched by a derivation, first touch first. */
export interface MacroSeriesChange {
  id: string;
  change: "added" | "replaced" | "removed";
  /** Indices into the op list, in order, of the ops that touched this series. */
  ops: number[];
}

/** The one feeder: the house-price response of the four-factor prepayment. */
export type MacroFeeder = "prepay-housing";

/** Maps one series to one feeder on one family, optionally narrowed by a selector. */
export interface MacroBinding {
  seriesId: string;
  feeder: MacroFeeder;
  familyId: ProductFamilyId;
  selector?: DimensionPredicate;
}

/** One family (and selector) a run's macro path reaches. */
export interface MacroTarget {
  familyId: ProductFamilyId;
  selector?: DimensionPredicate;
}

/** The optional housing group of the four-factor prepayment; every value illustrative. */
export interface HousingParams {
  asOfLtv: number;
  refiLtvMid: number;
  refiLtvSlope: number;
  turnoverLtvMid: number;
  turnoverLtvSlope: number;
  turnoverFloorShare: number;
  /** percent CPR, the unit of params.minCpr */
  turnoverCprFloor: number;
}
