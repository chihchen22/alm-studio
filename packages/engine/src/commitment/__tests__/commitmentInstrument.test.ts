import { describe, expect, it } from "vitest";
import { CommitmentInstrument } from "../commitmentInstrument";
import { EMPTY_DRAW_PATH, type CommitmentDrawPath, type CommitmentTerms } from "../terms";

function terms(draw: CommitmentDrawPath, over: Partial<CommitmentTerms> = {}): CommitmentTerms {
  return {
    id: "commit-1",
    type: "commitment",
    notional: 1_000_000,
    maturityMonths: 36,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    draw,
    ...over,
  };
}

describe("CommitmentInstrument", () => {
  it("an unbound commitment emits no cashflows at all", () => {
    const rows = new CommitmentInstrument(terms(EMPTY_DRAW_PATH)).generateCashflows();
    expect(rows).toEqual([]);
  });

  it("a zero steady rate with an empty ramp emits no cashflows", () => {
    const rows = new CommitmentInstrument(
      terms({ rampRates: [], steadyRate: 0 }),
    ).generateCashflows();
    expect(rows).toEqual([]);
  });

  it("month 1 draws exactly notional times rampRates[0]", () => {
    const rows = new CommitmentInstrument(
      terms({ rampRates: [0.35], steadyRate: 0 }),
    ).generateCashflows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.monthOffset).toBe(1);
    expect(rows[0]!.balance).toBeCloseTo(1_000_000, 9);
    expect(rows[0]!.principalPaid).toBeCloseTo(-350_000, 9);
  });

  it("a draw is NEGATIVE principalPaid, the kernel drawdown convention", () => {
    const rows = new CommitmentInstrument(
      terms({ rampRates: [0.1], steadyRate: 0 }),
    ).generateCashflows();
    expect(rows[0]!.principalPaid).toBeLessThan(0);
  });

  it("the rate applies to what is STILL undrawn, not to the original limit", () => {
    const rows = new CommitmentInstrument(
      terms({ rampRates: [0.35, 0.15, 0.1], steadyRate: 0 }),
    ).generateCashflows();
    // U0 = 1e6; d1 = 350000, U1 = 650000; d2 = 97500, U2 = 552500; d3 = 55250.
    expect(rows[0]!.principalPaid).toBeCloseTo(-350_000, 6);
    expect(rows[1]!.balance).toBeCloseTo(650_000, 6);
    expect(rows[1]!.principalPaid).toBeCloseTo(-97_500, 6);
    expect(rows[2]!.balance).toBeCloseTo(552_500, 6);
    expect(rows[2]!.principalPaid).toBeCloseTo(-55_250, 6);
  });

  it("cumulative draws can never exceed the line", () => {
    // Four months at 90 percent of remaining: 1 - 0.1^4 = 0.9999 of the line.
    // Four months, not sixty: at sixty the remainder underflows to the float
    // edge and a strict "< notional" assertion stops proving anything.
    const rows = new CommitmentInstrument(
      terms({ rampRates: [0.9, 0.9, 0.9], steadyRate: 0.9 }, { maturityMonths: 4 }),
    ).generateCashflows();
    const drawn = rows.reduce((a, r) => a - r.principalPaid, 0);
    expect(drawn).toBeCloseTo(999_900, 6);
    expect(drawn).toBeLessThan(1_000_000);
  });

  it("the steady rate holds after the ramp ends", () => {
    const rows = new CommitmentInstrument(
      terms({ rampRates: [0.5], steadyRate: 0.5 }),
    ).generateCashflows();
    expect(rows[1]!.balance).toBeCloseTo(500_000, 6);
    expect(rows[1]!.principalPaid).toBeCloseTo(-250_000, 6);
    expect(rows[2]!.principalPaid).toBeCloseTo(-125_000, 6);
  });

  it("emits no rows past expiry; the remaining line lapses without a cashflow", () => {
    const rows = new CommitmentInstrument(
      terms({ rampRates: [], steadyRate: 0.1 }, { maturityMonths: 4 }),
    ).generateCashflows();
    expect(rows.map((r) => r.monthOffset)).toEqual([1, 2, 3, 4]);
    // The undrawn remainder at expiry is not paid out.
    const drawn = rows.reduce((a, r) => a - r.principalPaid, 0);
    expect(drawn).toBeLessThan(1_000_000);
  });

  it("books no asset: interest and coupon are zero on every row", () => {
    const rows = new CommitmentInstrument(
      terms({ rampRates: [0.2, 0.2], steadyRate: 0.1 }),
    ).generateCashflows();
    expect(rows.every((r) => r.interestPaid === 0)).toBe(true);
    expect(rows.every((r) => r.couponRate === 0)).toBe(true);
  });

  it("has no repricing schedule", () => {
    expect(new CommitmentInstrument(terms(EMPTY_DRAW_PATH)).repricingSchedule()).toEqual([]);
  });

  it("ignores the rate path argument entirely (no rate response in v1)", () => {
    const inst = new CommitmentInstrument(terms({ rampRates: [0.3], steadyRate: 0 }));
    const a = inst.generateCashflows();
    const b = inst.generateCashflows({ monthlyRates: [0.99, 0.99, 0.99] });
    expect(b).toEqual(a);
  });

  it("refuses invalid terms at construction", () => {
    expect(
      () => new CommitmentInstrument(terms(EMPTY_DRAW_PATH, { notional: -1 })),
    ).toThrow(/notional/);
  });

  it("the seeded illustrative path reproduces the spec's cumulative usage", () => {
    const rows = new CommitmentInstrument(
      terms({ rampRates: [0.35, 0.15, 0.1], steadyRate: 0.02 }, { maturityMonths: 120 }),
    ).generateCashflows();
    const cumAt = (m: number) =>
      rows.filter((r) => r.monthOffset <= m).reduce((a, r) => a - r.principalPaid, 0) / 1_000_000;
    expect(cumAt(1)).toBeCloseTo(0.350000000, 8);
    expect(cumAt(3)).toBeCloseTo(0.502750000, 8);
    expect(cumAt(6)).toBeCloseTo(0.531992278, 8);
    expect(cumAt(12)).toBeCloseTo(0.585418925, 8);
  });
});
