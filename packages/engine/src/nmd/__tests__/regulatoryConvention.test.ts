/**
 * The regulatory deposit convention as a pure
 * book transform. Every expected number below is restated by hand from the
 * convention's rules, never imported from the module under test.
 */
import { describe, expect, it } from "vitest";
import { betaAtRate, type FloatingLoanTerms, type NMDTerms } from "@alm/kernel";
import type { PortfolioSpec, Position } from "../../contracts/position";
import {
  REGULATORY_CONVENTION_DEFAULTS,
  applyRegulatoryConvention,
  ladderRungMonths,
} from "../regulatoryConvention";
import { CHECKING_IB_CURVE, HYS_A_CURVE, HYS_B_CURVE, R0, fourNmdBook } from "./fixtures";

const betaAtR0 = (p: Position): number =>
  p.terms.type === "nmd-b" ? betaAtRate(R0 * 100, p.terms.sCurve) : 0;

function transformed() {
  return applyRegulatoryConvention(fourNmdBook(), REGULATORY_CONVENTION_DEFAULTS, R0, betaAtR0);
}
function child(id: string): Position {
  const p = transformed().book.positions.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no child ${id}`);
  return p;
}

describe("ladderRungMonths", () => {
  it("slots ten rungs at the midpoints of [0, 2L] for a 5-year average life", () => {
    expect(ladderRungMonths(5, 10)).toEqual([6, 18, 30, 42, 54, 66, 78, 90, 102, 114]);
  });
  it("rounds half to even, as Python's round does", () => {
    // 24 x 1.0 x (k + 0.5) / 8 = 1.5, 4.5, 7.5, ...: Python int(round()) gives 2, 4, 8, 10, 14, 16, 20, 22.
    expect(ladderRungMonths(1, 8)).toEqual([2, 4, 8, 10, 14, 16, 20, 22]);
  });
  it("carries the spec defaults: cap 0.50, core cap 0.90, 5.0 years, 10 rungs", () => {
    expect(REGULATORY_CONVENTION_DEFAULTS).toEqual({
      passThroughCap: 0.5,
      coreShareCap: 0.9,
      prescribedAverageLifeYears: 5.0,
      rungs: 10,
    });
  });
});

describe("applyRegulatoryConvention on the four-position deposit book", () => {
  it("the beta curves read 0.95, 0.70 and 0.25 at r0 (precondition of every number below)", () => {
    expect(betaAtRate(R0 * 100, HYS_A_CURVE)).toBeCloseTo(0.95, 9);
    expect(betaAtRate(R0 * 100, HYS_B_CURVE)).toBeCloseTo(0.7, 9);
    expect(betaAtRate(R0 * 100, CHECKING_IB_CURVE)).toBeCloseTo(0.25, 9);
  });

  it("replaces each of the four books with ten rungs and one non-core slice: 44 children", () => {
    const { book, parentOf } = transformed();
    expect(book.positions).toHaveLength(44);
    expect(Object.keys(parentOf)).toHaveLength(44);
    expect(book.id).toBe("PF-NMD4");
    expect(book.positions.map((p) => p.id).slice(0, 11)).toEqual([
      "hys-a-core-1", "hys-a-core-2", "hys-a-core-3", "hys-a-core-4", "hys-a-core-5",
      "hys-a-core-6", "hys-a-core-7", "hys-a-core-8", "hys-a-core-9", "hys-a-core-10", "hys-a-noncore",
    ]);
    expect(parentOf["checking-nib-noncore"]).toBe("checking-nib");
  });

  it("hys-a: rungs of 5M at 3.5256284% at the ladder months; non-core floater 50M, maturity 1, margin d0 - r0", () => {
    const months: number[] = [];
    for (let k = 1; k <= 10; k++) {
      const t = child(`hys-a-core-${k}`).terms as NMDTerms;
      expect(t.type).toBe("nmd");
      expect(t.notional).toBeCloseTo(5_000_000, 3);
      expect(t.depositRate).toBeCloseTo(0.035256284, 9);
      expect(t.beta).toBe(0);
      expect(t.side).toBe("liability");
      expect(t.nmdParams.closureSteady).toBe(0);
      expect(t.nmdParams.closureInitial).toBe(0);
      expect(t.nmdParams.maxRateDecay).toBe(0);
      expect(t.nmdParams.maxRateGrowth).toBe(0);
      expect(t.nmdParams.regimeAlpha).toBe(0);
      months.push(t.maturityMonths);
    }
    expect(months).toEqual([6, 18, 30, 42, 54, 66, 78, 90, 102, 114]);
    const nc = child("hys-a-noncore").terms as FloatingLoanTerms;
    expect(nc.type).toBe("floating-loan");
    expect(nc.side).toBe("liability");
    expect(nc.notional).toBeCloseTo(50_000_000, 3);
    expect(nc.maturityMonths).toBe(1);
    expect(nc.amortType).toBe("bullet");
    expect(nc.indexTenorMonths).toBe(1);
    expect(nc.resetFrequencyMonths).toBe(1);
    expect(Math.abs(nc.margin - -0.0018555939)).toBeLessThan(1e-9);
  });

  it("hys-b: core 12.5M (1.25M per rung) and non-core 12.5M at margin -0.0111335633", () => {
    expect((child("hys-b-core-1").terms as NMDTerms).notional).toBeCloseTo(1_250_000, 3);
    const nc = child("hys-b-noncore").terms as FloatingLoanTerms;
    expect(nc.notional).toBeCloseTo(12_500_000, 3);
    expect(Math.abs(nc.margin - -0.0111335633)).toBeLessThan(1e-9);
  });

  it("checking-ib: core 7.5M (0.75M per rung), non-core 2.5M at margin -0.0278339082", () => {
    let core = 0;
    for (let k = 1; k <= 10; k++) {
      const t = child(`checking-ib-core-${k}`).terms as NMDTerms;
      expect(t.notional).toBeCloseTo(750_000, 3);
      expect(t.depositRate).toBeCloseTo(0.009277969385, 9);
      core += t.notional;
    }
    expect(core).toBeCloseTo(7_500_000, 3);
    const nc = child("checking-ib-noncore").terms as FloatingLoanTerms;
    expect(nc.notional).toBeCloseTo(2_500_000, 3);
    expect(Math.abs(nc.margin - -0.0278339082)).toBeLessThan(1e-9);
  });

  it("checking-nib: rungs of 4.5M at rate 0; non-core nmd 5M, maturity 1, rate 0, frozen", () => {
    for (let k = 1; k <= 10; k++) {
      const t = child(`checking-nib-core-${k}`).terms as NMDTerms;
      expect(t.type).toBe("nmd");
      expect(t.notional).toBeCloseTo(4_500_000, 3);
      expect(t.depositRate).toBe(0);
    }
    const nc = child("checking-nib-noncore").terms as NMDTerms;
    expect(nc.type).toBe("nmd");
    expect(nc.notional).toBeCloseTo(5_000_000, 3);
    expect(nc.maturityMonths).toBe(1);
    expect(nc.depositRate).toBe(0);
    expect(nc.nmdParams.closureSteady).toBe(0);
  });

  it("conserves each parent's notional across its children", () => {
    const { book, parentOf } = transformed();
    const sums = new Map<string, number>();
    for (const p of book.positions) {
      const parent = parentOf[p.id]!;
      sums.set(parent, (sums.get(parent) ?? 0) + p.terms.notional);
    }
    expect(sums.get("hys-a")).toBeCloseTo(100_000_000, 2);
    expect(sums.get("hys-b")).toBeCloseTo(25_000_000, 2);
    expect(sums.get("checking-ib")).toBeCloseTo(10_000_000, 2);
    expect(sums.get("checking-nib")).toBeCloseTo(50_000_000, 2);
  });

  it("every child carries the parent's family, node, dimensions, parentPositionId and discountSpreadBp 0", () => {
    const { book, parentOf } = transformed();
    const parents = new Map(fourNmdBook().positions.map((p) => [p.id, p]));
    for (const p of book.positions) {
      const parent = parents.get(parentOf[p.id]!)!;
      expect(p.parentPositionId).toBe(parent.id);
      expect(p.familyId).toBe(parent.familyId);
      expect(p.coaNodeId).toBe(parent.coaNodeId);
      expect(p.dimensions).toEqual(parent.dimensions);
      expect(p.dimensions).not.toBe(parent.dimensions);
      expect(p.discountSpreadBp).toBe(0);
      expect(p.terms.id).toBe(p.id);
    }
  });

  it("marks every core rung and the non-interest-bearing non-core slice excluded; the three IB floaters are not", () => {
    const { book } = transformed();
    const excluded = book.positions.filter((p) => p.repricingTreatment === "excluded").map((p) => p.id);
    const notExcluded = book.positions.filter((p) => p.repricingTreatment === undefined).map((p) => p.id);
    expect(excluded).toHaveLength(41);
    expect(excluded).toContain("checking-nib-noncore");
    expect(excluded.filter((id) => id.includes("-core-"))).toHaveLength(40);
    expect(notExcluded).toEqual(["hys-a-noncore", "hys-b-noncore", "checking-ib-noncore"]);
    // Absent, never undefined-valued: the key is left out of the record.
    const floater = book.positions.find((p) => p.id === "hys-a-noncore")!;
    expect(Object.prototype.hasOwnProperty.call(floater, "repricingTreatment")).toBe(false);
  });

  it("leaves non-deposit positions, the input book and already-split children untouched", () => {
    const base = fourNmdBook();
    const loan: Position = {
      id: "loan-1",
      familyId: "HYS-A",
      coaNodeId: "hys-a",
      terms: { id: "loan-1", type: "fixed-loan", notional: 1_000_000, maturityMonths: 12, originationOffsetMonths: 0, amortType: "bullet", coupon: 0.05 },
    };
    const book: PortfolioSpec = { ...base, positions: [loan, ...base.positions] };
    const before = JSON.stringify(book);
    const once = applyRegulatoryConvention(book, REGULATORY_CONVENTION_DEFAULTS, R0, betaAtR0);
    expect(JSON.stringify(book)).toBe(before);
    expect(once.book.positions[0]).toBe(loan);
    expect(once.parentOf["loan-1"]).toBeUndefined();
    const twice = applyRegulatoryConvention(once.book, REGULATORY_CONVENTION_DEFAULTS, R0, betaAtR0);
    expect(JSON.stringify(twice.book)).toBe(JSON.stringify(once.book));
    expect(Object.keys(twice.parentOf)).toHaveLength(0);
  });

  it("refuses a parameter set that cannot form a ladder, naming the field", () => {
    expect(() =>
      applyRegulatoryConvention(fourNmdBook(), { ...REGULATORY_CONVENTION_DEFAULTS, rungs: 0 }, R0, betaAtR0),
    ).toThrow(/rungs/);
    expect(() =>
      applyRegulatoryConvention(fourNmdBook(), { ...REGULATORY_CONVENTION_DEFAULTS, coreShareCap: 1.5 }, R0, betaAtR0),
    ).toThrow(/coreShareCap/);
    expect(() =>
      applyRegulatoryConvention(fourNmdBook(), REGULATORY_CONVENTION_DEFAULTS, Number.NaN, betaAtR0),
    ).toThrow(/r0/);
  });
});
