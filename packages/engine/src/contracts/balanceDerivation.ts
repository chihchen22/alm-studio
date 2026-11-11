/**
 * Balance-shock derivation contract.
 *
 * Types only (type imports), so Studio and the reader client can name them by
 * path without pulling the derivation, and its node:crypto hash, into a
 * bundle. The function that produces them is deriveBalancePlan, in
 * plan/deriveBalancePlan.ts. Balances are in book currency units; no op
 * converts a unit.
 */
import type { DerivationOpKind, DerivationProblem } from "./derivation";

/**
 * Names one target of the base plan by family and, optionally, one knot of its
 * path by month. Without a month an op applies to every knot of the path.
 */
export interface BalanceKnotAddress {
  familyId: string;
  month?: number;
}

/** add: old + value; scale: old * value; set: value (month required). */
export interface BalanceShockOp {
  target: BalanceKnotAddress;
  op: DerivationOpKind;
  value: number;
}

/** The record a derived balance plan carries: its immediate base and the ops applied, normalized. */
export interface BalancePlanDerivedFrom {
  baseId: string;
  /** The engine canonical contentHash of the base plan, the basis of provenance.balancePlanHash. */
  baseContentHash: string;
  ops: BalanceShockOp[];
}

/** One (target, knot) touched, with the balance before and after, computed in the engine. */
export interface BalanceKnotChange {
  targetIndex: number;
  familyId: string;
  month: number;
  from: number;
  to: number;
  /** Indices into the op list, in order, of the ops that touched this knot. */
  ops: number[];
}

/** One refusal, reused from the behavioral derivation: where it sits and why. */
export type BalanceDerivationProblem = DerivationProblem;
