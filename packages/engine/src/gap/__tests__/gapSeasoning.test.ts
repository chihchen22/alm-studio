/**
 * Gap-ladder seasoning re-anchor (D3a), cross-checked against the
 * kernel instruments directly. Anchors:
 *
 *  - a seasoned bullet's band moves by exactly the offset (the hand case: a
 *    12M CD originated 6 months ago lands in 3-6M, where its fresh twin lands
 *    in 6-12M);
 *  - both ladders band the shifted buckets identically, so the repricing and
 *    liquidity band totals both equal the REMAINING in-horizon principal;
 *  - the ladders reproduce a hand-banded, hand-shifted kernel stream;
 *  - a seasoned floater or deposit refuses typed through the gap engine;
 *  - a seasoned fixed-loan coexists with the W1-H3 NMD-B beta split without
 *    disturbing its conservation.
 */
import { describe, expect, it } from "vitest";
import {
  BETA_S_CURVE_DEFAULTS,
  FIXED_LOAN_DEFAULTS,
  FLOATING_LOAN_DEFAULTS,
  FixedLoan,
  NMD_B_TERMS_DEFAULTS,
  betaAtRate,
  type FixedLoanTerms,
  type NMDBetaTerms,
} from "@alm/kernel";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import { SeasoningError } from "../../portfolio/seasoning";
import type { ScenarioRatePath } from "../../portfolio/aggregate";
import { bandForBucket, buildBands } from "../bands";
import { buildScenarioGap } from "../gapEngine";

const HORIZON = 360;
const RATE = 0.04;
const path = new ConstantRatePath(RATE, HORIZON);
const AS_OF = "2026-01-01";
const sp = (id: string): ScenarioRatePath => ({ scenarioId: id, path });

/** Fixed-loan asset family, CD (fixed-loan) liability family, plus an NMD-B. */
function coa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "a-fixed", label: "Fixed Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "A_FIXED", order: 0 },
      { id: "liabs", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "l-cd", label: "CDs", parentId: "liabs", side: "liability", isLeaf: true, familyId: "L_CD", order: 0 },
      { id: "l-mma", label: "MMA", parentId: "liabs", side: "liability", isLeaf: true, familyId: "L_MMA", order: 1 },
    ],
    families: [
      { id: "A_FIXED", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "a-fixed" },
      { id: "L_CD", label: "CDs", side: "liability", instrumentType: "fixed-loan", coaNodeId: "l-cd" },
      { id: "L_MMA", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "l-mma" },
    ],
  };
}

function fixedTerms(id: string, o: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...o };
}
function cdLiab(id: string, o: Partial<FixedLoanTerms> = {}): Position {
  return { id, familyId: "L_CD", coaNodeId: "l-cd", terms: fixedTerms(id, o) };
}
function fixedAsset(id: string, o: Partial<FixedLoanTerms> = {}): Position {
  return { id, familyId: "A_FIXED", coaNodeId: "a-fixed", terms: fixedTerms(id, o) };
}
function makePf(positions: Position[]): PortfolioSpec {
  return { id: "PF-GS", label: "seasoned gap book", asOf: AS_OF, coa: coa(), positions };
}

describe("gap ladders — seasoned fixed-loan re-anchor (D3a)", () => {
  it("hand case: a 12M bullet CD originated 6 months ago lands in 3-6M; its fresh comparator in 6-12M", () => {
    const notional = 250_000;
    const seasoned = buildScenarioGap(
      makePf([cdLiab("CD1", { notional, maturityMonths: 12, amortType: "bullet", originationOffsetMonths: -6 })]),
      sp("base"),
      HORIZON,
    );
    const fresh = buildScenarioGap(
      makePf([cdLiab("CD1", { notional, maturityMonths: 12, amortType: "bullet" })]),
      sp("base"),
      HORIZON,
    );
    const bands = buildBands(HORIZON);
    const labels = bands.map((b) => b.label);
    expect(labels[2]).toBe("3-6M");
    expect(labels[3]).toBe("6-12M");

    for (const ladder of [seasoned.repricing, seasoned.liquidity]) {
      const rows = ladder.byCoaNode.find((n) => n.coaNodeId === "l-cd")!.rows;
      // Maturity at instrument month 12 -> bucket 12 - 1 - 6 = 5 -> band 3-6M.
      expect(rows.map((r) => r.liabilities)).toEqual([0, 0, notional, 0, 0, 0, 0, 0, 0]);
    }
    for (const ladder of [fresh.repricing, fresh.liquidity]) {
      const rows = ladder.byCoaNode.find((n) => n.coaNodeId === "l-cd")!.rows;
      // Fresh twin: bucket 11 -> band 6-12M. The band moved by exactly the offset.
      expect(rows.map((r) => r.liabilities)).toEqual([0, 0, 0, notional, 0, 0, 0, 0, 0]);
    }
  });

  it("both band totals equal the remaining in-horizon principal of a seasoned level-pay", () => {
    const terms = fixedTerms("L1", {
      notional: 500_000,
      coupon: 0.06,
      maturityMonths: 60,
      amortType: "level-pay",
      originationOffsetMonths: -12,
    });
    const { repricing, liquidity } = buildScenarioGap(makePf([fixedAsset("L1", terms)]), sp("base"), HORIZON);
    // Remaining principal from the kernel: months 13..60 of the original stream.
    const cfs = new FixedLoan(terms).generateCashflows(path);
    let remaining = 0;
    for (const cf of cfs) if (cf.monthOffset > 12) remaining += cf.principalPaid;

    const reprSum = repricing.rows.reduce((s, r) => s + r.assets, 0);
    const liqSum = liquidity.rows.reduce((s, r) => s + r.assets, 0);
    expect(Math.abs(reprSum - remaining)).toBeLessThan(1e-9 * remaining);
    expect(Math.abs(liqSum - remaining)).toBeLessThan(1e-9 * remaining);
    // Remaining < notional: the elapsed year's amortization is genuinely gone.
    expect(remaining).toBeLessThan(terms.notional);
  });

  it("the ladder reproduces a hand-banded, hand-shifted kernel stream", () => {
    const terms = fixedTerms("L1", {
      notional: 750_000,
      coupon: 0.055,
      maturityMonths: 48,
      amortType: "level-pay",
      originationOffsetMonths: -9,
    });
    const { liquidity } = buildScenarioGap(makePf([fixedAsset("L1", terms)]), sp("base"), HORIZON);
    const rows = liquidity.byCoaNode.find((n) => n.coaNodeId === "a-fixed")!.rows;

    const bands = buildBands(HORIZON);
    const expected = new Array(bands.length).fill(0);
    for (const cf of new FixedLoan(terms).generateCashflows(path)) {
      const k = cf.monthOffset - 1 - 9;
      if (k < 0 || k >= HORIZON) continue;
      expected[bandForBucket(k, bands)] += cf.principalPaid;
    }
    for (let b = 0; b < rows.length; b++) {
      expect(rows[b].assets).toBeCloseTo(expected[b], 9);
    }
  });

  it("refuses a seasoned floater and a seasoned NMD-B through the gap engine, typed", () => {
    const floaterPf: PortfolioSpec = {
      id: "PF-F",
      label: "seasoned floater",
      asOf: AS_OF,
      coa: {
        schemaVersion: "1.0.0",
        nodes: [
          { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
          { id: "a-float", label: "Float", parentId: "assets", side: "asset", isLeaf: true, familyId: "A_FLOAT", order: 0 },
        ],
        families: [
          { id: "A_FLOAT", label: "Float", side: "asset", instrumentType: "floating-loan", coaNodeId: "a-float" },
        ],
      },
      positions: [
        {
          id: "FL1",
          familyId: "A_FLOAT",
          coaNodeId: "a-float",
          terms: { ...FLOATING_LOAN_DEFAULTS, id: "FL1", originationOffsetMonths: -2 },
        },
      ],
    };
    expect(() => buildScenarioGap(floaterPf, sp("base"), HORIZON)).toThrow(SeasoningError);

    const mmaTerms: NMDBetaTerms = { ...NMD_B_TERMS_DEFAULTS, id: "B1", originationOffsetMonths: -12 };
    const mmaPf = makePf([{ id: "B1", familyId: "L_MMA", coaNodeId: "l-mma", terms: mmaTerms }]);
    expect(() => buildScenarioGap(mmaPf, sp("base"), HORIZON)).toThrow(SeasoningError);
  });

  it("a seasoned CD coexists with the NMD-B beta split; both conserve their band totals", () => {
    const cdTerms = fixedTerms("CD1", {
      notional: 400_000,
      maturityMonths: 24,
      amortType: "bullet",
      originationOffsetMonths: -6,
    });
    const mmaTerms: NMDBetaTerms = { ...NMD_B_TERMS_DEFAULTS, id: "B1", notional: 2_000_000, maturityMonths: 120 };
    const pf = makePf([
      cdLiab("CD1", cdTerms),
      { id: "B1", familyId: "L_MMA", coaNodeId: "l-mma", terms: mmaTerms },
    ]);
    const { repricing, liquidity } = buildScenarioGap(pf, sp("base"), HORIZON);

    // The beta split is genuinely active at the test rate.
    const beta = betaAtRate(4.0, BETA_S_CURVE_DEFAULTS);
    expect(beta).toBeGreaterThan(0);
    expect(beta).toBeLessThan(1);

    // Whole-book liability conservation across the two ladders.
    const reprSum = repricing.rows.reduce((s, r) => s + r.liabilities, 0);
    const liqSum = liquidity.rows.reduce((s, r) => s + r.liabilities, 0);
    expect(Math.abs(reprSum - liqSum)).toBeLessThan(1e-9 * liqSum);

    // And the seasoned CD's own bands: full notional at bucket 17 (12-24M band).
    const cdRows = liquidity.byCoaNode.find((n) => n.coaNodeId === "l-cd")!.rows;
    expect(cdRows[4].liabilities).toBe(400_000); // 1-2Y band holds bucket 17
    expect(cdRows.reduce((s, r) => s + r.liabilities, 0)).toBe(400_000);
  });
});
