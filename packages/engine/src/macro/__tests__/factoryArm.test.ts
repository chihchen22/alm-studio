// packages/engine/src/macro/__tests__/factoryArm.test.ts
/**
 * The mortgage arm of makeInstrument and its guard (spec
 * v4 Section 6): absent housing builds the kernel Mortgage; housing with no
 * resolved macro value throws; NO_MACRO builds the kernel Mortgage. The path
 * arm is covered in slice 3, where resolveRunMacro mints a path.
 */
import { describe, expect, it } from "vitest";
import { MORTGAGE_DEFAULTS, Mortgage } from "@alm/kernel";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { HousingMortgage } from "../housingMortgage";
import { MacroUnresolvedError, NO_MACRO, isRunMacro } from "../runMacro";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const housed = { ...MORTGAGE_DEFAULTS, housing: H };

describe("mortgage arm", () => {
  it("no housing, no options: the kernel Mortgage", () => {
    expect(makeInstrument(MORTGAGE_DEFAULTS)).toBeInstanceOf(Mortgage);
  });
  it("no housing: an unbranded value is never read (Slice 2 M1)", () => {
    // A value that throws on any inspection: the arm must not touch it when the terms carry no housing.
    const no = (): never => { throw new Error("trap: the macro value was read"); };
    const trap = new Proxy({}, { get: no, has: no, ownKeys: no, getOwnPropertyDescriptor: no, getPrototypeOf: no }) as never;
    for (const macro of [{} as never, structuredClone(NO_MACRO), trap]) expect(makeInstrument(MORTGAGE_DEFAULTS, { macro })).toBeInstanceOf(Mortgage);
    // Power: the same three values are read, and refused, once the terms carry housing.
    expect(() => makeInstrument(housed, { macro: {} as never })).toThrow(MacroUnresolvedError);
    expect(() => makeInstrument(housed, { macro: structuredClone(NO_MACRO) })).toThrow(MacroUnresolvedError);
    expect(() => makeInstrument(housed, { macro: trap })).toThrow("trap: the macro value was read");
  });
  it("housing and no macro: MacroUnresolvedError", () => {
    expect(() => makeInstrument(housed)).toThrow(MacroUnresolvedError);
    expect(() => makeInstrument(housed)).toThrow('makeInstrument: mortgage "mortgage-1" carries a house-price response and this call was not given the run\'s macro path; a mapped family never falls back to the kernel schedule');
  });
  it("housing with NO_MACRO: the kernel Mortgage", () => {
    expect(makeInstrument(housed, { macro: NO_MACRO })).toBeInstanceOf(Mortgage);
  });
  it("a cloned NO_MACRO loses the brand and is refused", () => {
    const clone = structuredClone(NO_MACRO);
    expect(isRunMacro(clone)).toBe(false);
    expect(() => makeInstrument(housed, { macro: clone })).toThrow(MacroUnresolvedError);
  });
  it("NO_MACRO is frozen", () => { expect(Object.isFrozen(NO_MACRO)).toBe(true); });
  it("HousingMortgage keeps the kernel constructor checks", () => {
    expect(() => new HousingMortgage({ ...MORTGAGE_DEFAULTS, notional: 0 }, H, [1])).toThrow("Mortgage: notional must be positive");
  });
});
