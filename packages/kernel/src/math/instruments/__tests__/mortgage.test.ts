import { describe, expect, it } from "vitest";
import { Mortgage, MORTGAGE_DEFAULTS } from "../mortgage";
import { MBS_DEFAULTS } from "../../behavioral/mbsModel";
import { DeterministicRatePath } from "../../rates/ratePath";
import type { RatePath } from "../types";

/**
 * Flat zero curve at `rate` (continuous-comp). Used so the 10Y benchmark the
 * mortgage looks at is constant across the whole horizon, which makes the
 * CPR-vs-rate behaviour easy to reason about in tests.
 */
function flatCurveRatePath(rate: number, nSteps: number): RatePath {
  const stub = {
    t: [],
    z: [],
    zeroRate: () => rate,
    discountFactor: (t: number) => Math.exp(-rate * t),
    forwardRate: () => rate,
    forwardRateBey: () => rate,
    forwardSwapRate: () => rate,
  };
  return new DeterministicRatePath(stub as never, nSteps);
}

describe("Mortgage instrument", () => {
  it("rejects degenerate constructor inputs", () => {
    expect(() => new Mortgage({ ...MORTGAGE_DEFAULTS, notional: 0 })).toThrow();
    expect(() => new Mortgage({ ...MORTGAGE_DEFAULTS, maturityMonths: 0 })).toThrow();
    expect(() => new Mortgage({ ...MORTGAGE_DEFAULTS, noteRate: -0.01 })).toThrow();
  });

  it("zero-CPR config reduces to a level-pay schedule that fully amortizes", () => {
    const zeroCpr = { ...MBS_DEFAULTS, minCpr: 0, maxCpr: 0 };
    const m = new Mortgage({
      ...MORTGAGE_DEFAULTS,
      notional: 400_000,
      originalBalance: 400_000,
      ageMonths: 0,
      originalTermMonths: 360,
      maturityMonths: 360,
      noteRate: 0.065,
      cprParams: zeroCpr,
    });
    // 10Y benchmark high enough that ITM = 0 → no minCpr kicks in either.
    const path = flatCurveRatePath(0.10, 360);
    const cf = m.generateCashflows(path);

    expect(cf.length).toBe(360);
    // Total principal paid equals notional within rounding.
    const totalP = cf.reduce((s, c) => s + c.principalPaid, 0);
    expect(totalP).toBeCloseTo(400_000, 2);
    // No early termination: balance at month 359 is small but positive,
    // balance after month 360 is exactly zero.
    expect(cf[358].balance).toBeGreaterThan(0);
    // Last row clamps to remaining balance.
    expect(cf[359].principalPaid).toBeCloseTo(cf[359].balance, 4);
  });

  it("ITM environment increases CPR vs OTM environment, shortening WAL", () => {
    const params = { ...MBS_DEFAULTS, minCpr: 2, maxCpr: 65 };
    const make = (path: RatePath) =>
      new Mortgage({
        ...MORTGAGE_DEFAULTS,
        notional: 400_000,
        originalBalance: 400_000,
        originalTermMonths: 360,
        maturityMonths: 360,
        ageMonths: 12, // past the seasoning ramp so ri is fully active
        noteRate: 0.07,
        cprParams: params,
      }).generateCashflows(path);

    // ITM: market rate 3% well below note 7% → big refi incentive.
    const itm = make(flatCurveRatePath(0.03, 360));
    // OTM: market rate 9% above note 7% → no refi incentive, near minCpr.
    const otm = make(flatCurveRatePath(0.09, 360));

    const wal = (cf: ReturnType<typeof make>) => {
      let n = 0;
      let d = 0;
      for (const c of cf) {
        n += (c.monthOffset / 12) * c.principalPaid;
        d += c.principalPaid;
      }
      return d > 1e-12 ? n / d : 0;
    };

    // ITM environment substantially shortens WAL — material refi-driven prepay.
    expect(wal(itm)).toBeLessThan(wal(otm));
    expect(wal(otm) - wal(itm)).toBeGreaterThan(2); // years
  });

  it("interest equals balance × noteRate / 12 every month", () => {
    const m = new Mortgage({ ...MORTGAGE_DEFAULTS, notional: 300_000, noteRate: 0.06 });
    const path = flatCurveRatePath(0.04, 360);
    const cf = m.generateCashflows(path);
    for (const c of cf) {
      expect(c.interestPaid).toBeCloseTo((c.balance * 0.06) / 12, 6);
      expect(c.couponRate).toBeCloseTo(0.06, 12);
    }
  });

  it("repricingSchedule is empty (mortgage is fixed-rate from bank's perspective)", () => {
    const m = new Mortgage(MORTGAGE_DEFAULTS);
    expect(m.repricingSchedule()).toEqual([]);
  });

  it("seasoned mortgage hits full seasoning multiplier from month 1", () => {
    // ageMonths = 30 >= seasoningRamp (default 30), so seasoning factor = 1.0
    // immediately. With ITM rates we expect month-1 CPR strictly above minCpr.
    const m = new Mortgage({
      ...MORTGAGE_DEFAULTS,
      ageMonths: 30,
      noteRate: 0.07,
      cprParams: { ...MBS_DEFAULTS, minCpr: 2, maxCpr: 60 },
    });
    const path = flatCurveRatePath(0.04, 360); // strongly ITM
    const cf = m.generateCashflows(path);
    // Month 1 prepayment principal should be material (refi-driven).
    const sched1 = cf[0].balance * (0.07 / 12) / (Math.pow(1 + 0.07 / 12, cf.length) - 1);
    const prepay1 = cf[0].principalPaid - sched1;
    expect(prepay1).toBeGreaterThan(0);
  });

  it("the refi incentive reads the position's note rate (a 7.5% loan prepays far faster than a 4% loan)", () => {
    // Flat 10Y at 4% plus the default 250 bp spread: market mortgage rate 6.50%.
    // A 7.5% note is 100 bp in the money, a 4% note 250 bp out of it. Before the
    // 2026-09-24 fix both prepaid as a 6.5% pool (cprParams.wac), so the 7.5% loan
    // came out LONGER (5.28y vs 5.05y) from amortization alone.
    const path = flatCurveRatePath(0.04, 360);
    const wal = (noteRate: number) => {
      const cf = new Mortgage({ ...MORTGAGE_DEFAULTS, ageMonths: 36, noteRate }).generateCashflows(path);
      let n = 0;
      let d = 0;
      for (const c of cf) {
        n += (c.monthOffset / 12) * c.principalPaid;
        d += c.principalPaid;
      }
      return n / d;
    };
    // Measured with the fix: 4% note 14.53y, 7.5% note 1.46y.
    expect(wal(0.075)).toBeLessThan(wal(0.04) - 5);
  });

  it("cprParams.wac does not reach the Mortgage cashflows (WAC is a position attribute)", () => {
    const path = flatCurveRatePath(0.04, 360);
    const make = (wac: number) =>
      new Mortgage({
        ...MORTGAGE_DEFAULTS,
        ageMonths: 36,
        noteRate: 0.06,
        cprParams: { ...MBS_DEFAULTS, wac },
      }).generateCashflows(path);
    expect(make(3)).toEqual(make(9));
  });
});
