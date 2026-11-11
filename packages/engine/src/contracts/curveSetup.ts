import type { MarketSnapshot } from "@alm/kernel";

export type CurveInterpolation = "linear-zero" | "log-linear-df" | "cubic-zero" | "monotone-convex";
export type CurveDayCount = "ACT/360" | "ACT/365";
export type CurveCompounding = "annual" | "semi-annual" | "continuous";
export type CurveQuoteType = "par-rate" | "zero-rate" | "discount-factor";
export type CurveInstrument = "cash" | "ois-swap" | "futures";

/** One row of the typed grid. A futures row's tenorMonths is the START of a 3-month period. */
export interface CurveInput {
  readonly instrument: CurveInstrument;
  readonly tenorMonths: number;
  readonly quoteType: CurveQuoteType;
  /** Decimal: 0.04 is 4 percent. A discount-factor row carries the factor itself. A futures row carries the price (for example 95.8). */
  readonly value: number;
  /** Futures only, basis points, optional. */
  readonly convexityBp?: number;
}

export interface CurveSetupBlock {
  readonly id: string;
  readonly label: string;
  /** Curve family label shown on screen (SOFR, UST). Metadata in B1; carries no behaviour. */
  readonly baseCurve: string;
  readonly interpolation: CurveInterpolation;
  readonly dayCount: CurveDayCount;
  readonly compounding: CurveCompounding;
  readonly inputs: readonly CurveInput[];
}

/**
 * Additive engine-only market fields, each left out when unused.
 * `curveSetup` is the block a market's base curve builds from. `curveDefault` is the curve
 * default version 1 marker: only the value 1 is valid, and it
 * selects the kernel bootstrap for a market with no curveSetup block; a curveSetup block wins
 * over it. It is hashed with the market document like any other field. Seeds set it on a parsed
 * snapshot (the kernel parser drops unknown keys); no derive op and no Studio control writes it.
 */
export type MarketWithCurveSetup = MarketSnapshot & { curveSetup?: CurveSetupBlock; curveDefault?: 1 };

/**
 * The curve default version a market with no curveSetup builds on (spec v7
 * decision 57). Version 1 is the kernel bootstrap, linear in zero; version 2
 * is the engine curve builder, log-linear on discount factor, from the setup
 * defaultSetupFromSnapshot fills from the snapshot's quotes.
 */
export const CURVE_DEFAULT_VERSION = 2;

/**
 * Which curve a run built on. A run with no
 * curveSetup reads kind "default" with its version; a fallback to version 1,
 * for a snapshot the version 2 default cannot represent, carries the reason
 * in words. A run on a setup reads kind "setup" with the setup's id.
 */
export type CurveDefaultStamp =
  | { readonly kind: "default"; readonly version: 1 | 2; readonly reason?: string }
  | { readonly kind: "setup"; readonly id: string };

/**
 * The market derivation op that sets the curveSetup block (deriveMarketSnapshot).
 * One per derivation; it replaces any block the base carries. The setup is
 * stored as validateCurveSetup returns it: rows sorted by node tenor (a
 * futures row's node is its start plus 3 months; every other row's is its
 * tenorMonths).
 */
export interface CurveSetupSetOp {
  op: "set-curve-setup";
  setup: CurveSetupBlock;
}
