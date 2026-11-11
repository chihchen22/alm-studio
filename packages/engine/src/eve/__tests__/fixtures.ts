/**
 * Fixtures for the EVE tests. A two-sided book (fixed loans + mortgages on the
 * asset side; a Non-IB NMD and an IB NMD-B on the liability side) over a COA that
 * carries the asset/liability sides EVE nets across. Terms come straight from the
 * kernel defaults so a cross-check against a kernel instrument is an exact
 * identity, not an approximation.
 */
import {
  FIXED_LOAN_DEFAULTS,
  MORTGAGE_DEFAULTS,
  NMD_B_TERMS_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  type FixedLoanTerms,
  type MortgageTerms,
  type NMDBetaTerms,
  type NMDTerms,
} from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { REGULATORY_SHOCKS_BP } from "../../contracts/scenario";

export const AS_OF = "2026-01-01";

export function makeCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "fixed-loans", label: "Fixed Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "FIXED", order: 0 },
      { id: "mortgages", label: "Mortgages", parentId: "assets", side: "asset", isLeaf: true, familyId: "MORTGAGE", order: 1 },
      { id: "liabilities", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "dda", label: "DDA", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "DDA", order: 0 },
      { id: "mma", label: "MMA", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "MMA", order: 1 },
    ],
    families: [
      { id: "FIXED", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "fixed-loans" },
      { id: "MORTGAGE", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "mortgages" },
      { id: "DDA", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "dda" },
      { id: "MMA", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "mma" },
    ],
  };
}

export function fixedTerms(id: string, o: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...o };
}
export function mortgageTerms(id: string, o: Partial<MortgageTerms> = {}): MortgageTerms {
  return { ...MORTGAGE_DEFAULTS, id, ...o };
}
export function nmdTerms(id: string, o: Partial<NMDTerms> = {}): NMDTerms {
  return { ...NMD_TERMS_DEFAULTS, id, ...o };
}
export function nmdBetaTerms(id: string, o: Partial<NMDBetaTerms> = {}): NMDBetaTerms {
  return { ...NMD_B_TERMS_DEFAULTS, id, ...o };
}

export function fixedPosition(id: string, o: Partial<FixedLoanTerms> = {}): Position {
  return { id, familyId: "FIXED", coaNodeId: "fixed-loans", terms: fixedTerms(id, o) };
}
export function mortgagePosition(id: string, o: Partial<MortgageTerms> = {}): Position {
  return { id, familyId: "MORTGAGE", coaNodeId: "mortgages", terms: mortgageTerms(id, o) };
}
export function nmdPosition(id: string, o: Partial<NMDTerms> = {}): Position {
  return { id, familyId: "DDA", coaNodeId: "dda", terms: nmdTerms(id, o) };
}
export function nmdBetaPosition(id: string, o: Partial<NMDBetaTerms> = {}): Position {
  return { id, familyId: "MMA", coaNodeId: "mma", terms: nmdBetaTerms(id, o) };
}

export function makePortfolio(positions: Position[], id = "PF1"): PortfolioSpec {
  return { id, label: "EVE test book", asOf: AS_OF, coa: makeCoa(), positions };
}

/** A static scenario: parallel shock, no overlays, no new business. */
export function staticScenario(id: string, shockBp: number): Scenario {
  return {
    id,
    label: id,
    rateSpec: shockBp === 0 ? { kind: "base" } : { kind: "parallel", shockBp },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "static", rules: [] },
  };
}

/** The regulatory grid as scenarios, id "S{shock}" (S0, S100, S-100, ...). */
export function regulatoryScenarios(): Scenario[] {
  return REGULATORY_SHOCKS_BP.map((bp) => staticScenario(`S${bp}`, bp));
}
