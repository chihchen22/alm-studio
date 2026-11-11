/**
 * Small deterministic fixtures for the portfolio aggregation tests. Builds a
 * minimal chart of accounts and portfolios from the kernel's own term defaults,
 * so a cross-check against the kernel instrument is an exact identity rather than
 * an approximation.
 */
import {
  FIXED_LOAN_DEFAULTS,
  MORTGAGE_DEFAULTS,
  type FixedLoanTerms,
  type MortgageTerms,
} from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";

export const AS_OF = "2026-01-01";

/**
 * COA: two roots (assets, liabilities), one intermediate summation node under
 * assets, and two leaves under it (fixed loans, mortgages). Enough structure to
 * exercise multi-level roll-up.
 */
export function makeCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "loans", label: "Loans", parentId: "assets", side: "asset", isLeaf: false, order: 0 },
      { id: "fixed-loans", label: "Fixed Loans", parentId: "loans", side: "asset", isLeaf: true, familyId: "FIXED", order: 0 },
      { id: "mortgages", label: "Mortgages", parentId: "loans", side: "asset", isLeaf: true, familyId: "MORTGAGE", order: 1 },
    ],
    families: [
      { id: "FIXED", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "fixed-loans" },
      { id: "MORTGAGE", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "mortgages" },
    ],
  };
}

export function fixedLoanTerms(id: string, overrides: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...overrides };
}

export function mortgageTerms(id: string, overrides: Partial<MortgageTerms> = {}): MortgageTerms {
  return { ...MORTGAGE_DEFAULTS, id, ...overrides };
}

export function fixedPosition(id: string, overrides: Partial<FixedLoanTerms> = {}): Position {
  return { id, familyId: "FIXED", coaNodeId: "fixed-loans", terms: fixedLoanTerms(id, overrides) };
}

export function mortgagePosition(id: string, overrides: Partial<MortgageTerms> = {}): Position {
  return { id, familyId: "MORTGAGE", coaNodeId: "mortgages", terms: mortgageTerms(id, overrides) };
}

export function makePortfolio(positions: Position[], id = "PF1"): PortfolioSpec {
  return { id, label: "Test book", asOf: AS_OF, coa: makeCoa(), positions };
}
