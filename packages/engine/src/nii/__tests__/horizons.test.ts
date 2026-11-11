/**
 * Flexible NII horizons and the monthly net vector.
 *
 * Anchors, per the plan acceptance row:
 *  - net12 === byHorizon[12].net and net24 === byHorizon[24].net EXACTLY
 *    (toBe, not toBeCloseTo): the byHorizon entries copy the pinned pairs'
 *    already-summed values, so equality is identity, not tolerance.
 *  - The monthly net vector sums to the horizon nets EXACTLY on both sides:
 *    netMonthly[k] = ±interest[k], and IEEE-754 negation composed with
 *    sign-symmetric rounding makes the ordered partial sums of the negated
 *    series equal the negated ordered sums.
 *  - A custom horizon list produces one entry per horizon, each equal to an
 *    independently summed window of the aggregated interest series.
 *  - Malformed horizon lists refuse typed (the module's refusal case).
 *  - ADR-015: the pre-existing pinned fields are computed by the identical
 *    accumulation as before — asserted here against an independent re-sum.
 */
import { describe, expect, it } from "vitest";
import { FIXED_LOAN_DEFAULTS, type FixedLoanTerms } from "@alm/kernel";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { aggregateScenario } from "../../portfolio/aggregate";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { BucketGrid, ScenarioCashflows } from "../../contracts/results";
import { computeNII, NII_HORIZONS_MONTHS } from "../computeNII";

const AS_OF = "2026-01-01";
const HORIZON = 60;
const GRID: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };

function makeCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "asset-fixed", label: "Fixed Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "ASSET", order: 0 },
      { id: "liabs", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "liab-fixed", label: "Borrowings", parentId: "liabs", side: "liability", isLeaf: true, familyId: "LIAB", order: 0 },
    ],
    families: [
      { id: "ASSET", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "asset-fixed" },
      { id: "LIAB", label: "Borrowings", side: "liability", instrumentType: "fixed-loan", coaNodeId: "liab-fixed" },
    ],
  };
}

function fixedTerms(id: string, overrides: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...overrides };
}

function makeBook(): PortfolioSpec {
  const positions: Position[] = [
    // Level-pay so the interest series varies month to month (a bullet's flat
    // series would let an off-by-one window slip through the sum assertions).
    { id: "A1", familyId: "ASSET", coaNodeId: "asset-fixed", terms: fixedTerms("A1", { amortType: "level-pay", coupon: 0.05, notional: 1_000_000, maturityMonths: 48 }) },
    { id: "L1", familyId: "LIAB", coaNodeId: "liab-fixed", terms: fixedTerms("L1", { amortType: "level-pay", coupon: 0.02, notional: 700_000, maturityMonths: 36, side: "liability" }) },
  ];
  return { id: "PF-H", label: "Horizons test book", asOf: AS_OF, coa: makeCoa(), positions };
}

function aggregate(): ScenarioCashflows {
  const path = new ConstantRatePath(0.03, HORIZON);
  return aggregateScenario(makeBook(), { scenarioId: "BASE", path }, GRID);
}

describe("byHorizon identity with the pinned pairs", () => {
  it("net12 === byHorizon[12].net and net24 === byHorizon[24].net EXACTLY, per family and in total", () => {
    const nii = computeNII([aggregate()], makeCoa());
    const s = nii.byScenario[0];
    for (const fam of s.byFamily) {
      expect(fam.byHorizon).toBeDefined();
      const h12 = fam.byHorizon![12];
      const h24 = fam.byHorizon![24];
      expect(h12.net).toBe(fam.net12);
      expect(h12.interestIncome).toBe(fam.interestIncome12);
      expect(h12.interestExpense).toBe(fam.interestExpense12);
      expect(h24.net).toBe(fam.net24);
      expect(h24.interestIncome).toBe(fam.interestIncome24);
      expect(h24.interestExpense).toBe(fam.interestExpense24);
    }
    expect(s.totalNetByHorizon![12]).toBe(s.totalNet12);
    expect(s.totalNetByHorizon![24]).toBe(s.totalNet24);
  });

  it("the pinned pairs match an independent re-sum of the aggregated interest series", () => {
    const scn = aggregate();
    const nii = computeNII([scn], makeCoa());
    const asset = nii.byScenario[0].byFamily.find((f) => f.familyId === "ASSET")!;
    const liab = nii.byScenario[0].byFamily.find((f) => f.familyId === "LIAB")!;
    const interestA = scn.byFamily.find((f) => f.familyId === "ASSET")!.series.interest;
    const interestL = scn.byFamily.find((f) => f.familyId === "LIAB")!.series.interest;
    let sumA = 0;
    for (let k = 0; k < 12; k++) sumA += interestA[k];
    let sumL = 0;
    for (let k = 0; k < 12; k++) sumL += interestL[k];
    expect(asset.net12).toBe(sumA);
    expect(liab.net12).toBe(-sumL);
  });
});

describe("the monthly net vector", () => {
  it("ordered partial sums reproduce every horizon net EXACTLY, asset and liability side", () => {
    const nii = computeNII([aggregate()], makeCoa(), [6, 12, 24, 36, 60]);
    for (const fam of nii.byScenario[0].byFamily) {
      expect(fam.netMonthly).toBeDefined();
      for (const h of [6, 12, 24, 36, 60]) {
        let partial = 0;
        const n = Math.min(h, fam.netMonthly!.length);
        for (let k = 0; k < n; k++) partial += fam.netMonthly![k];
        expect(partial).toBe(fam.byHorizon![h].net);
      }
    }
  });

  it("the scenario vector is the family vectors summed in declared order, and sums to the scenario totals", () => {
    const nii = computeNII([aggregate()], makeCoa());
    const s = nii.byScenario[0];
    expect(s.netMonthly).toBeDefined();
    const n = s.netMonthly!.length;
    for (let k = 0; k < n; k++) {
      let expected = 0;
      for (const fam of s.byFamily) expected += fam.netMonthly![k] ?? 0;
      expect(s.netMonthly![k]).toBe(expected);
    }
    let partial12 = 0;
    for (let k = 0; k < 12; k++) partial12 += s.netMonthly![k];
    // Scenario-level partial sums accumulate bucket-across-family, the totals
    // family-across-bucket; equality is to float tolerance, not identity.
    expect(partial12).toBeCloseTo(s.totalNet12, 8);
  });
});

describe("custom horizon lists", () => {
  it("emits one byHorizon entry per requested horizon, each an independent window sum", () => {
    const scn = aggregate();
    const horizons = [6, 18, 48];
    const nii = computeNII([scn], makeCoa(), horizons);
    expect(nii.horizonsMonths).toEqual(horizons);
    const asset = nii.byScenario[0].byFamily.find((f) => f.familyId === "ASSET")!;
    const interest = scn.byFamily.find((f) => f.familyId === "ASSET")!.series.interest;
    for (const h of horizons) {
      let sum = 0;
      for (let k = 0; k < Math.min(h, interest.length); k++) sum += interest[k];
      expect(asset.byHorizon![h].net).toBe(sum);
    }
    // The pinned pairs survive a list that names neither 12 nor 24.
    let sum12 = 0;
    for (let k = 0; k < 12; k++) sum12 += interest[k];
    expect(asset.net12).toBe(sum12);
  });

  it("a horizon beyond the grid clamps to the series length (the disclosed defensive path)", () => {
    const scn = aggregate();
    const nii = computeNII([scn], makeCoa(), [12, 500]);
    const asset = nii.byScenario[0].byFamily.find((f) => f.familyId === "ASSET")!;
    const interest = scn.byFamily.find((f) => f.familyId === "ASSET")!.series.interest;
    let all = 0;
    for (let k = 0; k < interest.length; k++) all += interest[k];
    expect(asset.byHorizon![500].net).toBe(all);
  });

  it("refuses malformed lists typed (the module's refusal case)", () => {
    const scn = aggregate();
    expect(() => computeNII([scn], makeCoa(), [])).toThrow(/at least one horizon/);
    expect(() => computeNII([scn], makeCoa(), [12.5])).toThrow(/positive integer/);
    expect(() => computeNII([scn], makeCoa(), [0])).toThrow(/positive integer/);
    expect(() => computeNII([scn], makeCoa(), [-12])).toThrow(/positive integer/);
    expect(() => computeNII([scn], makeCoa(), [24, 12])).toThrow(/strictly ascending/);
    expect(() => computeNII([scn], makeCoa(), [12, 12])).toThrow(/strictly ascending/);
    expect(() => computeNII([scn], makeCoa(), [Number.NaN])).toThrow(/positive integer/);
  });
});

describe("serialization determinism of the horizon map", () => {
  it("two computations serialize byte-identically (integer keys enumerate ascending)", () => {
    const scn = aggregate();
    const a = computeNII([scn], makeCoa(), [6, 12, 24, 36]);
    const b = computeNII([scn], makeCoa(), [6, 12, 24, 36]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.horizonsMonths).not.toBe(NII_HORIZONS_MONTHS); // fresh array, no aliasing
  });
});
