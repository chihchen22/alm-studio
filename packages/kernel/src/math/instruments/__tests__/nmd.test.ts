import { describe, expect, it } from "vitest";
import { NMDeposit, NMD_TERMS_DEFAULTS } from "../nmd";
import { NMD_DEFAULTS } from "../../behavioral/nmdModel";
import { DeterministicRatePath } from "../../rates/ratePath";
import type { RatePath } from "../types";

/** Flat continuously-compounded curve at `rate`. The path's 1M reads `rate` */
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

/** Tiny synthetic warmup history flat at `rate` so MA tests are tractable. */
function flatHistory(ratePct: number, nMonths: number): number[] {
  return new Array(nMonths).fill(ratePct);
}

describe("NMDeposit instrument", () => {
  it("rejects degenerate inputs", () => {
    expect(() => new NMDeposit({ ...NMD_TERMS_DEFAULTS, notional: 0 })).toThrow();
    expect(() => new NMDeposit({ ...NMD_TERMS_DEFAULTS, maturityMonths: 0 })).toThrow();
    expect(() => new NMDeposit({ ...NMD_TERMS_DEFAULTS, depositRate: -0.001 })).toThrow();
  });

  it("repricingSchedule is empty (NMD-A is fixed-rate from bank's perspective)", () => {
    const inst = new NMDeposit(NMD_TERMS_DEFAULTS);
    expect(inst.repricingSchedule()).toEqual([]);
  });

  it("side is liability and tags through to terms", () => {
    expect(NMD_TERMS_DEFAULTS.side).toBe("liability");
    const inst = new NMDeposit(NMD_TERMS_DEFAULTS);
    expect(inst.terms.side).toBe("liability");
  });

  it("flat-rate path with flat history: regime amplifier dormant, level incentive produces baseline attrition", () => {
    // Current 1M = trailing MA → excursion 0 → regime amplifier = 1. The
    // opportunity-cost incentive logistic reads the LEVEL r (= 4%), so it produces
    // a positive baseline attrition (no surge amplification). The point of this
    // test is just that the model runs and produces a positive, monotone attrition
    // stream; sharper isolation tests use synthesized parameters below.
    const ratePct = 4.0;
    const horizon = 60;
    const inst = new NMDeposit(
      {
        ...NMD_TERMS_DEFAULTS,
        notional: 1_000_000,
        maturityMonths: horizon,
        nmdParams: { ...NMD_DEFAULTS, balanceSize: 1_000_000 },
      },
      flatHistory(ratePct, NMD_DEFAULTS.maPeriod + 12),
    );
    const path = flatCurveRatePath(ratePct / 100, horizon);
    const cf = inst.generateCashflows(path);
    expect(cf.length).toBeGreaterThan(0);
    expect(cf.length).toBeLessThanOrEqual(horizon);
    // Balance is monotonically non-increasing; final attrition clamps to balance.
    for (let i = 1; i < cf.length; i++) {
      expect(cf[i].balance).toBeLessThanOrEqual(cf[i - 1].balance + 1e-6);
    }
    const totalAttrition = cf.reduce((s, c) => s + c.principalPaid, 0);
    expect(totalAttrition).toBeGreaterThan(0);
    // Cohort doesn't fully drain in 60 months under defaults.
    expect(cf[cf.length - 1].balance).toBeGreaterThan(0);
  });

  it("zero rate incentive (maxRateDecay = maxRateGrowth = 0): decay is closure-only", () => {
    // With base_incentive ≡ 0 the balance-sensitivity surface contributes nothing,
    // so every bucket decays at closure(t) only, held flat at closureSteady. The
    // bucket distribution is irrelevant when the rate term is off.
    const params = {
      ...NMD_DEFAULTS,
      closureInitial: 1.0,
      closureSteady: 1.0, // %/mo, flat
      burnoutLambda: 0,
      maxRateDecay: 0,
      maxRateGrowth: 0,
      balanceSize: 100_000,
    };
    const horizon = 24;
    const inst = new NMDeposit(
      {
        ...NMD_TERMS_DEFAULTS,
        notional: 100_000,
        maturityMonths: horizon,
        nmdParams: params,
      },
      flatHistory(4.0, NMD_DEFAULTS.maPeriod + 12),
    );
    const path = flatCurveRatePath(0.04, horizon);
    const cf = inst.generateCashflows(path);

    // closureSteady = 1%/mo → balance multiplied by (1 - 0.01) = 0.99 each month
    // until the final clamp.
    let expected = 100_000;
    for (let i = 0; i < cf.length - 1; i++) {
      expect(cf[i].balance).toBeCloseTo(expected, 4);
      expected *= 0.99;
    }
    // Final month clamps the principal to remaining balance.
    expect(cf[cf.length - 1].principalPaid).toBeCloseTo(cf[cf.length - 1].balance, 6);
  });

  it("interest = balance × depositRate / 12 every month", () => {
    const inst = new NMDeposit(
      {
        ...NMD_TERMS_DEFAULTS,
        notional: 2_000_000,
        depositRate: 0.005,
      },
      flatHistory(4.0, NMD_DEFAULTS.maPeriod + 12),
    );
    const path = flatCurveRatePath(0.04, 120);
    const cf = inst.generateCashflows(path);
    for (const c of cf) {
      expect(c.interestPaid).toBeCloseTo((c.balance * 0.005) / 12, 6);
      expect(c.couponRate).toBeCloseTo(0.005, 12);
    }
  });

  it("balance-sensitivity form: det WAL with NMD_TERMS_DEFAULTS lands in [2, 9] years", () => {
    // Flat 4% path + flat 4% history → excursion 0 throughout (regime amplifier 1),
    // so attrition is the level-incentive logistic at r = 4%. Wide band guards
    // against structural breakage; the ~5y stock / ~4.4y cohort operating point is
    // tuned against the 3/31 curve in the app.
    const horizon = 360;
    const ratePct = 4.0;
    const inst = new NMDeposit(
      { ...NMD_TERMS_DEFAULTS, notional: 1_000_000, maturityMonths: horizon },
      flatHistory(ratePct, NMD_TERMS_DEFAULTS.nmdParams.maPeriod + 12),
    );
    const path = flatCurveRatePath(ratePct / 100, horizon);
    const cf = inst.generateCashflows(path);
    let walNum = 0;
    let walDen = 0;
    for (const c of cf) {
      walNum += (c.monthOffset / 12) * c.principalPaid;
      walDen += c.principalPaid;
    }
    const lastRow = cf[cf.length - 1];
    const residual = lastRow ? Math.max(0, lastRow.balance - lastRow.principalPaid) : 0;
    const wal = (walNum + residual * (horizon / 12)) / (walDen + residual);
    expect(wal).toBeGreaterThan(2);
    expect(wal).toBeLessThan(9);
  });

  it("rising-rate environment shortens WAL vs falling-rate under same params", () => {
    // Rising rates → high opportunity-cost level AND a positive excursion vs the
    // 2% trailing regime → the surge amplifier accelerates attrition earlier →
    // shorter WAL. Falling rates sit at/below the regime (amplifier 1) with a low
    // level, so attrition is slow. Differentiate by WAL, not totals.
    const horizon = 120;
    const baseTerms = {
      ...NMD_TERMS_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: horizon,
      nmdParams: { ...NMD_DEFAULTS, balanceSize: 1_000_000 },
    };
    const wal = (path: RatePath) => {
      const inst = new NMDeposit(baseTerms, flatHistory(2.0, NMD_DEFAULTS.maPeriod + 12));
      const cf = inst.generateCashflows(path);
      let n = 0;
      let d = 0;
      for (const c of cf) {
        n += (c.monthOffset / 12) * c.principalPaid;
        d += c.principalPaid;
      }
      return d > 1e-12 ? n / d : 0;
    };
    const risingWal = wal(flatCurveRatePath(0.07, horizon)); // path 7% vs 2% history
    const fallingWal = wal(flatCurveRatePath(0.005, horizon)); // path 0.5% vs 2% history
    expect(risingWal).toBeLessThan(fallingWal);
  });
});
