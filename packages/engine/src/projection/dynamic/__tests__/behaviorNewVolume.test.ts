/**
 * New tranches carry their family's behavior, worked by hand.
 *
 * Every expected value is computed in this file from the model's definition on a stub rate path whose rates are a
 * written formula, never read back from the code under test. The parameters are moved away from every kernel default
 * (a binding unlike the positions' own values, a one-bucket deposit with a moving average of three months, a partial
 * adjustment below one), so a default-parameter fixture cannot hide a wrong reading.
 *
 *  (a) A mortgage tranche minted at k > 0 on a constant CPR (the four-factor model with a flat S-curve and no
 *      seasonality or burnout) runs the binding's CPR, seasoned from its own origination: month m prepays at
 *      6% x min(1, m / 10) whatever the opening book's age. Balance, principal and interest match the level-payment
 *      schedule written out here. A constant-CPR loan family and a product that cannot carry the model are checked too.
 *  (b) A beta deposit minted at k > 0 decays and reprices from month k: its paid rate is the S-curve beta on the
 *      scenario's rate at step k + m - 1 with partial adjustment, its decay the closure and the r - D logistic with the
 *      regime amplifier on the trailing three-month average, which reaches back past its own origination.
 *  (c) Sizing with behavioral runoff: a flat deposit target and a growing mortgage target are hit every month.
 */
import { describe, expect, it } from "vitest";
import { MBS_DEFAULTS, NMD_B_TERMS_DEFAULTS, NMD_DEFAULTS, buildWarmupSOFR1M, type MBSParams, type NMDParams, type RatePath } from "@alm/kernel";
import type { AssumptionSet } from "../../../contracts/assumptions";
import type { PortfolioSpec, Position } from "../../../contracts/position";
import type { NewBusinessTemplate, Scenario } from "../../../contracts/scenario";
import { projectDynamicScenario, type SweptTranche } from "../dynamicNewBusiness";
import { behaviorGap, familyBehavior } from "../familyBehavior";
import { cohortWarmup, suggestedTemplate } from "../templateTranche";
import { AS_OF, makeCoa, mortgagePosition, nmdBetaPosition, fixedPosition, nmdPosition } from "../../../run/__tests__/fixtures";

const H = 120;
/** One-month rate: rises 20 bp a month with a ripple, so the trailing average sits below the spot rate. */
const r1 = (s: number): number => 0.02 + 0.002 * s + 0.003 * Math.sin(s / 5);
/** Term forward: rises 2 bp a month and with the tenor, so reading from step 0 gives another coupon. */
const fwd = (s: number, tenorYears: number): number => 0.03 + 0.0002 * s + 0.001 * tenorYears;
function stubPath(nSteps = 800): RatePath {
  return { nSteps, times: Array.from({ length: nSteps + 1 }, (_, i) => i / 12), rateAt: r1, forwardRateAt: fwd };
}

const scenario = (rules: Scenario["newBusiness"]["rules"]): Scenario => ({ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "AS", newBusiness: { mode: "dynamic", rules } });
const book = (positions: Position[]): PortfolioSpec => ({ id: "PF-BEH", label: "Behavior book", asOf: AS_OF, coa: makeCoa(), positions });
const trancheAt = (all: SweptTranche[] | undefined, familyId: string, k: number): SweptTranche => {
  const t = (all ?? []).find((x) => x.familyId === familyId && x.bucket === k);
  if (t === undefined) throw new Error(`no ${familyId} tranche at ${k}`);
  return t;
};
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(1, Math.abs(b));

// ---------------------------------------------------------------------------
// (a) prepayment on a mortgage tranche, seasoned from origination
// ---------------------------------------------------------------------------

/** The binding: a four-factor model whose S-curve is flat at (2 + (10 - 2) / 2)% = 6% CPR (steepness 0), no seasonality, no burnout, a 10-month ramp. */
const FLAT_CPR: MBSParams = { ...MBS_DEFAULTS, minCpr: 2, maxCpr: 10, steepness: 0, seasonalityAmp: 0, burnoutDecay: 0, seasoningRamp: 10 };
const mortgageSet: AssumptionSet = {
  schemaVersion: "1.0.0", id: "AS", label: "test", bindings: [{ familyId: "MORTGAGE", overlay: { kind: "prepay", model: "four-factor-cpr", params: FLAT_CPR }, modelVersion: "flat-cpr-test" }],
};
const MORTGAGE_TPL: NewBusinessTemplate = { rateType: "fixed", amortization: "level-pay", indexTenorMonths: 120, fixedIndex: "swap", behavior: "family" };

/** The level-payment schedule with a CPR per month, written out: scheduled principal on the remaining term, then SMM. */
function handMortgage(notional: number, noteRate: number, term: number, cpr: (m: number) => number) {
  const c = noteRate / 12;
  const out: Array<{ balance: number; principal: number; interest: number }> = [];
  let b = notional;
  for (let m = 1; m <= term; m++) {
    const rem = term - m + 1;
    const scheduled = b * (c / (Math.pow(1 + c, rem) - 1));
    const smm = 1 - Math.pow(1 - cpr(m), 1 / 12);
    let principal = scheduled + Math.max(0, b - scheduled) * smm;
    if (m === term || principal > b) principal = b;
    out.push({ balance: b, principal, interest: b * c });
    b -= principal;
  }
  return out;
}

describe("(a) a mortgage tranche minted at k > 0 runs its family's prepayment from its own origination", () => {
  // The opening book is 60 months seasoned and carries the kernel defaults; the binding is the flat 6% model.
  const pf = book([mortgagePosition("M1", { notional: 1_000_000, originalBalance: 1_000_000, ageMonths: 60, maturityMonths: 300, originalTermMonths: 360, noteRate: 0.05 })]);
  const rules = [{ familyId: "MORTGAGE", reinvest: "flat" as const, termMonths: 120, spreadOverIndexBp: 50, template: MORTGAGE_TPL }];
  const dyn = projectDynamicScenario(pf, { scenario: scenario(rules), ratePath: stubPath(), assumptions: mortgageSet }, { horizonMonths: H, asOf: AS_OF }, undefined, undefined, undefined, { keepAllTranches: true });

  it("its coupon is the swap forward read at its own month k plus the spread, and its CPR is the binding's, ramping from age 1", () => {
    const k = 7;
    const t = trancheAt(dyn.allTranches, "MORTGAGE", k);
    const N = dyn.originations.find((o) => o.familyId === "MORTGAGE")!.originations[k]!;
    expect(N).toBeGreaterThan(0);
    // Coupon: fwd(7, 10) + 50 bp = 3% + 0.02% x 7 + 0.1% x 10 + 0.5% = 4.64%. Read from step 0 it would be 4.50%.
    const coupon = 0.03 + 0.0002 * 7 + 0.001 * 10 + 0.005;
    expect(coupon).toBeCloseTo(0.0464, 15);
    const cfs = t.instrument.generateCashflows(t.path);
    expect(cfs[0]!.couponRate).toBeCloseTo(coupon, 15);
    // CPR of month m: 6% x min(1, m / 10), the tranche's own age (the opening book, at 60 months, would run 6% flat).
    const hand = handMortgage(N, coupon, 120, (m) => 0.06 * Math.min(1, m / 10));
    expect(cfs).toHaveLength(120);
    for (let m = 1; m <= 120; m++) {
      const h = hand[m - 1]!;
      const c = cfs[m - 1]!;
      expect(rel(c.balance, h.balance)).toBeLessThan(1e-12);
      expect(rel(c.principalPaid, h.principal)).toBeLessThan(1e-12);
      expect(rel(c.interestPaid, h.interest)).toBeLessThan(1e-12);
    }
    // Seasoning starts at origination: month 1 prepays at 0.6%, month 10 and after at 6%, so the first year's
    // prepayment is well below a seasoned 6% schedule's.
    const seasoned = handMortgage(N, coupon, 120, () => 0.06);
    expect(seasoned[0]!.principal - hand[0]!.principal).toBeGreaterThan(0.001 * N);
    // Principal repays the notional over the term.
    expect(rel(cfs.reduce((a, c) => a + c.principalPaid, 0), N)).toBeLessThan(1e-12);
  });

  it("the product states the model, where it came from and that it runs", () => {
    const p = dyn.originations.find((o) => o.familyId === "MORTGAGE")!.product!;
    expect(p.behavior).toEqual({ model: "four-factor-cpr", applied: true, source: "assumption-set", modelVersions: ["flat-cpr-test"], note: expect.stringContaining("aged from the month it is made") });
  });

  it("a floating product on the same family cannot carry the prepayment model: contractual, and said so", () => {
    const floatRules = [{ familyId: "MORTGAGE", reinvest: "flat" as const, termMonths: 120, spreadOverIndexBp: 50, template: { rateType: "floating" as const, amortization: "level-pay" as const, indexTenorMonths: 3, behavior: "family" as const } }];
    const d = projectDynamicScenario(pf, { scenario: scenario(floatRules), ratePath: stubPath(), assumptions: mortgageSet }, { horizonMonths: H, asOf: AS_OF }, undefined, undefined, undefined, { keepAllTranches: true });
    const p = d.originations.find((o) => o.familyId === "MORTGAGE")!.product!;
    expect(p.behavior?.applied).toBe(false);
    expect(p.behavior?.note).toMatch(/contractual/);
    // A contractual floating level-pay tranche: principal + interest is a level payment between resets, no prepayment.
    const t = trancheAt(d.allTranches, "MORTGAGE", 7);
    const cfs = t.instrument.generateCashflows(t.path);
    expect(rel(cfs[0]!.principalPaid + cfs[0]!.interestPaid, cfs[1]!.principalPaid + cfs[1]!.interestPaid)).toBeLessThan(1e-12);
  });

  it("a fixed-loan family bound to a constant CPR prepays from month 1 at that CPR, no ramp", () => {
    const set: AssumptionSet = { schemaVersion: "1.0.0", id: "AS", label: "t", bindings: [{ familyId: "FIXED", overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.08 }, modelVersion: "cpr8" }] };
    const pf2 = book([fixedPosition("F1", { notional: 500_000, maturityMonths: 24, amortType: "level-pay", coupon: 0.05 })]);
    const rr = [{ familyId: "FIXED", reinvest: "flat" as const, termMonths: 36, spreadOverIndexBp: 0, template: { rateType: "fixed" as const, amortization: "level-pay" as const, indexTenorMonths: 36, fixedIndex: "swap" as const, behavior: "family" as const } }];
    const d = projectDynamicScenario(pf2, { scenario: scenario(rr), ratePath: stubPath(), assumptions: set }, { horizonMonths: H, asOf: AS_OF }, undefined, undefined, undefined, { keepAllTranches: true });
    const k = 4;
    const t = trancheAt(d.allTranches, "FIXED", k);
    const N = t.notional;
    const coupon = 0.03 + 0.0002 * k + 0.001 * 3;
    const hand = handMortgage(N, coupon, 36, () => 0.08);
    const cfs = t.instrument.generateCashflows(t.path);
    for (let m = 1; m <= 36; m++) {
      expect(rel(cfs[m - 1]!.principalPaid, hand[m - 1]!.principal)).toBeLessThan(1e-12);
      expect(rel(cfs[m - 1]!.interestPaid, hand[m - 1]!.interest)).toBeLessThan(1e-12);
    }
    expect(d.originations.find((o) => o.familyId === "FIXED")!.product!.behavior).toMatchObject({ model: "constant-cpr", applied: true, modelVersions: ["cpr8"] });
  });

  it("a template without behavior keeps the tranche contractual: a level payment, no prepayment", () => {
    const { behavior: _b, ...contractual } = MORTGAGE_TPL;
    const d = projectDynamicScenario(pf, { scenario: scenario([{ ...rules[0]!, template: contractual }]), ratePath: stubPath(), assumptions: mortgageSet }, { horizonMonths: H, asOf: AS_OF }, undefined, undefined, undefined, { keepAllTranches: true });
    const t = trancheAt(d.allTranches, "MORTGAGE", 7);
    const hand = handMortgage(t.notional, 0.0464, 120, () => 0);
    const cfs = t.instrument.generateCashflows(t.path);
    for (let m = 1; m <= 120; m++) expect(rel(cfs[m - 1]!.principalPaid, hand[m - 1]!.principal)).toBeLessThan(1e-10);
    expect(d.originations.find((o) => o.familyId === "MORTGAGE")!.product!.behavior).toBeUndefined();
  });
});


describe("(a, fix round L4) the refinance incentive of a tranche made at k reads the mortgage rate at step k + m - 1", () => {
  // A full four-factor binding moved off the defaults: an active S-curve, seasonality and burnout.
  const P: MBSParams = { ...MBS_DEFAULTS, minCpr: 1, maxCpr: 40, steepness: 3, inflection: 40, seasoningRamp: 15, seasonalityAmp: 10, burnoutDecay: 0.2 };
  const set: AssumptionSet = { schemaVersion: "1.0.0", id: "AS", label: "ff", bindings: [{ familyId: "MORTGAGE", overlay: { kind: "prepay", model: "four-factor-cpr", params: P }, modelVersion: "ff-test" }] };
  const pf = book([mortgagePosition("M1", { notional: 1_000_000, originalBalance: 1_000_000, ageMonths: 40, maturityMonths: 320, originalTermMonths: 360, noteRate: 0.05 })]);
  const rules = [{ familyId: "MORTGAGE", reinvest: "flat" as const, termMonths: 120, spreadOverIndexBp: 50, template: MORTGAGE_TPL }];
  const dyn = projectDynamicScenario(pf, { scenario: scenario(rules), ratePath: stubPath(), assumptions: set }, { horizonMonths: H, asOf: AS_OF }, undefined, undefined, undefined, { keepAllTranches: true });

  /** The four-factor CPR of month m of a loan at age 0 made at k, written out from the model's definition. */
  function handCpr(k: number, noteRate: number, months: number): number[] {
    const out: number[] = [];
    let cumItm = 0;
    for (let m = 1; m <= months; m++) {
      const mortgageRate = fwd(k + m - 1, 10) + (P.secSpread + P.primSpread) / 1e4;
      const diff = noteRate * 100 - mortgageRate * 100;
      cumItm += Math.max(0, diff);
      const ri = (P.minCpr + (P.maxCpr - P.minCpr) / (1 + Math.exp(-P.steepness * (diff - P.inflection / 100)))) / 100;
      const seasoning = Math.min(1, m / P.seasoningRamp);
      const monthIndex = ((m - 1) % 12) + 1;
      const seasonality = 1 + (P.seasonalityAmp / 100) * Math.sin((Math.PI * (monthIndex - 4)) / 6);
      const burnout = Math.exp(-(P.burnoutDecay / 100) * cumItm);
      out.push(Math.min(1, Math.max(0, ri * seasoning * seasonality * burnout)));
    }
    return out;
  }

  it("balance, principal and interest for 120 months match a schedule on the hand CPR, and step 0 would read another CPR", () => {
    const k = 9;
    const t = trancheAt(dyn.allTranches, "MORTGAGE", k);
    const coupon = 0.03 + 0.0002 * k + 0.001 * 10 + 0.005;
    const cpr = handCpr(k, coupon, 120);
    const hand = handMortgage(t.notional, coupon, 120, (m) => cpr[m - 1]!);
    const cfs = t.instrument.generateCashflows(t.path);
    for (let m = 1; m <= 120; m++) {
      expect(rel(cfs[m - 1]!.balance, hand[m - 1]!.balance)).toBeLessThan(1e-12);
      expect(rel(cfs[m - 1]!.principalPaid, hand[m - 1]!.principal)).toBeLessThan(1e-12);
      expect(rel(cfs[m - 1]!.interestPaid, hand[m - 1]!.interest)).toBeLessThan(1e-12);
    }
    const fromZero = handCpr(0, coupon, 1);
    expect(Math.abs(fromZero[0]! - cpr[0]!)).toBeGreaterThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// (b) decay and beta repricing on a deposit tranche, read from month k
// ---------------------------------------------------------------------------

/** One bucket, a flat sensitivity of 0.8, a level closure of 0.5% a month, a three-month average and an amplifier. */
const DECAY: NMDParams = {
  ...NMD_DEFAULTS,
  closureSteady: 0.5, closureInitial: 0.5, closureTauMonths: 12, burnoutLambda: 0,
  maxRateDecay: 4, maxRateGrowth: 0, logisticK: 1.2, logisticMidpoint: 1.0, maPeriod: 3, regimeAlpha: 1.5,
  sens: { gMin: 0.8, gMax: 0.8, bStar: 100_000, kappaB: 1 },
  buckets: [{ label: "all", repBalance: 50_000, share: 1 }],
};
const BETA = { betaMin: 0.3, betaMax: 0.7, k: 0.9, m: 3.0, lambda: 0.6 };
const depositSet: AssumptionSet = {
  schemaVersion: "1.0.0", id: "AS", label: "dep",
  bindings: [
    { familyId: "MMA", overlay: { kind: "nmd-decay", params: DECAY }, modelVersion: "decay-test" },
    { familyId: "MMA", overlay: { kind: "deposit-beta", params: BETA }, modelVersion: "beta-test" },
  ],
};
const DEPOSIT_TPL: NewBusinessTemplate = { rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family" };

/** The beta deposit of one bucket, written out month by month from step k of the path. */
function handDeposit(notional: number, k: number, months: number, history: (s: number) => number) {
  const out: Array<{ balance: number; principal: number; interest: number; rate: number }> = [];
  let b = notional;
  let d = 0;
  for (let m = 1; m <= months; m++) {
    const s = k + m - 1;
    const rPct = r1(s) * 100;
    const beta = BETA.betaMin + (BETA.betaMax - BETA.betaMin) / (1 + Math.exp(-BETA.k * (rPct - BETA.m)));
    d = m === 1 ? beta * rPct : Math.max(0, d + BETA.lambda * (beta * rPct - d));
    const spread = rPct - d;
    const base = 0 + (4 - 0) / (1 + Math.exp(-1.2 * (spread - 1.0)));
    const ma = (history(s - 1) + history(s - 2) + history(s - 3)) / 3;
    const amp = 1 + 1.5 * Math.max(0, rPct - ma);
    const incentive = Math.max(0, base * amp * 1 * 0.8);
    const decay = 1 - (1 - 0.5 / 100) * (1 - incentive / 100);
    const leaving = b * decay;
    out.push({ balance: b, principal: leaving, interest: (b * d) / 100 / 12, rate: d / 100 });
    b -= leaving;
  }
  return out;
}

describe("(b) a beta deposit minted at k > 0 decays and reprices from month k", () => {
  const pf = book([nmdBetaPosition("B1", { notional: 2_000_000 })]);
  const rules = [{ familyId: "MMA", reinvest: "flat" as const, termMonths: 360, spreadOverIndexBp: 0, template: DEPOSIT_TPL }];
  const dyn = projectDynamicScenario(pf, { scenario: scenario(rules), ratePath: stubPath(), assumptions: depositSet }, { horizonMonths: H, asOf: AS_OF }, undefined, undefined, undefined, { keepAllTranches: true });

  it("balance, decay, paid rate and interest by month match the hand calculation on the path from step k", () => {
    const k = 5;
    const t = trancheAt(dyn.allTranches, "MMA", k);
    const cfs = t.instrument.generateCashflows(t.path);
    // The trailing average of the tranche's first months reads the path before k: steps 4, 3 and 2 for month 1.
    const hand = handDeposit(t.notional, k, 36, (s) => r1(s) * 100);
    for (let m = 1; m <= 36; m++) {
      const h = hand[m - 1]!;
      const c = cfs[m - 1]!;
      expect(rel(c.balance, h.balance)).toBeLessThan(1e-12);
      expect(rel(c.principalPaid, h.principal)).toBeLessThan(1e-12);
      expect(rel(c.interestPaid, h.interest)).toBeLessThan(1e-12);
      expect(Math.abs(c.couponRate - h.rate)).toBeLessThan(1e-15);
    }
    // Read from step 0 instead, the paid rate of month 1 would be another number.
    const fromZero = handDeposit(t.notional, 0, 1, (s) => (s < 0 ? NaN : r1(s) * 100));
    expect(Math.abs(fromZero[0]!.rate - hand[0]!.rate)).toBeGreaterThan(1e-4);
    // The tranche is a liability that repays nothing more than it took in.
    expect(cfs.reduce((a, c) => a + c.principalPaid, 0)).toBeLessThanOrEqual(t.notional * (1 + 1e-12));
  });

  it("a cohort minted at k = 1 reads the kernel's own warmup for the months before the cut-off", () => {
    const w = buildWarmupSOFR1M();
    const t = trancheAt(dyn.allTranches, "MMA", 1);
    const cfs = t.instrument.generateCashflows(t.path);
    // Month 1 is step 1; its average reads step 0 and the last two warmup months.
    const hist = (s: number): number => (s >= 0 ? r1(s) * 100 : w[w.length + s]!);
    const hand = handDeposit(t.notional, 1, 6, hist);
    for (let m = 1; m <= 6; m++) expect(rel(cfs[m - 1]!.principalPaid, hand[m - 1]!.principal)).toBeLessThan(1e-12);
    expect(cohortWarmup(stubPath(), 3).slice(-3)).toEqual([r1(0) * 100, r1(1) * 100, r1(2) * 100]);
  });

  it("the family's model comes from both bindings, and a deposit family without bindings runs its own values", () => {
    const b = familyBehavior(pf, makeCoa().families.find((f) => f.id === "MMA")!, depositSet);
    expect(b).toMatchObject({ model: "nmd-decay-beta", source: "assumption-set", modelVersions: ["decay-test", "beta-test"], nmdB: { sCurve: BETA } });
    const own = familyBehavior(pf, makeCoa().families.find((f) => f.id === "MMA")!, undefined);
    expect(own).toMatchObject({ model: "nmd-decay-beta", source: "position", nmdB: { sCurve: NMD_B_TERMS_DEFAULTS.sCurve } });
    // A non-interest deposit pays the family's own static rate.
    const dda = book([nmdPosition("D1", { notional: 1_000_000, depositRate: 0.0025 })]);
    const d = projectDynamicScenario(dda, { scenario: scenario([{ familyId: "DDA", reinvest: "flat", termMonths: 360, spreadOverIndexBp: 0, template: DEPOSIT_TPL }]), ratePath: stubPath() }, { horizonMonths: 24, asOf: AS_OF }, undefined, undefined, undefined, { keepAllTranches: true });
    const t = trancheAt(d.allTranches, "DDA", 3);
    const cfs = t.instrument.generateCashflows(t.path);
    expect(cfs.slice(0, 12).every((c) => c.couponRate === 0.0025)).toBe(true);
    expect(d.originations.find((o) => o.familyId === "DDA")!.product!.behavior).toMatchObject({ model: "nmd-decay", applied: true, source: "position" });
  });

  it("a deposit template on a family with no deposit model is refused, never minted as something else", () => {
    const pf2 = book([fixedPosition("F1", { notional: 500_000, maturityMonths: 12 })]);
    expect(() => projectDynamicScenario(pf2, { scenario: scenario([{ familyId: "FIXED", reinvest: "flat", termMonths: 60, spreadOverIndexBp: 0, template: DEPOSIT_TPL }]), ratePath: stubPath() }, { horizonMonths: 24, asOf: AS_OF })).toThrow(/deposit product needs a deposit family/);
  });
});


describe("(fix rounds M3 and L3) a deposit family on a form new deposits cannot carry", () => {
  const FULL = { alphaPct: 0.1, deltaUp: 0.2, deltaDown: 0.1, volRatio: 1, baseShortRatePct: 3.6, baseLastMove: "rise" as const, balances: "flat" as const };
  const set: AssumptionSet = { schemaVersion: "1.0.0", id: "AS", label: "full", bindings: [{ familyId: "MMA", overlay: { kind: "deposit-beta", params: BETA, fullForm: FULL }, modelVersion: "full-test" }] };
  const pf = book([nmdBetaPosition("B1", { notional: 2_000_000 })]);
  const mma = makeCoa().families.find((f) => f.id === "MMA")!;

  it("reads no model, names the one form, is suggested nothing (the stand-in), and a deposit product is refused in one plain sentence", () => {
    const b = familyBehavior(pf, mma, set);
    expect(b).toMatchObject({ model: "none", depositForm: { form: "full beta form", familyLabel: "MMA" } });
    expect(b.reason).toBe("new deposits of MMA cannot carry its full beta form yet, so its new volume is the fixed-rate stand-in");
    expect(suggestedTemplate(mma, pf.positions, b)).toBeNull();
    expect(suggestedTemplate(mma, pf.positions)).not.toBeNull();
    expect(behaviorGap(DEPOSIT_TPL, b)).toBe("new deposits of MMA cannot carry its full beta form yet; choose Fixed rate to use the stand-in");
    // The stand-in itself (today's fixed bullet, no template) runs on the same book and set, without a refusal. (The full
    // form holds balances flat, so a flat target makes no volume until the deposit's own life ends.)
    const d = projectDynamicScenario(pf, { scenario: scenario([{ familyId: "MMA", reinvest: "flat", termMonths: 60, spreadOverIndexBp: 0 }]), ratePath: stubPath(), assumptions: set }, { horizonMonths: 24, asOf: AS_OF });
    expect(d.shortfalls).toHaveLength(0);
    expect(d.originations.find((o) => o.familyId === "MMA")!.originations).toHaveLength(24);
  });
});

// ---------------------------------------------------------------------------
// (c) sizing with behavioral runoff
// ---------------------------------------------------------------------------

describe("(c) volume sizing replaces behavioral runoff: the targets are hit every month", () => {
  it("a flat deposit target and a growing mortgage target, both behavioral, to a relative 1e-9", () => {
    const pf = book([
      mortgagePosition("M1", { notional: 1_000_000, originalBalance: 1_000_000, ageMonths: 24, maturityMonths: 336, originalTermMonths: 360, noteRate: 0.06 }),
      nmdBetaPosition("B1", { notional: 2_000_000 }),
    ]);
    const set: AssumptionSet = { ...depositSet, bindings: [...depositSet.bindings, ...mortgageSet.bindings] };
    const g = 0.004;
    const rules = [
      { familyId: "MORTGAGE", reinvest: "growth" as const, monthlyGrowthRate: g, termMonths: 360, spreadOverIndexBp: 25, template: { ...MORTGAGE_TPL, fixedIndex: "swap" as const, indexTenorMonths: 360 } },
      { familyId: "MMA", reinvest: "flat" as const, termMonths: 360, spreadOverIndexBp: 0, template: DEPOSIT_TPL },
    ];
    const dyn = projectDynamicScenario(pf, { scenario: scenario(rules), ratePath: stubPath(), assumptions: set }, { horizonMonths: H, asOf: AS_OF });
    const series = (id: string) => dyn.cashflows.byFamily.find((f) => f.familyId === id)!.series;
    const mort = series("MORTGAGE");
    const mma = series("MMA");
    let worstM = 0;
    let worstD = 0;
    for (let k = 1; k < H; k++) {
      worstM = Math.max(worstM, Math.abs(mort.balance[k]! - 1_000_000 * Math.pow(1 + g, k)) / (1_000_000 * Math.pow(1 + g, k)));
      worstD = Math.max(worstD, Math.abs(mma.balance[k]! - 2_000_000) / 2_000_000);
    }
    expect(worstM).toBeLessThan(1e-9);
    expect(worstD).toBeLessThan(1e-9);
    expect(dyn.shortfalls).toHaveLength(0);
    // The runoff the behavior creates is replaced: the deposit family makes new volume in every month, and more of it
    // than a contractual bullet book would (whose runoff is zero until maturity).
    const made = dyn.originations.find((o) => o.familyId === "MMA")!.originations;
    expect(made.slice(1).every((x) => x > 0)).toBe(true);
  });

  it("(fix round L4) under parallel shocks of +200 and -200 bp, flat and 0.6% a month growth, still to a relative 1e-9", () => {
    const pf = book([
      mortgagePosition("M1", { notional: 1_000_000, originalBalance: 1_000_000, ageMonths: 24, maturityMonths: 336, originalTermMonths: 360, noteRate: 0.06 }),
      nmdBetaPosition("B1", { notional: 2_000_000 }),
    ]);
    const set: AssumptionSet = { ...depositSet, bindings: [...depositSet.bindings, ...mortgageSet.bindings] };
    const shifted = (bp: number): RatePath => ({ nSteps: 800, times: Array.from({ length: 801 }, (_, i) => i / 12), rateAt: (s) => r1(s) + bp / 1e4, forwardRateAt: (s, T) => fwd(s, T) + bp / 1e4 });
    const made: number[][] = [];
    for (const bp of [200, -200]) {
      for (const g of [0, 0.006]) {
        const rules = [
          { familyId: "MORTGAGE", reinvest: g === 0 ? ("flat" as const) : ("growth" as const), ...(g === 0 ? {} : { monthlyGrowthRate: g }), termMonths: 360, spreadOverIndexBp: 25, template: { ...MORTGAGE_TPL, indexTenorMonths: 360 } },
          { familyId: "MMA", reinvest: g === 0 ? ("flat" as const) : ("growth" as const), ...(g === 0 ? {} : { monthlyGrowthRate: g }), termMonths: 360, spreadOverIndexBp: 0, template: DEPOSIT_TPL },
        ];
        const dyn = projectDynamicScenario(pf, { scenario: scenario(rules), ratePath: shifted(bp), assumptions: set }, { horizonMonths: H, asOf: AS_OF });
        for (const [id, b0] of [["MORTGAGE", 1_000_000], ["MMA", 2_000_000]] as const) {
          const bal = dyn.cashflows.byFamily.find((f) => f.familyId === id)!.series.balance;
          let worst = 0;
          for (let k = 1; k < H; k++) worst = Math.max(worst, Math.abs(bal[k]! - b0 * Math.pow(1 + g, k)) / (b0 * Math.pow(1 + g, k)));
          expect(worst).toBeLessThan(1e-9);
        }
        expect(dyn.shortfalls).toHaveLength(0);
        made.push(dyn.originations.find((o) => o.familyId === "MMA")!.originations);
      }
    }
    // The shock moves the volume made (the decay reads the rate), so the sizing is not a fixed schedule.
    expect(made[0]!.slice(1, 24).some((x, i) => Math.abs(x - made[2]![i + 1]!) > 1e-6)).toBe(true);
  });
});
