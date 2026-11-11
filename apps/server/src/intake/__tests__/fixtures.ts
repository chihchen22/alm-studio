/**
 * Shared intake test fixtures: a minimal five-family chart of accounts and
 * position builders on the kernel default parameter blocks. All numbers are
 * invented synthetic values.
 */
import type { ChartOfAccounts, DimensionTaxonomy, Position } from "@alm/engine";
import { BETA_S_CURVE_DEFAULTS, IB_BUCKETS, MBS_DEFAULTS, NMD_DEFAULTS } from "@alm/kernel";

export const TEST_COA: ChartOfAccounts = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "n-assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "n-loans", label: "Fixed Loans", parentId: "n-assets", side: "asset", isLeaf: true, familyId: "loans", order: 0 },
    { id: "n-float", label: "Floating Loans", parentId: "n-assets", side: "asset", isLeaf: true, familyId: "floaters", order: 1 },
    { id: "n-mtg", label: "Mortgages", parentId: "n-assets", side: "asset", isLeaf: true, familyId: "mortgages", order: 2 },
    { id: "n-liab", label: "Total Liabilities & Equity", parentId: null, side: "liability", isLeaf: false, order: 1 },
    { id: "n-dda", label: "DDA", parentId: "n-liab", side: "liability", isLeaf: true, familyId: "dda", order: 0 },
    { id: "n-mma", label: "MMA", parentId: "n-liab", side: "liability", isLeaf: true, familyId: "mma", order: 1 },
  ],
  families: [
    { id: "loans", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "n-loans" },
    { id: "floaters", label: "Floating Loans", side: "asset", instrumentType: "floating-loan", coaNodeId: "n-float" },
    { id: "mortgages", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "n-mtg" },
    { id: "dda", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "n-dda" },
    { id: "mma", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "n-mma" },
  ],
};

export function fixedLoanPosition(id: string, overrides: Record<string, unknown> = {}): Position {
  return {
    id,
    familyId: "loans",
    coaNodeId: "n-loans",
    terms: {
      id,
      type: "fixed-loan",
      notional: 1_000_000,
      maturityMonths: 60,
      originationOffsetMonths: 0,
      amortType: "level-pay",
      side: "asset",
      coupon: 0.05,
      ...overrides,
    } as Position["terms"],
  };
}

export function floatingLoanPosition(id: string, overrides: Record<string, unknown> = {}): Position {
  return {
    id,
    familyId: "floaters",
    coaNodeId: "n-float",
    terms: {
      id,
      type: "floating-loan",
      notional: 2_000_000,
      maturityMonths: 36,
      originationOffsetMonths: 0,
      amortType: "level-pay",
      side: "asset",
      indexTenorMonths: 1,
      margin: 0.02,
      resetFrequencyMonths: 3,
      ...overrides,
    } as Position["terms"],
  };
}

export function mortgagePosition(id: string, overrides: Record<string, unknown> = {}): Position {
  return {
    id,
    familyId: "mortgages",
    coaNodeId: "n-mtg",
    terms: {
      id,
      type: "mortgage",
      notional: 400_000,
      maturityMonths: 336,
      // Seasoning on a mortgage is carried by ageMonths at offset 0; the engine refuses a
      // nonzero offset on a mortgage (seasoningOffsetOf), and so does intake.
      originationOffsetMonths: 0,
      amortType: "level-pay",
      side: "asset",
      noteRate: 0.055,
      originalTermMonths: 360,
      originalBalance: 400_000,
      ageMonths: 24,
      cprParams: MBS_DEFAULTS,
      ...overrides,
    } as Position["terms"],
  };
}

export function nmdPosition(id: string, overrides: Record<string, unknown> = {}): Position {
  return {
    id,
    familyId: "dda",
    coaNodeId: "n-dda",
    terms: {
      id,
      type: "nmd",
      notional: 500_000,
      maturityMonths: 360,
      originationOffsetMonths: 0,
      amortType: "level-pay",
      side: "liability",
      depositRate: 0,
      beta: 0,
      nmdParams: NMD_DEFAULTS,
      ...overrides,
    } as Position["terms"],
  };
}

export function nmdBetaPosition(id: string, overrides: Record<string, unknown> = {}): Position {
  return {
    id,
    familyId: "mma",
    coaNodeId: "n-mma",
    terms: {
      id,
      type: "nmd-b",
      notional: 750_000,
      maturityMonths: 360,
      originationOffsetMonths: 0,
      amortType: "level-pay",
      side: "liability",
      sCurve: BETA_S_CURVE_DEFAULTS,
      nmdParams: { ...NMD_DEFAULTS, buckets: IB_BUCKETS },
      ...overrides,
    } as Position["terms"],
  };
}

export function validSpec(positions: Position[]): Record<string, unknown> {
  return {
    id: "test-book",
    label: "Intake test book",
    asOf: "2026-03-31",
    coa: TEST_COA,
    positions,
  };
}

/**
 * The intake tag taxonomy. One open single-valued dimension, one
 * enumerated single-valued dimension, and the multi-valued behavioralClasses
 * the engine reserves. Invented synthetic values.
 */
export const TEST_TAXONOMY: DimensionTaxonomy = {
  schemaVersion: "1.0.0",
  id: "test-taxonomy",
  label: "Intake test taxonomy",
  dimensions: [
    { id: "vintage", label: "Origination vintage" },
    { id: "segment", label: "Calibration segment", values: ["rate-shopper", "relationship"] },
    { id: "behavioralClasses", label: "Behavioral classes", multiValued: true },
  ],
};
