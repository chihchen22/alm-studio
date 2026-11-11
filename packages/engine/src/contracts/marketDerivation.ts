/**
 * Market derivation contract: the funding spread shock,
 * the rate index ops, the short-rate volatility ops,
 * the macro series ops and the curve setup op.
 *
 * Types only (type imports), so Studio and the reader client can name them by
 * path without pulling the derivation, and its node:crypto hash, into a
 * bundle. The function that produces them is deriveMarketSnapshot, in
 * market/deriveMarketSnapshot.ts. Spreads are decimals (0.005 is 50 bp); only
 * the add op and the rate index ops take basis points. The short-rate
 * volatility ops move the constructed illustrative short-rate volatility
 * analog (capQuotes), which only a stochastic run reads; scale is dimensionless
 * and add takes basis points of normal volatility.
 */
import type { DerivationProblem } from "./derivation";
import type { MarketWithIndices, RateIndexBasisOp, RateIndexHistoryOp, RateIndexSetOp } from "./rateIndex";
import type { MacroSeriesRemoveOp, MacroSeriesSetOp, MarketWithMacro } from "./macroFactors";
import type { CurveSetupSetOp, MarketWithCurveSetup } from "./curveSetup";
import type { DerivedCurveSetOp, MarketWithDerivedCurves } from "./derivedCurve";

/** Names one stored TLP node by its tenor in years. The node at t = 0 is pinned and cannot be named. */
export interface TlpNodeAddress {
  tYears: number;
}

/** add: spread + value / 10000 (value in basis points); scale: spread * value (a factor greater than 0). */
export type MarketShockOpKind = "add" | "scale";

/** One change to the TLP nodes: every node except t = 0 when there is no target, else the one named node. */
export interface MarketShockOp {
  target?: TlpNodeAddress;
  op: MarketShockOpKind;
  /** Basis points for add; a factor greater than 0 for scale. */
  value: number;
}

/** scale-short-rate-vol: vol * value (a factor from 0.25 to 4); add-short-rate-vol: vol + value / 10000 (value in basis points of normal vol). */
export type ShortRateVolOpKind = "scale-short-rate-vol" | "add-short-rate-vol";

/** Names one expiry row of the short-rate volatility surface by its expiry in years; it must carry an at-the-money quote. */
export interface ShortRateVolExpiryAddress {
  expiryYears: number;
}

/** One change to the short-rate volatilities: every expiry row when there is no target, else the one named row (the at-the-money quote and every strike in it). */
export interface ShortRateVolOp {
  target?: ShortRateVolExpiryAddress;
  op: ShortRateVolOpKind;
  /** A factor from 0.25 to 4 for scale; basis points of normal volatility for add. */
  value: number;
}

/** Any op a market derivation takes: a TLP shock, a rate index op, a short-rate volatility op, a macro series op, the curve setup op, the derived curve op, or the index history op. */
export type MarketDeriveOp =
  | MarketShockOp
  | RateIndexSetOp
  | RateIndexBasisOp
  | RateIndexHistoryOp
  | ShortRateVolOp
  | MacroSeriesSetOp
  | MacroSeriesRemoveOp
  | CurveSetupSetOp
  | DerivedCurveSetOp;

/** The record a derived market carries: its immediate base and the ops applied, normalized. */
export interface MarketDerivedFrom {
  baseId: string;
  /** The engine canonical contentHash of the base snapshot. */
  baseContentHash: string;
  ops: MarketDeriveOp[];
}

/** A market snapshot, optionally carrying the additive rateIndices, macro factors, curveSetup and derivedCurves blocks and derivedFrom record. The kernel type is not edited. */
export type DerivedMarketSnapshot = MarketWithIndices & MarketWithMacro & MarketWithCurveSetup & MarketWithDerivedCurves & { derivedFrom?: MarketDerivedFrom };

/** One TLP node touched, with its spread before and after, computed in the engine. */
export interface TlpNodeChange {
  nodeIndex: number;
  tYears: number;
  from: number;
  to: number;
  /** (to - from) in basis points, computed in the engine. */
  changeBp: number;
  /** Indices into the op list, in order, of the ops that touched this node. */
  ops: number[];
}

/** One expiry row of the short-rate volatility surface touched, computed in the engine. */
export interface ShortRateVolChange {
  expiryYears: number;
  /** How many quotes the row carries (the at-the-money quote and every strike). */
  quotes: number;
  /** How many of them ended with a different value. */
  quotesChanged: number;
  /** The at-the-money normal vol (decimal) before and after; null when the row carries no at-the-money quote. */
  atmFrom: number | null;
  atmTo: number | null;
  /** (atmTo - atmFrom) in basis points, computed in the engine; null when atmFrom is. */
  atmChangeBp: number | null;
  /** Indices into the op list, in order, of the ops that touched this row. */
  ops: number[];
}

/** One refusal, reused from the behavioral derivation: where it sits and why. */
export type MarketDerivationProblem = DerivationProblem;
