import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../../rates/marketData";
import { bootstrapZeroCurve, shockCurve, type ZeroCurve } from "../../rates/bootstrap";
import { buildTLPCurve, type TLPCurve } from "../../rates/tlpCurve";
import { DeterministicRatePath } from "../../rates/ratePath";
import { NMDeposit, NMD_TERMS_DEFAULTS } from "../../instruments/nmd";
import { NMDBeta, NMD_B_TERMS_DEFAULTS } from "../../instruments/nmdBeta";
import { buildWarmupSOFR1M } from "../../behavioral/nmdModel";
import {
  ParallelShockPath,
  effectiveDurationOnPaths,
  walFromCashflows,
} from "../duration";
import type { Cashflow, RatePath } from "../../instruments/types";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");
const ZERO_TLP: TLPCurve = buildTLPCurve([{ tYears: 1, spread: 0 }]);

async function loadCurve(): Promise<ZeroCurve> {
  return bootstrapZeroCurve(await loadMarketSnapshot(MARKET_PATH));
}

/**
 * Static (frozen-runoff) discounting duration of a fixed cashflow set: the
 * pure (PV_- − PV_+)/(2·PV_0·Δr) with the cashflows held fixed and only the
 * discount curve shifted. This is the floor an NMD effective duration should
 * sit at when the behavioral runoff does NOT respond to a parallel shock —
 * i.e. when the rate-surprise spread is invariant and salience is held.
 */
function staticDuration(
  cf: ReadonlyArray<Cashflow>,
  curve: ZeroCurve,
  tlp: TLPCurve,
  shockBp = 100,
): number {
  const dfFor = (bp: number) => {
    const c = bp === 0 ? curve : shockCurve(curve, bp);
    return (t: number) => (t <= 0 ? 1 : c.discountFactor(t) * Math.exp(-tlp.tlp(t) * t));
  };
  const pv = (bp: number) => {
    const df = dfFor(bp);
    let s = 0;
    for (const x of cf) s += df(x.monthOffset / 12) * (x.principalPaid + x.interestPaid);
    return s;
  };
  const p0 = pv(0);
  return (pv(-shockBp) - pv(shockBp)) / (2 * p0 * (shockBp / 1e4));
}

describe("shockCurve", () => {
  it("shifts every zero rate by exactly the bump; DFs scale by exp(-s t)", async () => {
    const curve = await loadCurve();
    const up = shockCurve(curve, 100);
    const down = shockCurve(curve, -100);
    for (const t of [0.25, 1, 5, 17.3, 30]) {
      expect(up.zeroRate(t) - curve.zeroRate(t)).toBeCloseTo(0.01, 12);
      expect(down.zeroRate(t) - curve.zeroRate(t)).toBeCloseTo(-0.01, 12);
      expect(up.discountFactor(t) / curve.discountFactor(t)).toBeCloseTo(Math.exp(-0.01 * t), 12);
    }
  });
});

describe("effective duration engine", () => {
  it("ParallelShockPath bumps spot and forwards uniformly from step 0", async () => {
    const curve = await loadCurve();
    const base = new DeterministicRatePath(curve, 120);
    const up = new ParallelShockPath(base, 100);
    expect(up.rateAt(0) - base.rateAt(0)).toBeCloseTo(0.01, 12);
    expect(up.rateAt(60) - base.rateAt(60)).toBeCloseTo(0.01, 12);
    expect(up.forwardRateAt(24, 5) - base.forwardRateAt(24, 5)).toBeCloseTo(0.01, 12);
  });

  it("zero-coupon bullet reproduces the analytic duration ~T", async () => {
    // A 5Y bullet with no rate-dependent cashflows: D_eff = sinh(sT)/s ≈ T to
    // second order (5.002 at s = 100 bp). Pins the engine arithmetic.
    const curve = await loadCurve();
    const bullet = (_path: RatePath): Cashflow[] => [
      { monthOffset: 60, balance: 100, principalPaid: 100, interestPaid: 0, couponRate: 0 },
    ];
    const paths = [new DeterministicRatePath(curve, 60)];
    const r = effectiveDurationOnPaths(bullet, paths, curve, ZERO_TLP, { discountBasis: "sofr" });
    expect(r.pvBase).toBeCloseTo(100 * curve.discountFactor(5), 10);
    expect(r.effectiveDuration).toBeCloseTo(5.0, 1);
    expect(r.pvDown).toBeGreaterThan(r.pvBase);
    expect(r.pvBase).toBeGreaterThan(r.pvUp);
  });

  it("par anchor solves a positive spread and leaves a bullet's duration unchanged", async () => {
    // PV0 of the 5Y bullet ≈ 81 > 80, so anchoring to 80 forces a positive
    // spread; e^{-sT} scales all three legs of a single bullet equally, so
    // the effective duration is invariant to the anchor.
    const curve = await loadCurve();
    const bullet = (_path: RatePath): Cashflow[] => [
      { monthOffset: 60, balance: 100, principalPaid: 100, interestPaid: 0, couponRate: 0 },
    ];
    const paths = [new DeterministicRatePath(curve, 60)];
    const r = effectiveDurationOnPaths(bullet, paths, curve, ZERO_TLP, {
      discountBasis: "sofr",
      parAnchor: 80,
    });
    expect(r.pvBase).toBeCloseTo(80, 6);
    expect(r.spreadBp).toBeGreaterThan(0);
    expect(r.effectiveDuration).toBeCloseTo(5.0, 1);
  });

  // Non-IB EVE engine generator: re-level the warmup history with the shock so
  // the regime excursion r − MA is invariant under a parallel move (r and MA
  // shift together — the excursion amplifier needs no freeze). The opportunity-cost
  // incentive logistic reads the spot LEVEL r on the shocked path, so it DOES
  // respond to the ±100bp shock — that genuine negative convexity (runoff
  // accelerates as rates rise) is the point of the regime-aware redesign.
  const nonIbGenerator =
    (terms = NMD_TERMS_DEFAULTS, historical = buildWarmupSOFR1M()) =>
    (p: RatePath, shockBp: number) => {
      const hist = shockBp === 0 ? historical : historical.map((h) => h + shockBp / 100);
      return new NMDeposit(terms, hist).generateCashflows(p);
    };

  it("Non-IB EVE duration: spot-level incentive responds ⇒ positive but short, negative-convexity (below static discounting duration)", async () => {
    // The incentive logistic reads the spot LEVEL r, so +100bp accelerates runoff
    // and −100bp slows it. Effective duration is therefore SHORTER than the static
    // (frozen-runoff) discounting duration — genuine negative convexity — while
    // staying positive and well below WAL. No salience freeze is involved.
    const curve = await loadCurve();
    const historical = buildWarmupSOFR1M();
    const basePath = new DeterministicRatePath(curve, NMD_TERMS_DEFAULTS.maturityMonths);
    const baseCfs = new NMDeposit(NMD_TERMS_DEFAULTS, historical).generateCashflows(basePath);
    const wal = walFromCashflows(baseCfs, NMD_TERMS_DEFAULTS.notional);
    const staticDur = staticDuration(baseCfs, curve, ZERO_TLP);

    const r = effectiveDurationOnPaths(nonIbGenerator(), [basePath], curve, ZERO_TLP);

    expect(wal).toBeGreaterThan(1);
    expect(r.effectiveDuration).toBeGreaterThan(0); // still a positive, hedgeable duration
    expect(r.effectiveDuration).toBeLessThan(wal); // below WAL
    expect(r.effectiveDuration).toBeLessThan(staticDur); // negative convexity vs the frozen runoff
    expect(staticDur - r.effectiveDuration).toBeGreaterThan(0.10); // a non-trivial convexity wedge
    expect(r.pvDown).toBeGreaterThan(r.pvUp); // rates down ⇒ higher PV
  });

  it("Non-IB EVE convexity comes from the incentive: zeroing the incentive recovers the static discounting duration", async () => {
    // The old level-salience design had to be FROZEN, so effDur was invariant to
    // the S-curve. Now the convexity IS the responsive incentive: remove it
    // (maxRateDecay = maxRateGrowth = 0 ⇒ closure-only, rate-insensitive runoff)
    // and the effective duration collapses back to the pure discounting duration,
    // with no parallel-shock response left.
    const curve = await loadCurve();
    const basePath = new DeterministicRatePath(curve, NMD_TERMS_DEFAULTS.maturityMonths);
    const flatTerms = {
      ...NMD_TERMS_DEFAULTS,
      nmdParams: { ...NMD_TERMS_DEFAULTS.nmdParams, maxRateDecay: 0, maxRateGrowth: 0 },
    };
    const flatBaseCfs = new NMDeposit(flatTerms, buildWarmupSOFR1M()).generateCashflows(basePath);
    const flatStatic = staticDuration(flatBaseCfs, curve, ZERO_TLP);
    const flat = effectiveDurationOnPaths(nonIbGenerator(flatTerms), [basePath], curve, ZERO_TLP);
    const live = effectiveDurationOnPaths(nonIbGenerator(), [basePath], curve, ZERO_TLP);
    // No incentive ⇒ rate-insensitive runoff ⇒ effDur equals its static discounting duration.
    expect(flat.effectiveDuration).toBeCloseTo(flatStatic, 6);
    // The responsive incentive shortens the live duration below the inert one.
    expect(live.effectiveDuration).toBeLessThan(flat.effectiveDuration);
  });

  it("IB EVE duration: runoff responds to r−D spread + coupon reprices, no salience; positive, below Non-IB and WAL", async () => {
    // Phase 2 dropped the IB cash-sorting salience entirely, so there is no level
    // term to freeze (no basePath arg). The IB opportunity-cost spread r−D DOES
    // move under a parallel shift (D=β·r reprices), so the runoff responds and the
    // β slice reprices the coupon. With salience gone the duration is POSITIVE even
    // without any freeze. Expected: positive, below the zero-coupon Non-IB
    // duration, and below the IB WAL.
    const curve = await loadCurve();
    const basePath = new DeterministicRatePath(curve, NMD_B_TERMS_DEFAULTS.maturityMonths);
    const ibWal = walFromCashflows(
      new NMDBeta(NMD_B_TERMS_DEFAULTS).generateCashflows(basePath),
      NMD_B_TERMS_DEFAULTS.notional,
    );
    const ibDur = effectiveDurationOnPaths(
      (p) => new NMDBeta(NMD_B_TERMS_DEFAULTS).generateCashflows(p),
      [basePath],
      curve,
      ZERO_TLP,
    );

    const nonIbDur = effectiveDurationOnPaths(
      nonIbGenerator(),
      [new DeterministicRatePath(curve, NMD_TERMS_DEFAULTS.maturityMonths)],
      curve,
      ZERO_TLP,
    );

    expect(ibDur.effectiveDuration).toBeGreaterThan(0);
    expect(ibDur.effectiveDuration).toBeLessThan(nonIbDur.effectiveDuration);
    expect(ibDur.effectiveDuration).toBeLessThan(ibWal);
  });

  it("IB static duration reprices the floating coupon: far below the frozen-coupon static, just above effDur", async () => {
    // An IB deposit pays a β≈0.6 floating coupon, so the correct "static"
    // (frozen behavioral runoff, contractual coupon repricing, shifted discount)
    // is short — NOT the fixed-coupon-bond static that freezes D(t). Freezing the
    // coupon overstates the duration by ~2y and makes the WAL>static>effDur
    // hierarchy read a behavioral convexity wedge that is really just coupon float.
    const curve = await loadCurve();
    const terms = NMD_B_TERMS_DEFAULTS;
    const inst = new NMDBeta(terms);
    const basePath = new DeterministicRatePath(curve, terms.maturityMonths);

    const baseCfs = inst.generateCashflows(basePath);
    const wal = walFromCashflows(baseCfs, terms.notional);
    const frozenCouponStatic = staticDuration(baseCfs, curve, ZERO_TLP); // freezes D(t) too

    // Floating-coupon static: freeze the runoff (principal + opening balances),
    // reprice D(t)=β(r±Δ)·(r±Δ) on the ±shock path, recompute interest, shift DF.
    const sim = inst.simulateBook(basePath);
    const dfFor = (bp: number) => {
      const c = bp === 0 ? curve : shockCurve(curve, bp);
      return (t: number) => (t <= 0 ? 1 : c.discountFactor(t) * Math.exp(-ZERO_TLP.tlp(t) * t));
    };
    const pvFloat = (bp: number) => {
      const shocked = bp === 0 ? basePath : new ParallelShockPath(basePath, bp);
      const dPct = inst.depositRatePath(shocked).dPct;
      const df = dfFor(bp);
      let s = 0;
      for (let k = 0; k < sim.length; k++) {
        const t = sim[k].monthOffset / 12;
        s += df(t) * (sim[k].principalPaid + (sim[k].balance * (dPct[k] / 100)) / 12);
      }
      return s;
    };
    const floatingStatic = (pvFloat(-100) - pvFloat(100)) / (2 * pvFloat(0) * 0.01);

    const effDur = effectiveDurationOnPaths(
      (p) => new NMDBeta(terms).generateCashflows(p),
      [basePath],
      curve,
      ZERO_TLP,
    ).effectiveDuration;

    expect(frozenCouponStatic).toBeGreaterThan(2); // fixed-coupon artifact, ~2.4y
    expect(floatingStatic).toBeLessThan(1); // floating coupon ⇒ short static (~0.42y)
    expect(floatingStatic).toBeLessThan(wal);
    expect(floatingStatic).toBeLessThan(frozenCouponStatic - 1.5); // coupon float removes ~2y
    expect(effDur).toBeLessThan(floatingStatic); // behavioral runoff convexity wedge is positive
    expect(floatingStatic - effDur).toBeLessThan(0.6); // and modest, not the 2.2y the frozen static implied
  });
});
