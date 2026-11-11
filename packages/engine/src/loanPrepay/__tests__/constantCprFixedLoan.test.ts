/**
 * The constant-CPR fixed loan, its stress speed, the overlay that writes it, the two gates
 * that admit it, and the constant-balance walk whose vintages inherit the parent's CPR.
 *
 * Expected numbers are restated by hand from the formulas in the module header, never read back from the module
 * under test.
 */
import { describe, expect, it } from "vitest";
import {
  FIXED_LOAN_DEFAULTS,
  FixedLoan,
  MBS_DEFAULTS,
  ShockedPath,
  runStaticBalanceScenario,
  type FixedLoanTerms,
  type RatePath,
} from "@alm/kernel";
import type { AssumptionSet, BehavioralOverlay } from "../../contracts/assumptions";
import type { ProductFamilyDef } from "../../contracts/chartOfAccounts";
import { OVERLAY_INSTRUMENT_COMPATIBILITY, overlayInstrumentTypes } from "../../contracts/overlayCompatibility";
import { checkOverlayParams } from "../../contracts/paramSchema";
import { StaticOverlayError, applyOverlayToTerms } from "../../projection/static/applyOverlays";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { IncompatibleOverlayError, OverlayParamError, resolveAssumptions } from "../../scenario/resolveAssumptions";
import { ConstantCprFixedLoan, runStaticBalance, vintageOf, type PrepayingFixedLoanTerms } from "..";

const M = 1_000_000;

/** A flat 4 percent path: the fixed loan never reads it, the vintages read its forwards. */
const FLAT: RatePath = {
  nSteps: 400,
  times: Array.from({ length: 400 }, (_, i) => i / 12),
  rateAt: () => 0.04,
  forwardRateAt: () => 0.04,
};

const AUTO: FixedLoanTerms = { ...FIXED_LOAN_DEFAULTS, id: "auto", label: "auto", notional: 1_200 * M, maturityMonths: 60, coupon: 0.0542 };
const withCpr = (annualCpr: number, stressAnnualCpr?: number): PrepayingFixedLoanTerms => ({
  ...AUTO,
  prepay: { annualCpr, ...(stressAnnualCpr !== undefined ? { stressAnnualCpr } : {}) },
});

describe("ConstantCprFixedLoan cash flows", () => {
  it("month 1 is the level-pay schedule plus SMM on the balance left after scheduled principal", () => {
    const cf = new ConstantCprFixedLoan(withCpr(0.161)).generateCashflows(FLAT);
    const c = 0.0542 / 12;
    const b0 = 1_200 * M;
    const sched = b0 * (c / (Math.pow(1 + c, 60) - 1));
    const smm = 1 - Math.pow(1 - 0.161, 1 / 12);
    expect(cf[0]!.monthOffset).toBe(1);
    expect(cf[0]!.balance).toBe(b0);
    expect(cf[0]!.interestPaid).toBeCloseTo(b0 * c, 6);
    expect(cf[0]!.principalPaid).toBeCloseTo(sched + smm * (b0 - sched), 6);
    // Month 2 re-amortises the surviving balance on the 59 months left.
    const b1 = b0 - cf[0]!.principalPaid;
    const sched2 = b1 * (c / (Math.pow(1 + c, 59) - 1));
    expect(cf[1]!.principalPaid).toBeCloseTo(sched2 + smm * (b1 - sched2), 6);
  });

  it("pays the whole notional by maturity, and at CPR 0 is the kernel FixedLoan schedule to 1e-9 relative", () => {
    const fast = new ConstantCprFixedLoan(withCpr(0.2)).generateCashflows(FLAT);
    expect(fast.reduce((s, x) => s + x.principalPaid, 0)).toBeCloseTo(1_200 * M, 3);
    const zero = new ConstantCprFixedLoan(withCpr(0)).generateCashflows(FLAT);
    const kernel = new FixedLoan(AUTO).generateCashflows(FLAT);
    expect(zero).toHaveLength(kernel.length);
    for (let i = 0; i < kernel.length; i++) {
      expect(Math.abs(zero[i]!.principalPaid - kernel[i]!.principalPaid)).toBeLessThan(1e-9 * 1_200 * M);
      expect(Math.abs(zero[i]!.interestPaid - kernel[i]!.interestPaid)).toBeLessThan(1e-9 * 1_200 * M);
    }
  });

  it("ignores the rate path: a constant CPR is not moved by any scenario", () => {
    const loan = new ConstantCprFixedLoan(withCpr(0.161));
    const up = new ShockedPath(FLAT, 200);
    expect(loan.generateCashflows(up)).toEqual(loan.generateCashflows(FLAT));
  });

  it("refuses a bullet: a constant CPR applies to a level-pay loan only", () => {
    expect(() => new ConstantCprFixedLoan({ ...withCpr(0.1), amortType: "bullet" })).toThrow(/level-pay loan only/);
  });

  it("atStress runs at the stress speed, or at its own speed when the terms name none", () => {
    const stressed = new ConstantCprFixedLoan(withCpr(0.161, 0.145)).atStress();
    expect(stressed.annualCpr).toBe(0.145);
    expect(stressed.generateCashflows(FLAT)).toEqual(new ConstantCprFixedLoan(withCpr(0.145)).generateCashflows(FLAT));
    expect(new ConstantCprFixedLoan(withCpr(0.2, 0)).atStress().generateCashflows(FLAT)[0]!.principalPaid).toBeCloseTo(
      new FixedLoan(AUTO).generateCashflows(FLAT)[0]!.principalPaid,
      3,
    );
    expect(new ConstantCprFixedLoan(withCpr(0.2)).atStress().annualCpr).toBe(0.2);
  });
});

describe("the factory and the overlay", () => {
  it("builds ConstantCprFixedLoan for terms with a prepay group and the kernel FixedLoan otherwise", () => {
    expect(makeInstrument(withCpr(0.1))).toBeInstanceOf(ConstantCprFixedLoan);
    const plain = makeInstrument(AUTO);
    expect(plain).toBeInstanceOf(FixedLoan);
    expect(plain).not.toBeInstanceOf(ConstantCprFixedLoan);
  });

  it("a constant-cpr overlay writes the prepay group, the stress speed only when the overlay names one", () => {
    const one: BehavioralOverlay = { kind: "prepay", model: "constant-cpr", annualCpr: 0.161, stressAnnualCpr: 0.145 };
    expect(applyOverlayToTerms(AUTO, one, "auto")).toEqual({ ...AUTO, prepay: { annualCpr: 0.161, stressAnnualCpr: 0.145 } });
    const two: BehavioralOverlay = { kind: "prepay", model: "constant-cpr", annualCpr: 0.2 };
    expect(applyOverlayToTerms(AUTO, two, "auto")).toEqual({ ...AUTO, prepay: { annualCpr: 0.2 } });
    expect(() => applyOverlayToTerms({ ...AUTO, amortType: "bullet" }, two, "bills")).toThrow(StaticOverlayError);
    const four: BehavioralOverlay = { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS };
    expect(() => applyOverlayToTerms(AUTO, four, "auto")).toThrow(StaticOverlayError);
  });
});

describe("the compatibility and parameter gates", () => {
  const FAMILIES: ProductFamilyDef[] = [{ id: "auto", label: "Auto", side: "asset", instrumentType: "fixed-loan", coaNodeId: "n-auto" }];
  const set = (overlay: BehavioralOverlay): AssumptionSet => ({
    schemaVersion: "1.0.0",
    id: "as-b1",
    label: "b1",
    bindings: [{ familyId: "auto", overlay, modelVersion: "v1" }],
  });

  it("widens the prepay row for constant-cpr only; the kind-level table is unchanged", () => {
    expect(OVERLAY_INSTRUMENT_COMPATIBILITY.prepay).toEqual(["mortgage"]);
    expect(overlayInstrumentTypes("prepay", "constant-cpr")).toEqual(["mortgage", "fixed-loan"]);
    expect(overlayInstrumentTypes("prepay", "four-factor-cpr")).toEqual(["mortgage"]);
    expect(overlayInstrumentTypes("nmd-decay")).toEqual(["nmd", "nmd-b"]);
  });

  it("resolves a constant CPR on a fixed-loan family and still refuses the four-factor CPR there", () => {
    expect(() => resolveAssumptions(set({ kind: "prepay", model: "constant-cpr", annualCpr: 0.161, stressAnnualCpr: 0.145 }), FAMILIES)).not.toThrow();
    expect(() => resolveAssumptions(set({ kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS }), FAMILIES)).toThrow(IncompatibleOverlayError);
  });

  it("refuses a stress speed outside [0, 1] at both gates", () => {
    const bad: BehavioralOverlay = { kind: "prepay", model: "constant-cpr", annualCpr: 0.161, stressAnnualCpr: 1.4 };
    expect(() => resolveAssumptions(set(bad), FAMILIES)).toThrow(OverlayParamError);
    expect(checkOverlayParams(bad).map((i) => i.path)).toEqual(["stressAnnualCpr"]);
    expect(checkOverlayParams({ kind: "prepay", model: "constant-cpr", annualCpr: 0.161 })).toEqual([]);
  });
});

describe("the constant-balance walk", () => {
  const up = new ShockedPath(FLAT, 10);

  it("hands any other instrument to the kernel walk unchanged", () => {
    const plain = new FixedLoan(AUTO);
    expect(runStaticBalance(plain, up, up, FLAT, 61)).toEqual(runStaticBalanceScenario(plain, up, up, FLAT, 61));
  });

  it("rebuilds a prepaying loan's vintages at the parent's CPR, so the balance stays at notional", () => {
    const loan = new ConstantCprFixedLoan(withCpr(0.2, 0));
    const run = runStaticBalance(loan, up, up, FLAT, 24);
    for (const b of run.totalBalance) expect(b).toBeCloseTo(1_200 * M, 0);
    const kernelVintage = new FixedLoan({ ...withCpr(0.2, 0), notional: 1 * M, maturityMonths: 23 });
    const rebuilt = vintageOf(loan, kernelVintage);
    expect(rebuilt).toBeInstanceOf(ConstantCprFixedLoan);
    expect((rebuilt as ConstantCprFixedLoan).terms.prepay).toEqual({ annualCpr: 0.2, stressAnnualCpr: 0 });
    // A vintage that prepays returns more principal in month 1 of its life than the kernel's plain vintage.
    expect(run.vintages[0]!.cashflows[0]!.principalPaid).toBeGreaterThan(
      runStaticBalanceScenario(loan, up, up, FLAT, 24).vintages[0]!.cashflows[0]!.principalPaid,
    );
    expect(vintageOf(new FixedLoan(AUTO), kernelVintage)).toBe(kernelVintage);
  });
});
