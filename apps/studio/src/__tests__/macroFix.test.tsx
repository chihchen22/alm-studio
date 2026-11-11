// apps/studio/src/__tests__/macroFix.test.tsx
/**
 * ALM Studio Piece 7b, final-review fix (mf-fix): the Stack diff lists a macro
 * mapping change as one row (Important 1), and Remove on a mapped family's
 * housing group is refused before save, with copy that says so (Important 2).
 * Server render and pure functions only; every expected string is restated by
 * hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionDiff, AssumptionSet, MacroBinding } from "@alm/engine";
import type { AssumptionSetListItem } from "@alm/reader";
import { deltaRows } from "../assumptions/stackModel";
import { DiffTable } from "../pages/assumptions/AssumptionsViews";
import { EditSetView, MacroMappingRow, type EditSetViewProps } from "../pages/assumptions/EditSetPage";
import { checkMacroBindings } from "@alm/engine/src/scenario/macroBindings";
import { addBinding, bindingRefusal, draftSet, groupRemoveRefusal, removeBinding, saveBlock, savePayload, setGroup, switchModel } from "../assumptions/setEditModel";

const PREPAY = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const HOUSING = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const MB: MacroBinding[] = [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }];
/** mbs (index 0) carries the group and is mapped; mortgages (index 1) carries the group and is not mapped. */
const mapped: AssumptionSet = {
  schemaVersion: "1.0.0", id: "housing-x", label: "Housing x",
  bindings: [
    { familyId: "mbs", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY, housing: HOUSING } as never, modelVersion: "kernel-four-factor-cpr-1" },
    { familyId: "mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY, housing: HOUSING } as never, modelVersion: "kernel-four-factor-cpr-1" },
  ],
  macroBindings: MB,
};
const { macroBindings: _m, ...unmapped } = mapped;
const plain: AssumptionSet = { ...unmapped, bindings: mapped.bindings.slice(0, 1) };

describe("the Stack diff lists the macro mapping (Important 1)", () => {
  const leaf = { familyId: "mbs", overlayKind: "prepay" as const, path: "housing.asOfLtv", from: null, to: 0.7 };
  it("a diff carrying a mapping change prints one row after the leaf rows: series, feeder, family and selector each side", () => {
    const to: MacroBinding[] = [...MB, { seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mortgages", selector: { tier: "retail" } }];
    const diff: AssumptionDiff = { baseId: "plain", deltas: [leaf], macroBindings: { from: null, to } };
    const rows = deltaRows(diff, plain, mapped);
    expect(rows.length).toBe(2);
    expect(rows[1]).toEqual({
      familyId: "mbs, mortgages", kind: "macro mapping", selector: "whole family; tier: retail", path: "macroBindings", change: "added",
      from: { kind: "absent", text: "Not stored" },
      to: { kind: "text", text: "hpi-down-30 via prepay-housing to mbs, whole family; hpi-down-30 via prepay-housing to mortgages, tier: retail" },
    });
    const changed = deltaRows({ baseId: "a", deltas: [], macroBindings: { from: MB, to: [{ seriesId: "hpi-flat", feeder: "prepay-housing", familyId: "mbs" }] } }, mapped, mapped);
    expect(changed).toEqual([{
      familyId: "mbs", kind: "macro mapping", selector: "whole family", path: "macroBindings", change: "changed",
      from: { kind: "text", text: "hpi-down-30 via prepay-housing to mbs, whole family" },
      to: { kind: "text", text: "hpi-flat via prepay-housing to mbs, whole family" },
    }]);
    const removed = deltaRows({ baseId: "a", deltas: [], macroBindings: { from: MB, to: null } }, mapped, plain);
    expect(removed.map((r) => [r.change, r.from, r.to])).toEqual([["removed", { kind: "text", text: "hpi-down-30 via prepay-housing to mbs, whole family" }, { kind: "absent", text: "Not stored" }]]);
  });
  it("a diff without a mapping change prints no extra row", () => {
    const rows = deltaRows({ baseId: "plain", deltas: [leaf] }, plain, plain);
    expect(rows.length).toBe(1);
    expect(rows.some((r) => r.kind === "macro mapping")).toBe(false);
    expect(deltaRows({ baseId: "plain", deltas: [] }, plain, plain)).toEqual([]);
  });
  it("the row renders in the diff table, and a mapping-only diff is a table, not the no-delta line", () => {
    const rows = deltaRows({ baseId: "plain", deltas: [], macroBindings: { from: null, to: MB } }, plain, mapped);
    const html = renderToStaticMarkup(<DiffTable diff={{ kind: "ok", rows }} baseId="plain" layersOn={1} />);
    expect(html).toContain("<table");
    expect(html).toContain(">macro mapping<");
    expect(html).toContain(">macroBindings<");
    expect(html).toContain(">hpi-down-30 via prepay-housing to mbs, whole family<");
    expect(html).not.toContain("The route returned no delta");
    const none = renderToStaticMarkup(<DiffTable diff={{ kind: "ok", rows: deltaRows({ baseId: "plain", deltas: [] }, plain, plain) }} baseId="plain" layersOn={1} />);
    expect(none).toContain("The route returned no delta");
    expect(none).not.toContain("macro mapping");
  });
});

describe("Remove on a mapped family's housing group is refused before save (Important 2)", () => {
  const REFUSAL = "This group cannot be removed while the set maps a series to mbs. The mapping must be removed first; Studio does not edit the mapping.";
  const base: EditSetViewProps = {
    sets: [{ id: "housing-x", label: "Housing x", contentHash: "h" }], selected: "housing-x", draft: draftSet(mapped), reading: false, loadError: null, listNote: null,
    saving: null, saveId: "housing-x-edit-1", note: null, book: null, bookId: null, bookNote: "Pick a book in the Book pill to list its families", stored: [], storedNote: null,
    onPick() {}, onDraft() {}, onSave() {}, onReread() {},
  };
  /** The opening tag of the group control with id edit-<index>-housing. */
  const control = (html: string, index: number): string => {
    const tag = html.split("<button").find((t) => t.includes(`id="edit-${index}-housing"`));
    if (tag === undefined) throw new Error(`no control edit-${index}-housing`);
    return tag.slice(0, tag.indexOf(">"));
  };
  it("mapped: the refusal names the family and the order of work; the control is disabled and points at the copy", () => {
    expect(groupRemoveRefusal(draftSet(mapped), 0, "housing")).toBe(REFUSAL);
    const html = renderToStaticMarkup(<EditSetView {...base} />);
    expect(control(html, 0)).toContain('disabled=""');
    expect(control(html, 0)).toContain('aria-describedby="edit-0-housing-refusal"');
    expect(html).toContain(`<p class="field-help" id="edit-0-housing-refusal">${REFUSAL}</p>`);
  });
  it("unmapped: a family the set does not map, and a set with no mapping, keep Remove on with no refusal", () => {
    expect(groupRemoveRefusal(draftSet(mapped), 1, "housing")).toBeNull();
    expect(groupRemoveRefusal(draftSet(unmapped), 0, "housing")).toBeNull();
    const html = renderToStaticMarkup(<EditSetView {...base} />);
    expect(control(html, 1)).not.toContain("disabled");
    const free = renderToStaticMarkup(<EditSetView {...base} draft={draftSet(unmapped)} />);
    expect(control(free, 0)).not.toContain("disabled");
    expect(free).not.toContain("cannot be removed");
  });
  it("the mapping row's foot line says the group of a mapped family cannot be removed and the mapping goes first", () => {
    const html = renderToStaticMarkup(<MacroMappingRow lines={["hpi-down-30 to mbs (house-price response)"]} />);
    expect(html).toContain("Read-only here: Studio does not edit the mapping, and it is kept on save. While the set maps a series to a family, that family&#x27;s house-price response cannot be removed; the mapping must be removed first. Every housing value is illustrative.");
    expect(html).not.toContain("Read-only here: the mapping is kept on save. Every");
  });
});

describe("Switch model and Remove on a mapped family's binding card are refused before save (mfu-3)", () => {
  const CARD = "This binding cannot be removed or switched to another model while the set maps a series to mbs: the engine refuses a mapped family whose four-factor prepay binding carries no housing group. The mapping must be removed first; Studio does not edit the mapping.";
  const NO_GROUP = "Off: the set maps a series to mbs, whose four-factor prepay binding carries no housing group";
  const NO_MODEL = "Off: the set maps a series to mbs, which has no four-factor prepay binding";
  const SERVER = 'maps family "mbs" to the house-price response, but its four-factor prepay binding carries no housing group';
  const base: EditSetViewProps = {
    sets: [{ id: "housing-x", label: "Housing x", contentHash: "h" }], selected: "housing-x", draft: draftSet(mapped), reading: false, loadError: null, listNote: null,
    saving: null, saveId: "housing-x-edit-1", note: null, book: null, bookId: null, bookNote: "Pick a book in the Book pill to list its families", stored: [], storedNote: null,
    onPick() {}, onDraft() {}, onSave() {}, onReread() {},
  };
  /** The opening tag of the button with DOM id `id`. */
  const button = (html: string, id: string): string => {
    const tag = html.split("<button").find((t) => t.includes(`id="${id}"`));
    if (tag === undefined) throw new Error(`no button ${id}`);
    return tag.slice(0, tag.indexOf(">"));
  };
  it("the server refusal the copy restates: the engine's bind check names the same defect for a group off and a card gone", () => {
    expect(() => checkMacroBindings(savePayload(setGroup(draftSet(mapped), 0, "housing", false), "x"))).toThrow(SERVER);
    expect(() => checkMacroBindings(savePayload(removeBinding(draftSet(mapped), 0), "x"))).toThrow(SERVER);
    // Power: the unchanged draft passes the same check.
    expect(() => checkMacroBindings(savePayload(draftSet(mapped), "x"))).not.toThrow();
  });
  it("pure: the mapped stored card carries the refusal; an unmapped card, an unmapped set, a missing index and an added card carry none", () => {
    expect(bindingRefusal(draftSet(mapped), 0)).toBe(CARD);
    expect(bindingRefusal(draftSet(mapped), 1)).toBeNull();
    expect(bindingRefusal(draftSet(unmapped), 0)).toBeNull();
    expect(bindingRefusal(draftSet(mapped), 2)).toBeNull();
    // An added card on the mapped family is not stored: Remove discards it and leaves the stored one.
    const added = addBinding(draftSet(mapped), "prepay/four-factor-cpr", "mbs", undefined, null);
    expect(bindingRefusal(added, 2)).toBeNull();
  });
  it("Save stays off while a mapped family has no housing group or no four-factor model, and only then", () => {
    expect(saveBlock(setGroup(draftSet(mapped), 0, "housing", false), false, null)).toBe(NO_GROUP);
    expect(saveBlock(switchModel(draftSet(mapped), 0, "prepay/constant-cpr", null), false, null)).toBe(NO_MODEL);
    expect(saveBlock(removeBinding(draftSet(mapped), 0), false, null)).toBe(NO_MODEL);
    // Power: the same edits on a family the set does not map, or on a set with no mapping, do not take this block.
    expect(saveBlock(setGroup(draftSet(mapped), 1, "housing", false), false, null)).toBeNull();
    expect(saveBlock(removeBinding(draftSet(mapped), 1), false, null)).toBeNull();
    expect(saveBlock(setGroup(draftSet(unmapped), 0, "housing", false), false, null)).toBeNull();
    expect(saveBlock(removeBinding(draftSet(unmapped), 0), false, null)).toBeNull();
    expect(saveBlock(draftSet(mapped), false, null)).toBe("Off: nothing has changed");
  });
  it("render: the mapped card's Remove and Switch model are disabled and point at the copy; the unmapped card's are not", () => {
    const html = renderToStaticMarkup(<EditSetView {...base} />);
    for (const id of ["remove-binding-0", "switch-model-0"]) {
      expect(button(html, id)).toContain('disabled=""');
      expect(button(html, id)).toContain('aria-describedby="binding-0-refusal"');
    }
    expect(html).toContain(`<p class="field-help" id="binding-0-refusal">${CARD}</p>`);
    for (const id of ["remove-binding-1", "switch-model-1"]) expect(button(html, id)).not.toContain("disabled");
    expect(html).not.toContain('id="binding-1-refusal"');
    const free = renderToStaticMarkup(<EditSetView {...base} draft={draftSet(unmapped)} />);
    expect(button(free, "remove-binding-0")).not.toContain("disabled");
    expect(button(free, "switch-model-0")).not.toContain("disabled");
    expect(free).not.toContain("cannot be removed or switched");
  });
});

describe("the assumption-set listing row type carries documentMissing (mfu-3, Slice 3 M4)", () => {
  it("a row the server marks documentMissing types as such, with a one-line doc", () => {
    const row: AssumptionSetListItem = { id: "gone", label: "gone", contentHash: "h", documentMissing: true };
    expect(row.documentMissing).toBe(true);
    const src = readFileSync(fileURLToPath(new URL("../../../../packages/reader/src/api/client.ts", import.meta.url)), "utf8");
    const at = src.indexOf("  documentMissing?: true;");
    expect(at).toBeGreaterThan(src.indexOf("export interface AssumptionSetListItem {"));
    expect(src.slice(src.lastIndexOf("/**", at), at)).toMatch(/^\/\*\* [^\n]+ \*\/\n$/);
  });
});
