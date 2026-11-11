// packages/engine/src/macro/__tests__/resolveRunMacro.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { MBS_DEFAULTS, type MarketSnapshot } from "@alm/kernel";
import { loadMarket } from "../../run/__tests__/fixtures";
import { MacroRefusedError, NO_MACRO, isRunMacro, resolveRunMacro, runMacroFromWire, toWire } from "../runMacro";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const MB = [{ seriesId: "hpi-down-30", feeder: "prepay-housing" as const, familyId: "mbs" }];
const ff = (housing: boolean) => ({ familyId: "mbs", modelVersion: "v", overlay: { kind: "prepay" as const, model: "four-factor-cpr" as const, params: MBS_DEFAULTS, ...(housing ? { housing: H } : {}) } });
const setOf = (id: string, mapped: boolean, housing = true) => ({ schemaVersion: "1.0.0", id, label: id, bindings: [ff(housing)], ...(mapped ? { macroBindings: MB } : {}) });
const sc = (id: string, setId: string, base = false) => ({ id, rateSpec: base ? { kind: "base" as const } : { kind: "parallel" as const, shockBp: 100 }, assumptionSetId: setId });
const proj = (id: string, n: number, v = 0.7) => ({ id, label: id, kind: "index", role: "projection", unit: "r", firstMonth: "2026-04", values: new Array(n).fill(v), source: { authored: true, note: "n" } });
let market: MarketSnapshot & { macroFactors?: unknown };
beforeAll(async () => { const m = await loadMarket(); market = { ...m, macroFactors: [proj("hpi-down-30", 360), proj("short", 12)] }; });
const req = (sets: object[], scenarios: object[], horizonMonths = 360) => ({ assumptionSets: sets, scenarios, grid: { horizonMonths } }) as never;
const fail = (f: () => unknown) => { try { f(); return null; } catch (e) { return e as MacroRefusedError; } };

describe("resolveRunMacro (R6)", () => {
  it("unmapped base: NO_MACRO itself, block unread", () => {
    expect(resolveRunMacro(req([setOf("a", false)], [sc("S0", "a", true)]), { ...market, macroFactors: "junk" } as never)).toBe(NO_MACRO);
  });
  it("mapped base: a branded path of the projection, families listed", () => {
    const m = resolveRunMacro(req([setOf("a", true)], [sc("S0", "a", true)]), market);
    expect(isRunMacro(m)).toBe(true);
    expect(m.kind === "path" && [m.seriesId, m.housePriceIndexPath.length, m.housePriceIndexPath[0], m.families]).toEqual(["hpi-down-30", 360, 0.7, [{ familyId: "mbs" }]]);
  });
  it("a scenario set with no mapping inherits; one with a different mapping is refused naming both sets", () => {
    expect(resolveRunMacro(req([setOf("a", true), setOf("b", false)], [sc("S0", "a", true), sc("S100", "b")]), market).kind).toBe("path");
    const e = fail(() => resolveRunMacro(req([setOf("a", false), setOf("b", true)], [sc("S0", "a", true), sc("S100", "b")]), market));
    expect(e).toBeInstanceOf(MacroRefusedError);
    expect(e!.message).toBe(`run refused: scenario "S100" uses set "b", whose macroBindings differ from the base set "a"'s; every scenario in a run shares the base's macro path`);
  });
  it("an inheriting set without the housing group is refused", () => {
    expect(fail(() => resolveRunMacro(req([setOf("a", true), setOf("b", false, false)], [sc("S0", "a", true), sc("S100", "b")]), market))!.message)
      .toBe(`run refused: scenario set "b" inherits the mapping of "a", but its four-factor prepay binding for family "mbs" carries no housing group`);
  });
  it("short projection and missing series", () => {
    const short = { ...setOf("a", true), macroBindings: [{ ...MB[0], seriesId: "short" }] };
    expect(fail(() => resolveRunMacro(req([short], [sc("S0", "a", true)]), market))!.message).toBe('run refused: projection "short" has 12 months and the run horizon is 360');
    const missing = { ...setOf("a", true), macroBindings: [{ ...MB[0], seriesId: "nope" }] };
    expect(fail(() => resolveRunMacro(req([missing], [sc("S0", "a", true)]), market, "macro-demo-v1"))!.message).toBe('run refused: set "a" maps series "nope", which market "macro-demo-v1" does not carry (it carries hpi-down-30, short)');
  });
  it("wrong kind or role: a rate projection and an index history are refused naming the series", () => {
    // Two valid series of the wrong shape, on a market of their own so the carried-ids text above is unchanged.
    const rate = { ...proj("rate-up", 360, 0.03), kind: "rate" };
    const hist = { id: "hpi-hist", label: "h", kind: "index", role: "history", unit: "r", firstMonth: "2026-01", values: [1, 1, 1],
      source: { seriesId: "X", provider: "p", url: "u", retrievedOn: "2026-10-08", vintage: "v", endMonth: "2026-03", rawFileSha256: "0".repeat(64), knownGaps: [] } };
    const m = { ...market, macroFactors: [...(market.macroFactors as object[]), rate, hist] } as never;
    const mapTo = (seriesId: string) => ({ ...setOf("a", true), macroBindings: [{ ...MB[0], seriesId }] });
    // Power: the shape is the only defect; the same market resolves the index projection to a path.
    expect(resolveRunMacro(req([setOf("a", true)], [sc("S0", "a", true)]), m).kind).toBe("path");
    const r = fail(() => resolveRunMacro(req([mapTo("rate-up")], [sc("S0", "a", true)]), m));
    expect(r).toBeInstanceOf(MacroRefusedError);
    expect(r!.message).toBe('run refused: series "rate-up" is a rate projection; the house-price response reads an index projection');
    expect(r!.ids).toEqual({ seriesId: "rate-up" });
    const h = fail(() => resolveRunMacro(req([mapTo("hpi-hist")], [sc("S0", "a", true)]), m));
    expect(h).toBeInstanceOf(MacroRefusedError);
    // Re-expectation (mfu-3): the article follows the kind ("an index", "a rate").
    expect(h!.message).toBe('run refused: series "hpi-hist" is an index history; the house-price response reads an index projection');
  });
  it("wire round trip restores the brand and NO_MACRO identity", () => {
    const m = resolveRunMacro(req([setOf("a", true)], [sc("S0", "a", true)]), market);
    const back = runMacroFromWire(structuredClone(toWire(m)));
    expect(isRunMacro(back)).toBe(true);
    expect(toWire(back)).toEqual(toWire(m));
    expect(runMacroFromWire(structuredClone(toWire(NO_MACRO)))).toBe(NO_MACRO);
  });
});
