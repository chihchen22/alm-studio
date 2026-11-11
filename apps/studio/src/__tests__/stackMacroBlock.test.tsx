/**
 * ALM Studio Piece 7b follow-up (mfu2-a): the Stacks page holds Save off when the composed stack maps a family and
 * no four-factor prepay binding for that family and selector carries a housing group, as Edit a set does (mfu-3).
 * The stacks are composed through the real flattenStack and the engine rule is run on the payload the page would
 * save. Server render and pure functions only; every expected string is restated by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet, DimensionPredicate, MacroBinding, OverlayBinding } from "@alm/engine";
import { flattenStack } from "@alm/reader";
import { checkMacroBindings } from "@alm/engine/src/scenario/macroBindings";
import { stackMappedGap } from "../assumptions/stackModel";
import { SaveBar } from "../pages/assumptions/AssumptionsViews";

const PREPAY = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const HOUSING = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const MB: MacroBinding[] = [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }];
const MB_RETAIL: MacroBinding[] = [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs", selector: { tier: "retail" } }];
const NO_GROUP = "Off: the stack maps a series to mbs, whose four-factor prepay binding carries no housing group, and the engine refuses that at save";
const NO_MODEL = "Off: the stack maps a series to mbs, which has no four-factor prepay binding, and the engine refuses that at save";
const SERVER = 'maps family "mbs" to the house-price response, but its four-factor prepay binding carries no housing group';

const four = (familyId: string, withHousing: boolean, selector?: DimensionPredicate, wac = 6.5): OverlayBinding => ({
  familyId,
  overlay: { kind: "prepay", model: "four-factor-cpr", params: { ...PREPAY, wac }, ...(withHousing ? { housing: HOUSING } : {}) } as never,
  modelVersion: "kernel-four-factor-cpr-1",
  ...(selector ? { selector } : {}),
});
const constant = (familyId: string, selector?: DimensionPredicate): OverlayBinding => ({
  familyId, overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 8 }, modelVersion: "constant-1", ...(selector ? { selector } : {}),
});
const set = (id: string, bindings: OverlayBinding[], macroBindings?: MacroBinding[]): AssumptionSet => ({
  schemaVersion: "1.0.0", id, label: id, bindings, ...(macroBindings !== undefined ? { macroBindings } : {}),
});

/** Base: mbs (whole family) and mortgages carry the group; mapped on mbs only. */
const BAU = set("bau", [four("mbs", true), four("mortgages", true)], MB);
const stack = async (base: AssumptionSet, ...layers: AssumptionSet[]) => (await flattenStack(base, layers)).set;

describe("stackMappedGap: the composed stack's mapping against its four-factor prepay bindings", () => {
  it("a layer swaps the mapped family to constant-cpr: blocked, naming the family; the engine refuses the same payload", async () => {
    const s = await stack(BAU, set("flat", [constant("mbs")]));
    expect(stackMappedGap(s)).toBe(NO_MODEL);
    expect(() => checkMacroBindings(s)).toThrow(SERVER);
  });
  it("a layer replaces the mapped family's four-factor binding with one that has no housing group: blocked; the engine refuses", async () => {
    const s = await stack(BAU, set("nogroup", [four("mbs", false)]));
    expect(stackMappedGap(s)).toBe(NO_GROUP);
    expect(() => checkMacroBindings(s)).toThrow(SERVER);
  });
  it("power: a layer that replaces the binding with another four-factor binding that keeps the group is not blocked; the engine accepts", async () => {
    const s = await stack(BAU, set("rewac", [four("mbs", true, undefined, 7)]));
    expect(stackMappedGap(s)).toBeNull();
    expect(() => checkMacroBindings(s)).not.toThrow();
  });
  it("power: the unlayered base, and a layer that touches only an unmapped family, are not blocked", async () => {
    const unlayered = await stack(BAU);
    expect(stackMappedGap(unlayered)).toBeNull();
    expect(() => checkMacroBindings(unlayered)).not.toThrow();
    const other = await stack(BAU, set("flat-mort", [constant("mortgages"), four("mbs", true)]));
    expect(stackMappedGap(other)).toBeNull();
    expect(() => checkMacroBindings(other)).not.toThrow();
  });
  it("power: a stack with no mapping is never blocked, even when a layer swaps a family to constant-cpr", async () => {
    const s = await stack(set("plain", [four("mbs", true)]), set("flat", [constant("mbs")]));
    expect(s.macroBindings).toBeUndefined();
    expect(stackMappedGap(s)).toBeNull();
    expect(() => checkMacroBindings(s)).not.toThrow();
  });
  it("a mapping that comes from a layer is read too: the base binding lacks the group", async () => {
    const s = await stack(set("plain", [four("mbs", false)]), set("maps", [], MB));
    expect(s.macroBindings).toEqual(MB);
    expect(stackMappedGap(s)).toBe(NO_GROUP);
    expect(() => checkMacroBindings(s)).toThrow(SERVER);
  });
  it("selector: the key is family and selector, so dropping the group on the whole-family binding leaves a retail mapping alone, and dropping it on retail blocks", async () => {
    const base = set("sel", [four("mbs", true, { tier: "retail" }), four("mbs", true)], MB_RETAIL);
    const whole = await stack(base, set("whole-off", [four("mbs", false)]));
    expect(stackMappedGap(whole)).toBeNull();
    expect(() => checkMacroBindings(whole)).not.toThrow();
    const retail = await stack(base, set("retail-off", [four("mbs", false, { tier: "retail" })]));
    expect(stackMappedGap(retail)).toBe(NO_GROUP);
    expect(() => checkMacroBindings(retail)).toThrow(SERVER);
    const swapped = await stack(base, set("retail-const", [constant("mbs", { tier: "retail" })]));
    expect(stackMappedGap(swapped)).toBe(NO_MODEL);
    expect(() => checkMacroBindings(swapped)).toThrow(SERVER);
  });
  it("the engine's target identity, not the looser diffKey: a scalar selector is not a one-element list, so the stack is blocked exactly when the engine refuses", () => {
    const mapped = (sel: DimensionPredicate): MacroBinding[] => [{ ...MB[0]!, selector: sel }];
    const scalarMapListCard = set("a", [four("mbs", true, { tier: ["retail"] })], mapped({ tier: "retail" }));
    expect(() => checkMacroBindings(scalarMapListCard)).toThrow(SERVER);
    expect(stackMappedGap(scalarMapListCard)).toBe(NO_MODEL);
    const listMapScalarCard = set("b", [four("mbs", true, { tier: "retail" })], mapped({ tier: ["retail"] }));
    expect(() => checkMacroBindings(listMapScalarCard)).toThrow(SERVER);
    expect(stackMappedGap(listMapScalarCard)).toBe(NO_MODEL);
    const same = set("c", [four("mbs", true, { tier: "retail" })], mapped({ tier: "retail" }));
    expect(() => checkMacroBindings(same)).not.toThrow();
    expect(stackMappedGap(same)).toBeNull();
  });
  it("the engine's target identity: reordered array values are a different target, blocked exactly when the engine refuses", () => {
    const mapped: MacroBinding[] = [{ ...MB[0]!, selector: { tier: ["a", "b"] } }];
    const reordered = set("r", [four("mbs", true, { tier: ["b", "a"] })], mapped);
    expect(() => checkMacroBindings(reordered)).toThrow(SERVER);
    expect(stackMappedGap(reordered)).toBe(NO_MODEL);
    const same = set("s", [four("mbs", true, { tier: ["a", "b"] })], mapped);
    expect(() => checkMacroBindings(same)).not.toThrow();
    expect(stackMappedGap(same)).toBeNull();
  });
  it("a family with no prepay binding at all counts as no four-factor binding; a nmd-decay binding on the family does not stand in", () => {
    const decay: OverlayBinding = { familyId: "mbs", overlay: { kind: "registered", registeredKind: "test-decay", params: { rate: 1 } }, modelVersion: "v1" };
    expect(stackMappedGap(set("x", [decay], MB))).toBe(NO_MODEL);
  });
});

describe("SaveBar with a block", () => {
  const id = "reason-save-stack";
  it("blocked: the button is disabled, points at the reason, and the reason prints", () => {
    const html = renderToStaticMarkup(<SaveBar ws="ws-a" setId="stack-0123456789ab" layersOn={1} busy={false} block={NO_MODEL} outcome={null} query={{}} onSave={() => {}} />);
    const tag = html.slice(html.indexOf("<button"), html.indexOf(">", html.indexOf("<button")));
    expect(tag).toContain('disabled=""');
    expect(tag).toContain(`aria-describedby="${id}"`);
    expect(html).toContain(`<span class="muted" id="${id}" role="status">${NO_MODEL}</span>`);
  });
  it("power: no block leaves the button enabled with no reason; a block of null is the same", () => {
    const html = renderToStaticMarkup(<SaveBar ws="ws-a" setId="stack-0123456789ab" layersOn={1} busy={false} block={null} outcome={null} query={{}} onSave={() => {}} />);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain(id);
    expect(html).not.toContain("Off:");
  });
});

describe("the Stacks page passes the composed stack's block to Save", () => {
  it("the page computes the block from the flat set it saves, and hands it to SaveBar", () => {
    const src = readFileSync(fileURLToPath(new URL("../pages/assumptions/AssumptionsPage.tsx", import.meta.url)), "utf8");
    expect(src).toContain("block={stackMappedGap(flat.set)}");
    expect(src).toContain("onSave={() => props.onSave(flat.set)}");
  });
});
