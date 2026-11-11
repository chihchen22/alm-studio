// apps/studio/src/__tests__/pickerCopy.test.tsx
/**
 * mfu2-b: the Edit a set picker marks a set whose document is gone, the
 * mapped-card refusal copy names the mapping's selector, and mappingFor reads
 * the engine's target identity. Server render and pure functions only; every
 * expected string is restated by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet, MacroBinding } from "@alm/engine";
import { EditSetView, type EditSetViewProps } from "../pages/assumptions/EditSetPage";
import { bindingRefusal, draftSet, groupRemoveRefusal, mappedGap } from "../assumptions/setEditModel";

const PREPAY = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const HOUSING = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const binding = (selector?: object) => ({ familyId: "mbs", ...(selector === undefined ? {} : { selector }),
  overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY, housing: HOUSING } as never, modelVersion: "kernel-four-factor-cpr-1" });
const setOf = (bindingSel: object | undefined, mapSel: object | undefined): AssumptionSet => ({
  schemaVersion: "1.0.0", id: "sel-x", label: "Sel x",
  bindings: [binding(bindingSel)] as never,
  macroBindings: [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs", ...(mapSel === undefined ? {} : { selector: mapSel }) } as MacroBinding],
});

const CARD_PLAIN = "This binding cannot be removed or switched to another model while the set maps a series to mbs: the engine refuses a mapped family whose four-factor prepay binding carries no housing group. The mapping must be removed first; Studio does not edit the mapping.";
const GROUP_PLAIN = "This group cannot be removed while the set maps a series to mbs. The mapping must be removed first; Studio does not edit the mapping.";

describe("the picker marks a set whose document is missing", () => {
  const base: EditSetViewProps = {
    sets: [
      { id: "kept", label: "Kept", contentHash: "h1" },
      { id: "gone", label: "Gone", contentHash: "h2", documentMissing: true },
      { id: "gone-same", label: "gone-same", contentHash: "h3", documentMissing: true },
    ],
    selected: null, draft: null, reading: false, loadError: null, listNote: null, saving: null, saveId: null, note: null, book: null, bookId: null,
    bookNote: "Pick a book in the Book pill to list its families", stored: [], storedNote: null, onPick() {}, onDraft() {}, onSave() {}, onReread() {},
  };
  it("a missing set is a disabled option that says document missing; a kept set is neither", () => {
    const html = renderToStaticMarkup(<EditSetView {...base} />);
    expect(html).toContain('<option value="kept">kept: Kept</option>');
    expect(html).toContain('<option value="gone" disabled="">gone: Gone (document missing)</option>');
    expect(html).toContain('<option value="gone-same" disabled="">gone-same (document missing)</option>');
  });
  it("with no missing set the options carry no disabled attribute", () => {
    const html = renderToStaticMarkup(<EditSetView {...base} sets={[base.sets[0]!]} />);
    expect(html.match(/<option[^>]*>/g)?.some((o) => o.includes("disabled"))).toBe(false);
    expect(html).not.toContain("document missing");
  });
});

describe("the mapped-card refusal names the mapping's selector", () => {
  it("a mapping with a selector: the copy names family and selector, in the selector words the page prints elsewhere", () => {
    const s = setOf({ coupon: ["high"] }, { coupon: ["high"] });
    expect(bindingRefusal(draftSet(s), 0)).toBe(CARD_PLAIN.replace("to mbs:", "to mbs (coupon: high):"));
    expect(groupRemoveRefusal(draftSet(s), 0, "housing")).toBe(GROUP_PLAIN.replace("to mbs.", "to mbs (coupon: high)."));
  });
  it("several tags and several values read as the shared selector text", () => {
    const sel = { tier: ["retail", "private"], geo: "us" };
    expect(bindingRefusal(draftSet(setOf(sel, sel)), 0)).toContain("maps a series to mbs (geo: us and tier: private or retail):");
  });
  it("a mapping with no selector keeps today's text byte for byte", () => {
    const s = setOf(undefined, undefined);
    expect(bindingRefusal(draftSet(s), 0)).toBe(CARD_PLAIN);
    expect(groupRemoveRefusal(draftSet(s), 0, "housing")).toBe(GROUP_PLAIN);
  });
});

describe("mappingFor reads the engine's target identity", () => {
  it("a different selector is a different target: no refusal and the Save gap names the missing card", () => {
    const s = setOf({ coupon: ["low"] }, { coupon: ["high"] });
    expect(bindingRefusal(draftSet(s), 0)).toBeNull();
    expect(groupRemoveRefusal(draftSet(s), 0, "housing")).toBeNull();
    expect(mappedGap(draftSet(s))).toBe("Off: the set maps a series to mbs (coupon: high), which has no four-factor prepay binding");
  });
  it("the engine's rule, not the display sort: a one-element list is not its scalar, and an empty selector is not the whole family", () => {
    expect(bindingRefusal(draftSet(setOf({ coupon: "high" }, { coupon: ["high"] })), 0)).toBeNull();
    expect(bindingRefusal(draftSet(setOf(undefined, {})), 0)).toBeNull();
  });
});

describe("the Save-block text names the mapping's selector as the card refusal does", () => {
  it("no four-factor binding on the mapped target: family, then the selector in words", () => {
    const s = setOf({ coupon: ["low"] }, { coupon: ["high"] });
    expect(mappedGap(draftSet(s))).toBe("Off: the set maps a series to mbs (coupon: high), which has no four-factor prepay binding");
  });
  it("a binding on the target with no housing group reads the same way", () => {
    const s = setOf({ coupon: ["high"] }, { coupon: ["high"] });
    const noGroup = { ...s, bindings: [{ ...s.bindings[0]!, overlay: { ...(s.bindings[0]!.overlay as object), housing: undefined } }] } as AssumptionSet;
    expect(mappedGap(draftSet(noGroup))).toBe("Off: the set maps a series to mbs (coupon: high), whose four-factor prepay binding carries no housing group");
  });
  it("a mapping with no selector keeps today's text byte for byte", () => {
    const s = setOf({ coupon: ["low"] }, undefined);
    expect(mappedGap(draftSet(s))).toBe("Off: the set maps a series to mbs, which has no four-factor prepay binding");
  });
});
