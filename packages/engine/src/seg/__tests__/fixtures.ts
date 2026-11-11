/**
 * Fixtures for the SEG block tests: a flat 3% par curve built from the
 * vendored snapshot, two simple loans ($100M, 60-month
 * bullet, fixed at 5.00% and the 1M benchmark + 200bp), their liability
 * mirrors, and a CD cohort book the kernel gives no replacement vintage.
 */
import {
  DeterministicRatePath,
  FIXED_LOAN_DEFAULTS,
  FLOATING_LOAN_DEFAULTS,
  bootstrapZeroCurve,
  type FixedLoanTerms,
  type FloatingLoanTerms,
  type MarketSnapshot,
  type RatePath,
} from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { DimensionBag } from "../../contracts/dimensions";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { CdTerms } from "../../cd/terms";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { computeSegBlock, SEG_DEFAULTS, type SegInput } from "../computeSeg";

export const M = 1_000_000;
export const N = 100 * M;

/** The vendored snapshot with every par quote set to 3.00%: a flat par curve. */
export function flatParSnapshot(market: MarketSnapshot, rate = 0.03): MarketSnapshot {
  return { ...market, curveQuotes: market.curveQuotes.map((q) => ({ ...q, rate })) };
}

/** The base deterministic path on that curve, 361 steps as the book builds it. */
export function flatBasePath(market: MarketSnapshot): RatePath {
  return new DeterministicRatePath(bootstrapZeroCurve(flatParSnapshot(market)), 361);
}

export function segCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "fixed", label: "Fixed", parentId: "assets", side: "asset", isLeaf: true, familyId: "FIXED", order: 0 },
      { id: "float", label: "Float", parentId: "assets", side: "asset", isLeaf: true, familyId: "FLOAT", order: 1 },
      { id: "liabilities", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "fixed-l", label: "Fixed funding", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "FIXED-L", order: 0 },
      { id: "float-l", label: "Floating funding", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "FLOAT-L", order: 1 },
      { id: "cd", label: "CDs", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "CD", order: 2 },
    ],
    families: [
      { id: "FIXED", label: "Fixed", side: "asset", instrumentType: "fixed-loan", coaNodeId: "fixed" },
      { id: "FLOAT", label: "Float", side: "asset", instrumentType: "floating-loan", coaNodeId: "float" },
      { id: "FIXED-L", label: "Fixed funding", side: "liability", instrumentType: "fixed-loan", coaNodeId: "fixed-l" },
      { id: "FLOAT-L", label: "Floating funding", side: "liability", instrumentType: "floating-loan", coaNodeId: "float-l" },
      { id: "CD", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: "cd" },
    ],
  };
}

/** Simple fixed loan: $100M, 60-month bullet at 5.00%. */
export function fixedLoan(id: string, o: Partial<FixedLoanTerms> = {}, dimensions?: DimensionBag): Position {
  const liability = o.side === "liability";
  const terms: FixedLoanTerms = {
    ...FIXED_LOAN_DEFAULTS,
    id,
    notional: N,
    maturityMonths: 60,
    amortType: "bullet",
    coupon: 0.05,
    ...o,
  };
  return {
    id,
    familyId: liability ? "FIXED-L" : "FIXED",
    coaNodeId: liability ? "fixed-l" : "fixed",
    terms,
    ...(dimensions !== undefined ? { dimensions } : {}),
  };
}

/** Simple floater: $100M, 60-month bullet at the 1M benchmark + 200bp, monthly reset. */
export function floatingLoan(id: string, o: Partial<FloatingLoanTerms> = {}, dimensions?: DimensionBag): Position {
  const liability = o.side === "liability";
  const terms: FloatingLoanTerms = {
    ...FLOATING_LOAN_DEFAULTS,
    id,
    notional: N,
    maturityMonths: 60,
    amortType: "bullet",
    indexTenorMonths: 1,
    resetFrequencyMonths: 1,
    margin: 0.02,
    ...o,
  };
  return {
    id,
    familyId: liability ? "FLOAT-L" : "FLOAT",
    coaNodeId: liability ? "float-l" : "float",
    terms,
    ...(dimensions !== undefined ? { dimensions } : {}),
  };
}

/** A one-cohort CD book: the kernel builds no replacement vintage for it. */
export function cdPosition(id: string): Position {
  const terms: CdTerms = {
    id,
    type: "cd",
    notional: 50 * M,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "liability",
    cohorts: [{ termMonths: 12, monthsToMaturity: 12, balance: 1, contractRate: 0.04 }],
  };
  return { id, familyId: "CD", coaNodeId: "cd", terms };
}

export function book(positions: Position[]): PortfolioSpec {
  return { id: "PF-SEG", label: "SEG test book", asOf: "2026-03-31", coa: segCoa(), positions };
}

/** Run the block on the flat path with the defaults, overriding any input field. */
export function runSeg(market: MarketSnapshot, positions: Position[], o: Partial<SegInput> = {}) {
  return computeSegBlock({
    book: book(positions),
    basePath: flatBasePath(market),
    scenarioId: "S0",
    ...SEG_DEFAULTS,
    makeInstrument: (p) => makeInstrument(p.terms),
    ...o,
  });
}
