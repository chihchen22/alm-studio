/**
 * The derived curve types. Types plus two
 * convention constants and the curve cap; no runtime imports, so validate.ts and
 * rateIndex/rateIndices.ts can both import from here without a module cycle.
 */
import type { MarketSnapshot } from "@alm/kernel";

/**
 * The base id a derived curve names when the run's curve is the platform default curve (no curve setup):
 * curve default version 2, or version 1 on a market marked `curveDefault: 1` or one version 2 cannot take.
 */
export const PLATFORM_DEFAULT_CURVE = "platform-default";

/**
 * A derived curve's id: 1 to 70 of A-Z a-z 0-9 . _ -. The server holds the
 * twin as LINEAGE_PATTERN in apps/server/src/workspaces/rules.ts (the engine
 * does not import the server); keep the two equal.
 */
export const DERIVED_CURVE_ID_PATTERN = /^[A-Za-z0-9._-]{1,70}$/;

/** The most derived curves a market carries (decision 44); a launch pin therefore needs at most 1 + 12 ops. Its own constant, apart from the index cap. */
export const MAX_DERIVED_CURVES = 12;

export interface DerivedCurveSpread {
  /** Whole months, 1 to 360, strictly ascending across the grid. */
  readonly tenorMonths: number;
  /** Basis points added to the index rate after compounding. */
  readonly spreadBp: number;
}

export interface DerivedCurveBlock {
  /** The curve's own id; also its slot key in the workspace collection. */
  readonly id: string;
  readonly label: string;
  /** A curve setup's own id, or PLATFORM_DEFAULT_CURVE. */
  readonly base: string;
  readonly spreads: readonly DerivedCurveSpread[];
  /** Where the fill helper took the numbers from. Left out when the grid was typed. */
  readonly source?: { readonly from: string; readonly minus: string };
  /**
   * The platform default curve version (1 or 2) the spreads were estimated on, when `source.from` or
   * `source.minus` names PLATFORM_DEFAULT_CURVE. Additive and optional: the save
   * route alone writes it (a posted one is ignored); a curve stored before it existed, whose source names
   * platform-default, reads as estimated on version 1 (estimatedOnDefaultOf). The validator refuses it on a
   * typed grid and on a source of two curve setups.
   */
  readonly estimatedOnDefault?: 1 | 2;
}

/**
 * The market derivation op that adds a derived curve to the derivedCurves
 * block, or replaces the one with the same id (deriveMarketSnapshot). The
 * curve is stored as validateDerivedCurve returns it.
 */
export interface DerivedCurveSetOp {
  op: "set-derived-curve";
  curve: DerivedCurveBlock;
}

/**
 * Additive engine-only market block: left out when no set-derived-curve op
 * wrote it. The op writes it whether or not an index names the curve; the
 * server pins only the curves an index names.
 */
export type MarketWithDerivedCurves = MarketSnapshot & { derivedCurves?: readonly DerivedCurveBlock[] };
