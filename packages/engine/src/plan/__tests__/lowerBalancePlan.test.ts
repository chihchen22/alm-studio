import { describe, expect, it } from "vitest";
import type { BalancePlan } from "../../contracts/balancePlan";
import { BalancePlanUnsupported, lowerBalancePlan } from "../lowerBalancePlan";

/** The plan and the book share an as-of; must-fix 3 refuses any pair that does not. */
const AS_OF = "2026-01-01";
const opening = new Map([["FIXED", 5_000_000], ["DDA", 3_000_000]]);
const plan = (targets: BalancePlan["targets"]): BalancePlan => ({ schemaVersion: "1.0.0", id: "bp-1", label: "t", asOf: AS_OF, targets, unlistedFamilies: "runoff" });
const pricing = { spreadOverIndexBp: 150, termMonths: 60 };

describe("lowerBalancePlan", () => {
  it("a flat path lowers to reinvest flat", () => {
    const rules = lowerBalancePlan(plan([{ familyId: "FIXED", path: [{ month: 1, balance: 5_000_000 }, { month: 360, balance: 5_000_000 }], newBusinessPricing: pricing }]), opening, 360, AS_OF);
    expect(rules).toEqual([{ familyId: "FIXED", reinvest: "flat", spreadOverIndexBp: 150, termMonths: 60 }]);
  });
  it("a geometric path lowers to reinvest growth with the monthly rate", () => {
    const g = 0.002;
    const rules = lowerBalancePlan(plan([{ familyId: "FIXED", path: [{ month: 12, balance: 5_000_000 * (1 + g) ** 12 }, { month: 360, balance: 5_000_000 * (1 + g) ** 360 }], newBusinessPricing: pricing }]), opening, 360, AS_OF);
    expect(rules[0]!.reinvest).toBe("growth");
    expect(rules[0]!.monthlyGrowthRate).toBeCloseTo(g, 12);
  });
  it("a non-geometric path is refused, naming the family and the first bad knot", () => {
    const bad = plan([{ familyId: "FIXED", path: [{ month: 12, balance: 6_000_000 }, { month: 24, balance: 6_000_000 }], newBusinessPricing: pricing }]);
    expect(() => lowerBalancePlan(bad, opening, 360, AS_OF)).toThrow(BalancePlanUnsupported);
    // Anchored on the last knot (month 24), the month-12 knot is the first in
    // path order to miss the implied path, so it is the one named.
    try { lowerBalancePlan(bad, opening, 360, AS_OF); } catch (e) { expect((e as BalancePlanUnsupported).familyId).toBe("FIXED"); expect((e as BalancePlanUnsupported).month).toBe(12); }
  });
  it("a family with no opening balance is refused", () => {
    expect(() => lowerBalancePlan(plan([{ familyId: "HELOC", path: [{ month: 360, balance: 1 }], newBusinessPricing: pricing }]), opening, 360, AS_OF)).toThrow('family "HELOC" has no opening balance in the book');
  });
  it("a knot past the horizon is refused", () => {
    expect(() => lowerBalancePlan(plan([{ familyId: "FIXED", path: [{ month: 361, balance: 5_000_000 }], newBusinessPricing: pricing }]), opening, 360, AS_OF)).toThrow("month 361 exceeds horizon 360");
  });
  it("two targets naming the same family are refused, with no month", () => {
    const dup = plan([
      { familyId: "FIXED", path: [{ month: 360, balance: 5_000_000 }], newBusinessPricing: pricing },
      { familyId: "FIXED", path: [{ month: 360, balance: 5_000_000 }], newBusinessPricing: pricing },
    ]);
    expect(() => lowerBalancePlan(dup, opening, 360, AS_OF)).toThrow("family appears in more than one target");
    try { lowerBalancePlan(dup, opening, 360, AS_OF); } catch (e) { expect((e as BalancePlanUnsupported).familyId).toBe("FIXED"); expect((e as BalancePlanUnsupported).month).toBeNull(); }
  });
  it("a geometric path stated in whole dollars still lowers to growth", () => {
    const g = 0.002;
    const knot = (m: number) => ({ month: m, balance: Math.round(5_000_000 * (1 + g) ** m) });
    const rules = lowerBalancePlan(plan([{ familyId: "FIXED", path: [knot(12), knot(360)], newBusinessPricing: pricing }]), opening, 360, AS_OF);
    expect(rules[0]!.reinvest).toBe("growth");
    expect(rules[0]!.monthlyGrowthRate).toBeCloseTo(g, 6);
  });
  it("an empty path is refused, with no month", () => {
    const empty = plan([{ familyId: "FIXED", path: [], newBusinessPricing: pricing }]);
    expect(() => lowerBalancePlan(empty, opening, 360, AS_OF)).toThrow("path is empty");
    try { lowerBalancePlan(empty, opening, 360, AS_OF); } catch (e) { expect((e as BalancePlanUnsupported).month).toBeNull(); }
  });
  it("non-ascending months are refused, naming the offending month", () => {
    const backwards = plan([{ familyId: "FIXED", path: [{ month: 12, balance: 5_000_000 }, { month: 6, balance: 5_000_000 }], newBusinessPricing: pricing }]);
    expect(() => lowerBalancePlan(backwards, opening, 360, AS_OF)).toThrow("months must be ascending integers starting at 1");
    try { lowerBalancePlan(backwards, opening, 360, AS_OF); } catch (e) { expect((e as BalancePlanUnsupported).month).toBe(6); }
  });
  it("a negative balance is refused, naming the month", () => {
    const negative = plan([{ familyId: "FIXED", path: [{ month: 12, balance: -1 }], newBusinessPricing: pricing }]);
    expect(() => lowerBalancePlan(negative, opening, 360, AS_OF)).toThrow("balance must be a finite non-negative number");
    try { lowerBalancePlan(negative, opening, 360, AS_OF); } catch (e) { expect((e as BalancePlanUnsupported).month).toBe(12); }
  });
  it("a knot exactly at the horizon is accepted", () => {
    const rules = lowerBalancePlan(plan([{ familyId: "FIXED", path: [{ month: 360, balance: 5_000_000 }], newBusinessPricing: pricing }]), opening, 360, AS_OF);
    expect(rules).toEqual([{ familyId: "FIXED", reinvest: "flat", spreadOverIndexBp: 150, termMonths: 60 }]);
  });
  it("a declining geometric path lowers to growth at a negative rate", () => {
    const g = -0.001;
    const rules = lowerBalancePlan(plan([{ familyId: "FIXED", path: [{ month: 12, balance: 5_000_000 * (1 + g) ** 12 }, { month: 360, balance: 5_000_000 * (1 + g) ** 360 }], newBusinessPricing: pricing }]), opening, 360, AS_OF);
    expect(rules[0]!.reinvest).toBe("growth");
    expect(rules[0]!.monthlyGrowthRate).toBeCloseTo(g, 12);
    expect(rules[0]!.monthlyGrowthRate!).toBeLessThan(0);
  });
  it("a dollar-rounded geometric path with an early knot still lowers to growth", () => {
    const g = 0.002;
    const knot = (m: number) => ({ month: m, balance: Math.round(5_000_000 * (1 + g) ** m) });
    const rules = lowerBalancePlan(plan([{ familyId: "FIXED", path: [knot(1), knot(12), knot(360)], newBusinessPricing: pricing }]), opening, 360, AS_OF);
    expect(rules[0]!.reinvest).toBe("growth");
    expect(rules[0]!.monthlyGrowthRate).toBeCloseTo(g, 6);
  });
});
