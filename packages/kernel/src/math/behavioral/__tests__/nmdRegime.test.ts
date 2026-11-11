import { describe, expect, it } from "vitest";
import { regimeAmplifier, nmdIncentiveAt, NMD_DEFAULTS } from "../nmdModel";
import { NMDeposit, NMD_TERMS_DEFAULTS } from "../../instruments/nmd";
import { DeterministicRatePath } from "../../rates/ratePath";
import type { RatePath } from "../../instruments/types";

/** Flat continuously-compounded curve at `rate` (decimal). 1M reads `rate`. */
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

/** Tiny synthetic warmup history flat at `ratePct` (% pa). */
function flatHistory(ratePct: number, nMonths: number): number[] {
  return new Array(nMonths).fill(ratePct);
}

/** Principal-weighted WAL (years) of an NMD cashflow stream. */
function walOf(cf: ReturnType<NMDeposit["generateCashflows"]>): number {
  let n = 0;
  let d = 0;
  for (const c of cf) {
    n += (c.monthOffset / 12) * c.principalPaid;
    d += c.principalPaid;
  }
  return d > 1e-12 ? n / d : 0;
}

describe("regimeAmplifier (excursion amplifier 1 + alpha*max(0, r - MA))", () => {
  it("is 1 when the rate is at or below its trailing MA (no surge)", () => {
    expect(regimeAmplifier(4.0, 4.0, 2.0)).toBeCloseTo(1.0, 12);
    expect(regimeAmplifier(3.0, 4.0, 2.0)).toBeCloseTo(1.0, 12); // floored at 0 excursion
  });

  it("rises linearly with the positive excursion at slope alpha (percentage points)", () => {
    expect(regimeAmplifier(6.0, 4.0, 2.0)).toBeCloseTo(5.0, 12); // 1 + 2*(6-4)
    expect(regimeAmplifier(4.5, 4.0, 2.0)).toBeCloseTo(2.0, 12); // 1 + 2*0.5
  });

  it("alpha = 0 disables amplification", () => {
    expect(regimeAmplifier(8.0, 2.0, 0)).toBeCloseTo(1.0, 12);
  });
});

describe("Non-IB decay: opportunity-cost incentive on the spot LEVEL", () => {
  // The old model drove the incentive off r - MA, so any FLAT rate (spread 0)
  // gave the same decay regardless of level. The new model drives the incentive
  // off the spot level r (opportunity cost of a 0%-paying deposit), so a flat
  // HIGH-rate book sorts faster than a flat LOW-rate book even with no surge.
  it("a flat high-rate book decays faster (shorter WAL) than a flat low-rate book, both surge-free", () => {
    const horizon = 240;
    const mk = (lvlPct: number) =>
      new NMDeposit(
        { ...NMD_TERMS_DEFAULTS, maturityMonths: horizon },
        flatHistory(lvlPct, NMD_TERMS_DEFAULTS.nmdParams.maPeriod + 12),
      ).generateCashflows(flatCurveRatePath(lvlPct / 100, horizon));
    // history == level in both cases ⇒ excursion 0 ⇒ amplifier 1; only the
    // level-incentive distinguishes them.
    const walHigh = walOf(mk(6.0));
    const walLow = walOf(mk(1.0));
    expect(walHigh).toBeLessThan(walLow);
  });
});

describe("Non-IB decay: regime amplifier captures surge path-dependency", () => {
  // Same spot level, different rate HISTORY: a rate that has jumped above its
  // recent regime (surge of low-yield deposits now fleeing) decays faster than
  // the same rate that has been the prevailing norm (already optimized).
  it("a rate above its trailing regime decays faster than the same rate as the norm", () => {
    const horizon = 240;
    const lvlPct = 6.0;
    const mk = (histPct: number) =>
      new NMDeposit(
        { ...NMD_TERMS_DEFAULTS, maturityMonths: horizon },
        flatHistory(histPct, NMD_TERMS_DEFAULTS.nmdParams.maPeriod + 12),
      ).generateCashflows(flatCurveRatePath(lvlPct / 100, horizon));
    const walSurge = walOf(mk(2.0)); // 6% after a 2% regime → big excursion
    const walNorm = walOf(mk(6.0)); // 6% is the regime → no excursion
    expect(walSurge).toBeLessThan(walNorm);
  });

  it("alpha controls the strength of the surge response", () => {
    const horizon = 240;
    const lvlPct = 6.0;
    const mk = (alpha: number) =>
      new NMDeposit(
        {
          ...NMD_TERMS_DEFAULTS,
          maturityMonths: horizon,
          nmdParams: { ...NMD_TERMS_DEFAULTS.nmdParams, regimeAlpha: alpha },
        },
        flatHistory(2.0, NMD_TERMS_DEFAULTS.nmdParams.maPeriod + 12),
      ).generateCashflows(flatCurveRatePath(lvlPct / 100, horizon));
    // Larger alpha ⇒ stronger surge amplification ⇒ faster decay ⇒ shorter WAL.
    expect(walOf(mk(4.0))).toBeLessThan(walOf(mk(1.0)));
  });
});

describe("nmdIncentiveAt stays the one-sided logistic (driver-agnostic)", () => {
  it("equals the growth/decay average at the midpoint and is monotone in the driver", () => {
    const p = NMD_DEFAULTS;
    expect(nmdIncentiveAt(p, p.logisticMidpoint)).toBeCloseTo(
      (p.maxRateGrowth + p.maxRateDecay) / 2,
      12,
    );
    expect(nmdIncentiveAt(p, p.logisticMidpoint + 1)).toBeGreaterThan(
      nmdIncentiveAt(p, p.logisticMidpoint),
    );
  });
});
