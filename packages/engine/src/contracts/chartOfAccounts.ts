/**
 * Chart of accounts and product-family model.
 *
 * The COA is the spine conventional ALM systems get right: an account is a node
 * in a summation tree that also classifies the instruments beneath it. This
 * version keeps the summation tree and the side/family classification and drops
 * the other jobs those systems overload onto one account (posting router,
 * calc-order group, GL pointers). Roll-up is by summing a node's children; positions
 * attach only to leaf nodes.
 */
import type { BehavioralClassId } from "./plan";
import type { EngineInstrumentType } from "./position";
import type { BalanceSheetSide, CoaNodeId, ProductFamilyId } from "./ids";

/** A node in the chart-of-accounts summation tree. */
export interface CoaNode {
  id: CoaNodeId;
  label: string;
  /** null only for the roots (Total Assets, Total Liabilities & Equity). */
  parentId: CoaNodeId | null;
  side: BalanceSheetSide;
  /** true if positions attach here; false for summation-only nodes. */
  isLeaf: boolean;
  /** Present on leaf nodes: the product family whose positions live here. */
  familyId?: ProductFamilyId;
  /** Display order among siblings; stable, ascending. */
  order: number;
}

/**
 * A product family: the ALCO-facing classification (DDA, MMA, Savings, Fixed
 * Loans, Floating Loans, Mortgages, MBS, Investments, CDs, FHLB Advances,
 * Borrowings). A family declares which kernel instrument type its positions
 * instantiate. Several families may share one instrument type: a CD and an
 * FHLB advance are both bullet fixed-rate liabilities, differing in their COA
 * placement and their behavioral overlay, not in their cash-flow engine.
 */
export interface ProductFamilyDef {
  id: ProductFamilyId;
  label: string;
  side: BalanceSheetSide;
  /**
   * Instrument the family's positions instantiate: a frozen kernel type or the
   * engine-side "cd" cohort-book arm (W3-A2b widening, ADR-015/ADR-020; the
   * kernel `InstrumentType` union itself is untouched).
   */
  instrumentType: EngineInstrumentType;
  /** COA leaf this family rolls into. */
  coaNodeId: CoaNodeId;
  /**
   * Behavioral classes this family carries, declared rather than derived
   * (round-2 ruling 1). The routing gate reads the union of these and the
   * classes derived from the run's overlay bindings, so a class with a model
   * but no overlay kind is visible to R3 and R4. `draw-utilization` and
   * `client-rate-asset` used to belong on that list and no longer do: the
   * `commitment-draw` overlay derives the first and the
   * `loan-client-rate` overlay the second
   * (../plan/behavioralClasses.ts). Optional: a book that declares nothing
   * behaves as it did before.
   */
  behavioralClasses?: BehavioralClassId[];
}

/**
 * The full chart of accounts: the node tree plus the family catalogue.
 * Serializable and hashable; it is part of the run's input snapshot.
 */
export interface ChartOfAccounts {
  schemaVersion: string;
  nodes: CoaNode[];
  families: ProductFamilyDef[];
}
