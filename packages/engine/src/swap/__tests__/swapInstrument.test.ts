import { describe, expect, it } from "vitest";
import type { RatePath } from "@alm/kernel";
import { SwapInstrument, type SwapCashflow } from "../swapInstrument";
import { SwapTermsError, type SwapTerms } from "../terms";

const FLAT = 0.04;
/** A flat 1M path: every fixing is 4 percent, so every floating coupon is known by hand. */
const flatPath: RatePath = { nSteps: 360, times: [], rateAt: () => FLAT, forwardRateAt: () => FLAT };

const N = 1_000_000;
const C = 0.05;

function terms(over: Partial<SwapTerms> = {}): SwapTerms {
  return {
    id: "sw",
    type: "swap",
    notional: N,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    direction: "pay-fixed",
    fixedRate: C,
    ...over,
  };
}

const rowsOf = (t: SwapTerms): SwapCashflow[] => new SwapInstrument(t).generateCashflows(flatPath);

describe("SwapInstrument", () => {
  it("emits the fixed leg then the floating leg, one row per month each", () => {
    const rows = rowsOf(terms());
    expect(rows).toHaveLength(24);
    expect(rows.slice(0, 12).map((r) => r.monthOffset)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(rows.slice(12).map((r) => r.monthOffset)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("pay-fixed: the fixed leg is PAY and signed negative, the kernel's own coupon arithmetic", () => {
    const fixed = rowsOf(terms()).slice(0, 12);
    for (const r of fixed) {
      expect(r.leg).toBe("pay");
      expect(r.interestPaid).toBe(-(N * (C / 12)));
      expect(r.balance).toBe(-N);
      expect(r.couponRate).toBe(C);
    }
    expect(fixed[11]!.principalPaid).toBe(-N);
  });

  it("pay-fixed: the floating leg is RECEIVE, signed positive, coupon = fixing + margin", () => {
    const float = rowsOf(terms({ floatMargin: 0.01 })).slice(12);
    for (const r of float) {
      expect(r.leg).toBe("receive");
      expect(r.interestPaid).toBe(N * ((FLAT + 0.01) / 12));
      expect(r.couponRate).toBe(FLAT + 0.01);
    }
    expect(float[11]!.principalPaid).toBe(N);
  });

  it("the two notional exchanges cancel: every month's balances sum to exactly 0", () => {
    const rows = rowsOf(terms());
    for (let m = 1; m <= 12; m++) {
      const month = rows.filter((r) => r.monthOffset === m);
      expect(month[0]!.balance + month[1]!.balance, `month ${m}`).toBe(0);
    }
  });

  it("receive-fixed is the exact negation of pay-fixed, row for row", () => {
    const pay = rowsOf(terms({ direction: "pay-fixed" }));
    const rec = rowsOf(terms({ direction: "receive-fixed" }));
    expect(rec).toHaveLength(pay.length);
    for (let i = 0; i < pay.length; i++) {
      expect(rec[i]!.interestPaid, `row ${i}`).toBe(-pay[i]!.interestPaid);
      expect(rec[i]!.principalPaid + pay[i]!.principalPaid, `row ${i}`).toBe(0);
      expect(rec[i]!.balance, `row ${i}`).toBe(-pay[i]!.balance);
      expect(rec[i]!.leg, `row ${i}`).not.toBe(pay[i]!.leg);
    }
  });

  it("the repricing schedule is the floating leg's reset grid", () => {
    expect(new SwapInstrument(terms({ resetFrequencyMonths: 3 })).repricingSchedule()).toEqual([1, 4, 7, 10]);
  });

  it("names which leg is which", () => {
    const p = new SwapInstrument(terms({ direction: "pay-fixed" }));
    expect([p.fixedLeg, p.floatingLeg]).toEqual(["pay", "receive"]);
    const r = new SwapInstrument(terms({ direction: "receive-fixed" }));
    expect([r.fixedLeg, r.floatingLeg]).toEqual(["receive", "pay"]);
  });

  it("refuses invalid terms at construction", () => {
    expect(() => new SwapInstrument(terms({ notional: 0 }))).toThrow(SwapTermsError);
  });
});
