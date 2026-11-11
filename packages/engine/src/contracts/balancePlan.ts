/**
 * Balance plan: the input that OWNS the going-concern balance (harness Section
 * 6). Data, hashable. The
 * compiler lowers it onto the existing NewBusinessRule machinery; a path the
 * rule shape cannot carry is refused, never approximated.
 */
import type { BalancePlanDerivedFrom } from "./balanceDerivation";
import type { CoaNodeId, ProductFamilyId } from "./ids";

/**
 * A target over a chart-of-accounts node rather than one family. Same path and
 * pricing shape as BalanceTarget; lowerBalancePlan allocates it to the node's
 * leaf families.
 */
export interface BalanceNodeTarget {
  coaNodeId: CoaNodeId;
  /** Target node balance at knots, ascending months in 1..horizon, book currency units. */
  path: Array<{ month: number; balance: number }>;
  newBusinessPricing: { spreadOverIndexBp: number; termMonths: number };
}

export interface BalanceTarget {
  familyId: ProductFamilyId;
  /** Target family balance at knots, ascending months in 1..horizon, book currency units. */
  path: Array<{ month: number; balance: number }>;
  newBusinessPricing: { spreadOverIndexBp: number; termMonths: number };
}

export interface BalancePlan {
  schemaVersion: "1.0.0";
  id: string;
  label: string;
  asOf: string;
  targets: BalanceTarget[];
  /** Families not listed run off. Stated, not implied. */
  unlistedFamilies: "runoff";
  /**
   * Studio A+E contract 20: a target over a chart-of-accounts node, allocated at
   * lowering to the node's leaf families pro rata on opening balance (the static
   * mix within the node). Absent on every existing plan, so no plan hash moves.
   */
  nodeTargets?: BalanceNodeTarget[];
  /**
   * The record of the plan it was derived from and the ops applied (ALM Studio
   * Piece 6b). Written only by deriveBalancePlan; absent on every hand-saved
   * plan, so no existing plan's hash moves. lowerBalancePlan ignores it.
   */
  derivedFrom?: BalancePlanDerivedFrom;
}
