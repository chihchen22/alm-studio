/**
 * NII engine acceptance tests.
 *
 * The correctness signal is the kernel and the aggregator: a family's interest
 * series is the m03 aggregate of kernel cashflows, and this module only side-signs
 * and horizon-sums it. Nothing here retypes a constant the engine also computes.
 *
 * Coverage against the acceptance criteria:
 *  - analytic anchor: a single fixed-rate asset's 12m interest equals coupon
 *    times average balance (exact for a bullet: coupon * notional);
 *  - family nets sum to the scenario total;
 *  - a liability family reduces net NII (correct sign);
 *  - a +200 parallel moves NII up for an asset-sensitive book (floating asset,
 *    rate-locked liability);
 *  - the result is deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  FIXED_LOAN_DEFAULTS,
  FLOATING_LOAN_DEFAULTS,
  type FixedLoanTerms,
  type FloatingLoanTerms,
} from "@alm/kernel";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { aggregateScenario } from "../../portfolio/aggregate";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { BucketGrid, ScenarioCashflows } from "../../contracts/results";
import { computeNII, NII_HORIZONS_MONTHS } from "../computeNII";

const AS_OF = "2026-01-01";
const HORIZON = 60;
const GRID: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };

/**
 * A COA with an asset fixed-loan leaf, an asset floating-loan leaf, and a
 * liability fixed-loan leaf. Enough to exercise both sides of the sign
 * convention and an asset-sensitive book.
 */
function makeCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "asset-fixed", label: "Fixed Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "ASSET", order: 0 },
      { id: "asset-float", label: "Floating Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "FLOAT", order: 1 },
      { id: "liabs", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "liab-fixed", label: "Borrowings", parentId: "liabs", side: "liability", isLeaf: true, familyId: "LIAB", order: 0 },
    ],
    families: [
      { id: "ASSET", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "asset-fixed" },
      { id: "FLOAT", label: "Floating Loans", side: "asset", instrumentType: "floating-loan", coaNodeId: "asset-float" },
      { id: "LIAB", label: "Borrowings", side: "liability", instrumentType: "fixed-loan", coaNodeId: "liab-fixed" },
    ],
  };
}

function fixedTerms(id: string, overrides: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...overrides };
}

function floatTerms(id: string, overrides: Partial<FloatingLoanTerms> = {}): FloatingLoanTerms {
  return { ...FLOATING_LOAN_DEFAULTS, id, ...overrides };
}

function makePortfolio(positions: Position[]): PortfolioSpec {
  return { id: "PF", label: "NII test book", asOf: AS_OF, coa: makeCoa(), positions };
}

/** Aggregate one portfolio under a flat rate into a single ScenarioCashflows. */
function aggregate(portfolio: PortfolioSpec, scenarioId: string, rate: number): ScenarioCashflows {
  const path = new ConstantRatePath(rate, HORIZON);
  return aggregateScenario(portfolio, { scenarioId, path }, GRID);
}

describe("analytic anchor: 12m interest = coupon * average balance", () => {
  it("equals coupon * notional for a single fixed-rate bullet asset", () => {
    const coupon = 0.05;
    const notional = 1_000_000;
    const portfolio = makePortfolio([
      { id: "A1", familyId: "ASSET", coaNodeId: "asset-fixed", terms: fixedTerms("A1", { amortType: "bullet", coupon, notional, maturityMonths: 60 }) },
    ]);
    const scn = aggregate(portfolio, "BASE", 0.03);
    const nii = computeNII([scn], makeCoa());

    const fam = nii.byScenario[0].byFamily.find((f) => f.familyId === "ASSET")!;
    // Bullet: 12 months of notional * coupon / 12 = coupon * notional exactly.
    expect(fam.interestIncome12).toBeCloseTo(coupon * notional, 4);
    expect(fam.interestExpense12).toBe(0);
    expect(fam.net12).toBeCloseTo(coupon * notional, 4);
    // 24 months of the same accrual.
    expect(fam.interestIncome24).toBeCloseTo(coupon * notional * 2, 4);
    expect(fam.net24).toBeCloseTo(coupon * notional * 2, 4);
  });

  it("equals coupon * mean(balance over the window) for a level-pay asset", () => {
    const coupon = 0.05;
    const portfolio = makePortfolio([
      { id: "A1", familyId: "ASSET", coaNodeId: "asset-fixed", terms: fixedTerms("A1", { amortType: "level-pay", coupon, maturityMonths: 60 }) },
    ]);
    const scn = aggregate(portfolio, "BASE", 0.03);
    const nii = computeNII([scn], makeCoa());

    const series = scn.byFamily.find((f) => f.familyId === "ASSET")!.series;
    const avgBal12 = series.balance.slice(0, 12).reduce((s, b) => s + b, 0) / 12;
    const fam = nii.byScenario[0].byFamily.find((f) => f.familyId === "ASSET")!;
    // interest[k] = balance[k] * coupon / 12 for a fixed loan, so the 12m sum is
    // coupon * mean(balance[0..11]) to floating-point tolerance.
    expect(fam.interestIncome12).toBeCloseTo(coupon * avgBal12, 4);
  });
});

describe("family nets sum to the scenario total", () => {
  it("totalNet12 and totalNet24 equal the sum of family nets", () => {
    const portfolio = makePortfolio([
      { id: "A1", familyId: "ASSET", coaNodeId: "asset-fixed", terms: fixedTerms("A1", { amortType: "bullet", coupon: 0.05, notional: 1_000_000, maturityMonths: 60 }) },
      { id: "L1", familyId: "LIAB", coaNodeId: "liab-fixed", terms: fixedTerms("L1", { amortType: "bullet", coupon: 0.02, notional: 700_000, maturityMonths: 60, side: "liability" }) },
    ]);
    const scn = aggregate(portfolio, "BASE", 0.03);
    const nii = computeNII([scn], makeCoa());
    const s = nii.byScenario[0];

    const sum12 = s.byFamily.reduce((acc, f) => acc + f.net12, 0);
    const sum24 = s.byFamily.reduce((acc, f) => acc + f.net24, 0);
    expect(s.totalNet12).toBeCloseTo(sum12, 8);
    expect(s.totalNet24).toBeCloseTo(sum24, 8);
  });
});

describe("liability families reduce net NII (correct sign)", () => {
  it("books liability interest as expense and lowers the total below asset-only", () => {
    const asset: Position = { id: "A1", familyId: "ASSET", coaNodeId: "asset-fixed", terms: fixedTerms("A1", { amortType: "bullet", coupon: 0.05, notional: 1_000_000, maturityMonths: 60 }) };
    const liab: Position = { id: "L1", familyId: "LIAB", coaNodeId: "liab-fixed", terms: fixedTerms("L1", { amortType: "bullet", coupon: 0.02, notional: 700_000, maturityMonths: 60, side: "liability" }) };

    const assetOnly = computeNII([aggregate(makePortfolio([asset]), "BASE", 0.03)], makeCoa());
    const withLiab = computeNII([aggregate(makePortfolio([asset, liab]), "BASE", 0.03)], makeCoa());

    const liabFam = withLiab.byScenario[0].byFamily.find((f) => f.familyId === "LIAB")!;
    // Liability interest is expense, not income; its net contribution is negative.
    expect(liabFam.interestIncome12).toBe(0);
    expect(liabFam.interestExpense12).toBeCloseTo(0.02 * 700_000, 4);
    expect(liabFam.net12).toBeCloseTo(-0.02 * 700_000, 4);

    // The book total falls by exactly the liability expense.
    expect(withLiab.byScenario[0].totalNet12).toBeCloseTo(
      assetOnly.byScenario[0].totalNet12 - 0.02 * 700_000,
      4,
    );
    expect(withLiab.byScenario[0].totalNet12).toBeLessThan(assetOnly.byScenario[0].totalNet12);
  });
});

describe("+200 parallel moves NII up for an asset-sensitive book", () => {
  it("net NII rises when a floating asset reprices up against a rate-locked liability", () => {
    // Floating asset reprices with the path; fixed liability is rate-locked. A
    // +200 bp move (0.03 -> 0.05) lifts asset income, leaves expense unchanged,
    // so net NII rises. Bullet balances so the effect is pure repricing.
    const portfolio = makePortfolio([
      { id: "A1", familyId: "FLOAT", coaNodeId: "asset-float", terms: floatTerms("A1", { amortType: "bullet", margin: 0.01, notional: 1_000_000, maturityMonths: 60, resetFrequencyMonths: 1 }) },
      { id: "L1", familyId: "LIAB", coaNodeId: "liab-fixed", terms: fixedTerms("L1", { amortType: "bullet", coupon: 0.02, notional: 1_000_000, maturityMonths: 60, side: "liability" }) },
    ]);

    const base = computeNII([aggregate(portfolio, "BASE", 0.03)], makeCoa());
    const up200 = computeNII([aggregate(portfolio, "UP200", 0.05)], makeCoa());

    const baseNet = base.byScenario[0].totalNet12;
    const upNet = up200.byScenario[0].totalNet12;
    expect(upNet).toBeGreaterThan(baseNet);

    // The lift is exactly the asset repricing: +200 bp on the 1M-reset floater's
    // notional over 12 months = 0.02 * 1,000,000 = 20,000. Expense is unchanged.
    expect(upNet - baseNet).toBeCloseTo(0.02 * 1_000_000, 3);
  });
});

describe("shape and determinism", () => {
  it("reports the [12, 24] horizons and is byte-identical across two runs", () => {
    const portfolio = makePortfolio([
      { id: "A1", familyId: "ASSET", coaNodeId: "asset-fixed", terms: fixedTerms("A1", { amortType: "bullet", coupon: 0.05, notional: 1_000_000, maturityMonths: 60 }) },
      { id: "L1", familyId: "LIAB", coaNodeId: "liab-fixed", terms: fixedTerms("L1", { amortType: "bullet", coupon: 0.02, notional: 700_000, maturityMonths: 60, side: "liability" }) },
    ]);
    const scn = aggregate(portfolio, "BASE", 0.03);
    const a = computeNII([scn], makeCoa());
    const b = computeNII([scn], makeCoa());
    expect(a).toEqual(b);
    expect(a.horizonsMonths).toEqual([...NII_HORIZONS_MONTHS]);
    // One byFamily row per family present in the aggregate, in declared order.
    expect(a.byScenario[0].byFamily.map((f) => f.familyId)).toEqual(["ASSET", "FLOAT", "LIAB"]);
  });

  it("throws on a family absent from the chart of accounts", () => {
    const orphan: ScenarioCashflows = {
      scenarioId: "BAD",
      byFamily: [{ familyId: "GHOST", series: { balance: [0], principal: [0], interest: [1] } }],
      byCoaNode: [],
    };
    expect(() => computeNII([orphan], makeCoa())).toThrow(/GHOST/);
  });
});

describe("piece 2b: the optional cell arm", () => {
  // Built inline: the file's `asset` is a const LOCAL to an unrelated it() body
  // (computeNII.test.ts line 132), not a file-level helper. `fixedTerms`,
  // `makePortfolio`, `aggregate` and `makeCoa` ARE file-level. The family is
  // "ASSET": this file's makeCoa declares ASSET, FLOAT and LIAB, and no FIXED.
  const assetPosition = (): Position => ({
    id: "A1",
    familyId: "ASSET",
    coaNodeId: "asset-fixed",
    terms: fixedTerms("A1", { amortType: "bullet", coupon: 0.05, notional: 1_000_000, maturityMonths: 60 }),
  });
  it("emits no byCell when the caller supplies no cell dictionary", () => {
    const scn = aggregate(makePortfolio([assetPosition()]), "BASE", 0.03);
    expect(computeNII([scn], makeCoa()).byScenario[0]!.byCell).toBeUndefined();
  });
  it("emits no byCell when the cashflow rows carry none, even with a dictionary", () => {
    const scn = aggregate(makePortfolio([assetPosition()]), "BASE", 0.03);
    const cells = [{ id: "ASSET|", familyId: "ASSET", tags: {}, positionCount: 1 }];
    expect(computeNII([scn], makeCoa(), [12, 24], cells).byScenario[0]!.byCell).toBeUndefined();
  });
  /**
   * The cell-side twin of "throws on a family absent from the chart of
   * accounts". Unreachable through buildCellPlan, which only emits a cell for a
   * family the book declares, so this is built by hand: the family arm is
   * sound and only the dictionary names a family the COA does not hold. The
   * family-side throw is pinned, so this one is too.
   */
  it("throws on a cell whose family is absent from the chart of accounts", () => {
    const orphanCell: ScenarioCashflows = {
      scenarioId: "BAD",
      byFamily: [{ familyId: "ASSET", series: { balance: [0], principal: [0], interest: [1] } }],
      byCoaNode: [],
      byCell: [{ cellId: "GHOST|", series: { balance: [0], principal: [0], interest: [1] } }],
    };
    const cells = [{ id: "GHOST|", familyId: "GHOST", tags: {}, positionCount: 1 }];
    // The message is the cell one, not the family one: the family arm here is
    // ASSET and passes, so a test that only matched /GHOST/ could be satisfied
    // by the family-side throw firing on the wrong input.
    expect(() => computeNII([orphanCell], makeCoa(), [12, 24], cells)).toThrow(
      'cell "GHOST|" names no family in the chart of accounts',
    );
  });
});
