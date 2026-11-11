/**
 * Family WAL (weighted average life) fold — W3-A7.
 *
 * Anchors:
 *  - The hand-computable two-payment bond from the plan acceptance row:
 *    50% of principal at month 12, 50% at month 24 gives WAL
 *    0.5·1y + 0.5·2y = 1.5y, every operand exact in binary, asserted toBe.
 *  - Kernel identity: for a fully-amortizing single position, the family WAL
 *    equals kernel `walFromCashflows` over the instrument's own stream — the
 *    arithmetic authority the fold wraps.
 *  - A single bullet degenerates to maturity/12 exactly.
 *  - Empty / zero principal reports NO WAL (undefined, not a fabricated 0).
 *  - stampFamilyWal reads the series AS IT IS at stamp time (the dynamic
 *    new-business merge mutates series in place; the run pipeline stamps after).
 */
import { describe, expect, it } from "vitest";
import { FIXED_LOAN_DEFAULTS, walFromCashflows, type FixedLoanTerms } from "@alm/kernel";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { makeInstrument } from "../../runtime/instrumentFactory";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { BucketGrid, ScenarioCashflows } from "../../contracts/results";
import { aggregateScenario, familyWalYears, stampFamilyWal } from "../aggregate";

const AS_OF = "2026-01-01";
const HORIZON = 120;
const GRID: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };

function makeCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "asset-fixed", label: "Fixed Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "FIXED", order: 0 },
    ],
    families: [
      { id: "FIXED", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "asset-fixed" },
    ],
  };
}

function fixedTerms(id: string, overrides: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...overrides };
}

function fixedPosition(id: string, overrides: Partial<FixedLoanTerms> = {}): Position {
  return { id, familyId: "FIXED", coaNodeId: "asset-fixed", terms: fixedTerms(id, overrides) };
}

function makeBook(positions: Position[]): PortfolioSpec {
  return { id: "PF-WAL", label: "WAL test book", asOf: AS_OF, coa: makeCoa(), positions };
}

describe("familyWalYears — hand anchors", () => {
  it("two-payment bond: 50 at month 12 + 50 at month 24 = 1.5 years EXACTLY", () => {
    const principal = new Float64Array(36);
    principal[11] = 50; // bucket 11 = calendar month 12
    principal[23] = 50; // bucket 23 = calendar month 24
    expect(familyWalYears(principal)).toBe(1.5);
  });

  it("a single payment at month 24 = 2 years exactly (bullet degeneracy)", () => {
    const principal = new Float64Array(36);
    principal[23] = 1_000_000;
    expect(familyWalYears(principal)).toBe(2);
  });

  it("uneven weights: 25 at month 6 + 75 at month 18 = 0.25·0.5 + 0.75·1.5 = 1.25y", () => {
    const principal = new Float64Array(24);
    principal[5] = 25;
    principal[17] = 75;
    expect(familyWalYears(principal)).toBe(0.25 * 0.5 + 0.75 * 1.5);
  });

  it("reports NO WAL for empty or zero principal (undefined, never a fabricated 0)", () => {
    expect(familyWalYears(new Float64Array(12))).toBeUndefined();
    expect(familyWalYears([])).toBeUndefined();
  });
});

describe("familyWalYears — kernel identity", () => {
  it("equals kernel walFromCashflows over the instrument stream for a fully-amortizing level-pay", () => {
    const terms = fixedTerms("A1", { amortType: "level-pay", coupon: 0.05, notional: 1_000_000, maturityMonths: 60 });
    const path = new ConstantRatePath(0.03, HORIZON);
    const inst = makeInstrument(terms);
    const cfs = inst.generateCashflows(path);
    const kernelWal = walFromCashflows(cfs, terms.notional);

    const scn = aggregateScenario(makeBook([fixedPosition("A1", { amortType: "level-pay", coupon: 0.05, notional: 1_000_000, maturityMonths: 60 })]), { scenarioId: "S", path }, GRID);
    const familyWal = familyWalYears(scn.byFamily[0].series.principal);
    expect(familyWal).toBeDefined();
    // The fold divides by the in-horizon principal sum; the kernel divides by
    // the stated notional. For a fully-amortizing loan the two denominators
    // agree to accumulation rounding, so the identity holds to 1e-12 relative.
    expect(Math.abs(familyWal! - kernelWal) / kernelWal).toBeLessThan(1e-12);
  });

  it("a 24M bullet family reports exactly 2.0 years through the aggregator", () => {
    const path = new ConstantRatePath(0.03, HORIZON);
    const scn = aggregateScenario(
      makeBook([fixedPosition("B1", { amortType: "bullet", coupon: 0.04, notional: 500_000, maturityMonths: 24 })]),
      { scenarioId: "S", path },
      GRID,
    );
    expect(familyWalYears(scn.byFamily[0].series.principal)).toBe(2);
  });

  it("a seasoned 24M bullet at offset -6 reports the REMAINING life, 1.5 years", () => {
    const path = new ConstantRatePath(0.03, HORIZON);
    const scn = aggregateScenario(
      makeBook([fixedPosition("S1", { amortType: "bullet", coupon: 0.04, notional: 500_000, maturityMonths: 24, originationOffsetMonths: -6 })]),
      { scenarioId: "S", path },
      GRID,
    );
    expect(familyWalYears(scn.byFamily[0].series.principal)).toBe(1.5);
  });
});

describe("stampFamilyWal", () => {
  it("stamps from the series as it is at stamp time and skips zero-principal families", () => {
    const scn: ScenarioCashflows = {
      scenarioId: "S",
      byFamily: [
        { familyId: "FIXED", series: { balance: [100, 100], principal: [0, 100], interest: [1, 1] } },
        { familyId: "EMPTY", series: { balance: [0, 0], principal: [0, 0], interest: [0, 0] } },
      ],
      byCoaNode: [],
    };
    stampFamilyWal(scn);
    // Single payment in bucket 1 = calendar month 2 = 2/12 years.
    expect(scn.byFamily[0].walYears).toBe(2 / 12);
    expect(scn.byFamily[1].walYears).toBeUndefined();

    // Mutate the series (the dynamic merge does exactly this) and re-stamp:
    // the WAL follows the CURRENT series, proving stamp-after-merge ordering
    // is what makes the envelope honest.
    scn.byFamily[0].series.principal[0] = 100;
    stampFamilyWal(scn);
    expect(scn.byFamily[0].walYears).toBe((100 / 200) * (1 / 12) + (100 / 200) * (2 / 12));
  });
});
