import { describe, it, expect } from "vitest";
import {
  FIXED_LOAN_DEFAULTS,
  FLOATING_LOAN_DEFAULTS,
  MORTGAGE_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  NMD_B_TERMS_DEFAULTS,
  FixedLoan,
  FloatingLoan,
  Mortgage,
  NMDeposit,
  NMDBeta,
} from "@alm/kernel";
import type { PositionTerms } from "../../contracts/position";
import { makeInstrument } from "../instrumentFactory";
import { ConstantRatePath } from "./stubRatePath";

const path = new ConstantRatePath(0.04, 360);

describe("makeInstrument", () => {
  const cases: Array<{ label: string; terms: PositionTerms; ctor: unknown }> = [
    { label: "fixed-loan", terms: FIXED_LOAN_DEFAULTS, ctor: FixedLoan },
    { label: "floating-loan", terms: FLOATING_LOAN_DEFAULTS, ctor: FloatingLoan },
    { label: "mortgage", terms: MORTGAGE_DEFAULTS, ctor: Mortgage },
    { label: "nmd", terms: NMD_TERMS_DEFAULTS, ctor: NMDeposit },
    { label: "nmd-b", terms: NMD_B_TERMS_DEFAULTS, ctor: NMDBeta },
  ];

  for (const { label, terms, ctor } of cases) {
    it(`dispatches ${label} to its kernel instrument and generates cashflows`, () => {
      const inst = makeInstrument(terms);
      expect(inst).toBeInstanceOf(ctor as new (...a: unknown[]) => unknown);
      const cf = inst.generateCashflows(path);
      expect(Array.isArray(cf)).toBe(true);
      expect(cf.length).toBeGreaterThan(0);
      // Every leg is a real number, never NaN.
      for (const leg of cf) {
        expect(Number.isFinite(leg.balance)).toBe(true);
        expect(Number.isFinite(leg.principalPaid)).toBe(true);
        expect(Number.isFinite(leg.interestPaid)).toBe(true);
      }
    });
  }

  it("throws on an unknown terms.type and never returns a number", () => {
    const bogus = { ...FIXED_LOAN_DEFAULTS, type: "swaption" } as unknown as PositionTerms;
    let returned: unknown;
    expect(() => {
      returned = makeInstrument(bogus);
    }).toThrow(/unknown/i);
    expect(returned).toBeUndefined();
  });
});
