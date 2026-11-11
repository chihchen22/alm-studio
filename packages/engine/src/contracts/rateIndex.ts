/**
 * Rate index contract.
 *
 * Types only (type imports), so Studio and the reader client can name them by
 * path without pulling the validator or the rate path into a bundle. Rates and
 * spreads are decimals (0.03 is 300 bp); only the derive ops take basis points,
 * named for it (basisBp and the other *Bp fields, and value on add-index-basis).
 *
 * Three kinds of index. A compounded window, the only kind
 * before B3a, is a static basis over the run's one curve: a tenor in
 * months that sets the compounding window of the reset rate, and a basis added
 * to it; its record carries no `kind`. A constant-maturity swap reads the path's
 * forward par swap rate at a tenor in years. A formula is a level or a change
 * on a parent index of the same market. The block is written by
 * deriveMarketSnapshot through rateIndex/record.ts, the one builder of a stored
 * index record.
 *
 * The block lives on the market as an additive, engine-only `rateIndices`
 * list. The kernel MarketSnapshot type is not edited.
 */
import type { MarketSnapshot } from "@alm/kernel";

/** The three kinds of index. A record without `kind` is a compounded window. */
export type RateIndexKind = "compounded-window" | "constant-maturity-swap" | "formula";

/** The tenors a compounded-window index may carry, in months, matching the curve's short quotes. */
export type RateIndexTenor = 1 | 3 | 6 | 12;

/** The swap tenors a constant-maturity-swap index may carry, in whole years (decision 36). */
export type SwapTenorYears = 1 | 2 | 3 | 5 | 7 | 10 | 20 | 30;

/** A compounded window: reset over tenorMonths of the run's curve, plus a constant basis. The only kind before B3a. */
export interface CompoundedWindowIndex {
  id: string;
  label: string;
  /** Never written on a stored record (hash neutral); accepted on input and dropped by the derive. */
  kind?: "compounded-window";
  tenorMonths: RateIndexTenor;
  /** A decimal added to the reset rate (0.03 is 300 bp). */
  basis: number;
  /** A derived curve id; its spread at tenorMonths is added. Left out when unset. */
  spreadCurve?: string;
  /** An index history id (ih- and 16 hex); left out when unset. Read only by a formula child's lag before the cut-off and by the start fill; display only otherwise. */
  historyId?: string;
}

/** A constant-maturity swap: the path's forward par swap rate at tenorYears on the curve's quoted basis, plus the basis (decision 36). */
export interface ConstantMaturitySwapIndex {
  id: string;
  label: string;
  kind: "constant-maturity-swap";
  tenorYears: SwapTenorYears;
  basis: number;
  /** A derived curve id; its spread at 12 x tenorYears months is added. Left out when unset. */
  spreadCurve?: string;
  /** An index history id (ih- and 16 hex); left out when unset. Read only by a formula child's lag before the cut-off and by the start fill; display only otherwise. */
  historyId?: string;
}

/**
 * A formula on a parent index of the same market (decisions 37 to 40). Exactly one of coefficient (level: index =
 * coefficient x parent + basis) or beta (change: the index moves by beta x each month's change in the parent,
 * from start). Rates are decimals. Lag applies before the formula, floor and cap after it. A formula names no
 * derived curve; its parent may, and the formula reads the parent's full rate.
 */
export interface FormulaIndex {
  id: string;
  label: string;
  kind: "formula";
  parent: string;
  coefficient?: number;
  beta?: number;
  /** The index's fixing at the cut-off, a decimal; a beta index only (decision 39). */
  start?: number;
  /** Whole months, 1 to 12; left out for no lag. */
  lagMonths?: number;
  floor?: number;
  cap?: number;
  /** The formula's spread (decision 37): "Shift a basis" moves it. */
  basis: number;
  /** An index history id (ih- and 16 hex); left out when unset. Read only by a formula child's lag before the cut-off and by the start fill; display only otherwise. */
  historyId?: string;
  spreadCurve?: never;
}

/** One named index of any kind. */
export type RateIndex = CompoundedWindowIndex | ConstantMaturitySwapIndex | FormulaIndex;

/**
 * A formula in a run's resolved table: the stored record plus its parent's value at step 0 on the run's unshocked
 * base curve, fixed once at the run entry (rateIndex/resolve.ts). The months before the cut-off read it (spec v5
 * decision 45, ruling 2026-10-13, which amends decision 40). Run time only: never stored, never validated,
 * dropped by indexRecord.
 */
export type AnchoredFormulaIndex = FormulaIndex & {
  readonly parentAtCutoff: number;
  /** Step B3b: the parent's values at months -1 to -lagMonths (index 0 is month -1): its history where it has a value, parentAtCutoff where not. Present only when the parent carries a history and the formula has a lag. */
  readonly parentBeforeCutoff?: readonly number[];
};

/** A market snapshot, optionally carrying the additive rateIndices block. */
export type MarketWithIndices = MarketSnapshot & { rateIndices?: RateIndex[] };

/** The indices a run resolves, keyed by id. */
export type RateIndexTable = ReadonlyMap<string, RateIndex>;

/** Add a compounded window, or replace the index with the same id. The basis is in basis points. */
export interface CompoundedWindowSetOp {
  op: "set-index";
  id: string;
  label: string;
  kind?: "compounded-window";
  tenorMonths: RateIndexTenor;
  /** Basis points; stored as a decimal. */
  basisBp: number;
  /** A derived curve id; left out when not sent. */
  spreadCurve?: string;
  /** An index history id; left out when not sent, and then a set-index keeps the id the index already carries. */
  historyId?: string;
}

/** Add a constant-maturity-swap index, or replace the index with the same id. */
export interface ConstantMaturitySwapSetOp {
  op: "set-index";
  id: string;
  label: string;
  kind: "constant-maturity-swap";
  tenorYears: SwapTenorYears;
  basisBp: number;
  spreadCurve?: string;
  /** An index history id; left out when not sent, and then a set-index keeps the id the index already carries. */
  historyId?: string;
}

/** Add a formula index, or replace the index with the same id. Levels are basis points, stored as decimals. */
export interface FormulaSetOp {
  op: "set-index";
  id: string;
  label: string;
  kind: "formula";
  parent: string;
  coefficient?: number;
  beta?: number;
  startBp?: number;
  lagMonths?: number;
  floorBp?: number;
  capBp?: number;
  basisBp: number;
  /** An index history id; left out when not sent, and then a set-index keeps the id the index already carries. */
  historyId?: string;
}

export type RateIndexSetOp = CompoundedWindowSetOp | ConstantMaturitySwapSetOp | FormulaSetOp;

/** Move the basis of an index the market carries at that point in the op order. */
export interface RateIndexBasisOp {
  op: "add-index-basis";
  indexId: string;
  /** Basis points added to the stored basis. */
  value: number;
}

/** Point an index the market carries at that point in the op order at a stored index history, or clear it with null. */
export interface RateIndexHistoryOp {
  op: "set-index-history";
  indexId: string;
  historyId: string | null;
}

/** One index touched by a derivation, computed in the engine. */
export interface RateIndexChange {
  id: string;
  /** The entry the base carried, or null when the index is new. */
  from: RateIndex | null;
  to: RateIndex;
  /**
   * The basis moved, in basis points, computed in the engine: (to - from) for an
   * index the base carries; for a new index, the shift applied after the op that
   * created it, or null when none was applied.
   */
  basisChangeBp: number | null;
  /** Indices into the op list, in order, of the ops that touched this index. */
  ops: number[];
}
