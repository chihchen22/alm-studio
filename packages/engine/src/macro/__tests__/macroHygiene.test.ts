// packages/engine/src/macro/__tests__/macroHygiene.test.ts
/**
 * Piece 7b follow-up (mfu-1): the macro module's hygiene items from the final
 * review. An unreadable as-of month is a named refusal, never a TypeError; the
 * HousingMortgage constructor refuses a path it cannot read; a path's targets
 * are frozen without freezing the caller's set; a stage refusal names its stage
 * in its own field; the wire form carries no constant flag. Texts restated by hand.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MBS_DEFAULTS, MORTGAGE_DEFAULTS, type MarketSnapshot } from "@alm/kernel";
import { loadMarket } from "../../run/__tests__/fixtures";
import { HousingMortgage } from "../housingMortgage";
import { asOfMonthOf, validateMacroFactors } from "../macroFactors";
import { MacroRefusedError, MacroUnresolvedError, requireRunMacro, resolveRunMacro, toWire } from "../runMacro";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const SEL = { coupon: ["high"] };
const ff = (selector?: object) => ({ familyId: "mbs", modelVersion: "v", ...(selector === undefined ? {} : { selector }),
  overlay: { kind: "prepay" as const, model: "four-factor-cpr" as const, params: MBS_DEFAULTS, housing: H } });
const mappedSet = (selector?: object) => ({ schemaVersion: "1.0.0", id: "a", label: "a", bindings: [ff(selector)],
  macroBindings: [{ seriesId: "hpi-down-30", feeder: "prepay-housing" as const, familyId: "mbs", ...(selector === undefined ? {} : { selector }) }] });
const proj = (id: string, n: number) => ({ id, label: id, kind: "index", role: "projection", unit: "r", firstMonth: "2026-04", values: new Array(n).fill(0.7), source: { authored: true, note: "n" } });
const req = (set: object) => ({ assumptionSets: [set], scenarios: [{ id: "S0", rateSpec: { kind: "base" }, assumptionSetId: "a" }], grid: { horizonMonths: 360 } }) as never;
let market: MarketSnapshot & { macroFactors?: unknown };
beforeAll(async () => { market = { ...(await loadMarket()), macroFactors: [proj("hpi-down-30", 360)] }; });

describe("as-of month (Slice 1 M3 and M4)", () => {
  it("asOfMonthOf reads YYYY-MM from a readable calibrationDate and null otherwise", () => {
    expect(asOfMonthOf({ calibrationDate: "2026-03-31" })).toBe("2026-03");
    expect(asOfMonthOf({})).toBeNull();
    expect(asOfMonthOf({ calibrationDate: 20260331 })).toBeNull();
    expect(asOfMonthOf({ calibrationDate: "2026-13-01" })).toBeNull();
  });
  it("the validator refuses an unreadable as-of month with one problem, not one per series", () => {
    expect(validateMacroFactors([proj("hpi-flat", 360), proj("hpi-up-15", 360)], "")).toEqual([
      { at: "macroFactors", message: 'macroFactors: the market\'s as-of month is not a month YYYY-MM (got ""), so no series can be checked against it' },
    ]);
  });
  it("a mapped run on a market with no readable calibrationDate is a named refusal", () => {
    const { calibrationDate: _c, ...bare } = market;
    let e: unknown = null;
    try { resolveRunMacro(req(mappedSet()), bare as never, "m-1"); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(MacroRefusedError);
    expect((e as Error).message).toBe('run refused: market "m-1" carries no readable calibrationDate, so its macroFactors block has no as-of month to be checked against');
  });
});

describe("HousingMortgage refuses a path it cannot read (Slice 2 M3)", () => {
  const TEXT = "HousingMortgage: the house-price index path must be a non-empty list of finite numbers";
  it("empty", () => { expect(() => new HousingMortgage(MORTGAGE_DEFAULTS, H, [])).toThrow(TEXT); });
  it("non-finite", () => {
    expect(() => new HousingMortgage(MORTGAGE_DEFAULTS, H, [1, Number.NaN])).toThrow(TEXT);
    expect(() => new HousingMortgage(MORTGAGE_DEFAULTS, H, [1, Number.POSITIVE_INFINITY])).toThrow(TEXT);
  });
  it("a finite path still builds", () => { expect(new HousingMortgage(MORTGAGE_DEFAULTS, H, [1, 0.9]).terms.id).toBe("mortgage-1"); });
});

describe("a path's targets are frozen (Slice 3 M7)", () => {
  it("each target and its selector are frozen, and the caller's set is not", () => {
    const set = mappedSet(SEL);
    const m = resolveRunMacro(req(set), market);
    if (m.kind !== "path") throw new Error("expected a path");
    expect(m.families).toEqual([{ familyId: "mbs", selector: { coupon: ["high"] } }]);
    expect(Object.isFrozen(m.families)).toBe(true);
    expect(Object.isFrozen(m.families[0])).toBe(true);
    expect(Object.isFrozen(m.families[0]!.selector)).toBe(true);
    expect(Object.isFrozen((m.families[0]!.selector as { coupon: string[] }).coupon)).toBe(true);
    expect(Object.isFrozen(set.macroBindings[0]!.selector)).toBe(false);
  });
  it("the wire form carries kind, series, path and families only (no constant horizon flag)", () => {
    const m = resolveRunMacro(req(mappedSet()), market);
    expect(Object.keys(toWire(m))).toEqual(["kind", "seriesId", "housePriceIndexPath", "families"]);
  });
});

describe("requireRunMacro names the stage in its own field (Slice 3 fix-round Minor)", () => {
  it("stage carries the stage text; terms carries no stage", () => {
    let e: unknown = null;
    try { requireRunMacro(undefined, 'behavioral stage "b1"'); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(MacroUnresolvedError);
    const u = e as MacroUnresolvedError;
    expect(u.stage).toBe('behavioral stage "b1"');
    expect(u.terms).toBeUndefined();
    expect(u.message).toBe('behavioral stage "b1": the run\'s macro value was not threaded to this stage; a stage never substitutes NO_MACRO, so a mapped family cannot fall back to the kernel schedule');
  });
  it("forStage builds the stage form: same class, name, fields and message as the stage overload", () => {
    const u = MacroUnresolvedError.forStage('behavioral stage "b1"');
    expect(u).toBeInstanceOf(MacroUnresolvedError);
    expect(u).toBeInstanceOf(Error);
    expect(u.name).toBe("MacroUnresolvedError");
    expect([u.terms, u.stage]).toEqual([undefined, 'behavioral stage "b1"']);
    expect(u.message).toBe('behavioral stage "b1": the run\'s macro value was not threaded to this stage; a stage never substitutes NO_MACRO, so a mapped family cannot fall back to the kernel schedule');
    expect(u.message).toBe(new MacroUnresolvedError(undefined, undefined, 'behavioral stage "b1"').message);
  });
  it("the factory form keeps the terms id and has no stage", () => {
    const u = new MacroUnresolvedError("mortgage-1", "this call was not given the run's macro path");
    expect([u.terms, u.stage]).toEqual(["mortgage-1", undefined]);
  });
});
