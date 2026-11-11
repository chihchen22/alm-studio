// apps/studio/src/__tests__/macroCopy.test.tsx
/**
 * The Compare, Plan and Dashboard copy, the
 * housing group card on Edit a set and the read-only Macro mapping row on Edit
 * a set and By kind. Server render and pure functions only.
 * Every copy string is restated here by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { HOUSING_GROUP_LABEL } from "@alm/engine/src/contracts/paramSchema";
import { ComparePage, MACRO_COMPARE_NOTE } from "../pages/compare/ComparePage";
import { MACRO_PATH_NOTE } from "../market/macroModel";
import { DashboardView } from "../pages/dashboard/DashboardPage";
import { EditSetView, type EditSetViewProps } from "../pages/assumptions/EditSetPage";
import { ByKindMapping } from "../pages/assumptions/ByKindPage";
import { changesOf, draftSet, fieldsToFix, issuesOf, macroMappingLines, savePayload, setGroup, setValue } from "../assumptions/setEditModel";

const PREPAY = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const HOUSING = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
/** A set whose mbs binding (index 0) carries the group and both families map hpi-down-30; mortgages (index 1) carries none. */
const housingSet: AssumptionSet = {
  schemaVersion: "1.0.0", id: "housing-x", label: "Housing x",
  bindings: [
    { familyId: "mbs", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY, housing: HOUSING } as never, modelVersion: "kernel-four-factor-cpr-1" },
    { familyId: "mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY } as never, modelVersion: "kernel-four-factor-cpr-1" },
  ],
  macroBindings: [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }],
};
const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the housing group in the set editor model", () => {
  it("group off writes no housing key; on writes seven numbers", () => {
    const d0 = draftSet(housingSet);
    expect(d0.bindings[0]!.groupOn).toEqual({ housing: true });
    expect(d0.bindings[1]!.groupOn).toEqual({ housing: false });
    const off = setGroup(d0, 0, "housing", false);
    expect("housing" in (savePayload(off, "x").bindings[0]!.overlay as object)).toBe(false);
    const on = setGroup(off, 0, "housing", true);
    expect(Object.keys((savePayload(on, "x").bindings[0]!.overlay as { housing: object }).housing).length).toBe(7);
    expect((savePayload(on, "x").bindings[0]!.overlay as { housing: object }).housing).toEqual(HOUSING);
  });
  it("an unchanged draft posts the stored overlays as stored, the mapping verbatim", () => {
    const p = savePayload(draftSet(housingSet), "x");
    expect(p.bindings.map((b) => b.overlay)).toEqual(housingSet.bindings.map((b) => b.overlay));
    expect(p.macroBindings).toEqual(housingSet.macroBindings);
    expect(changesOf(draftSet(housingSet))).toEqual([]);
  });
  it("Remove and Add read as one change line each; an edited field reads as a field change", () => {
    const off = setGroup(draftSet(housingSet), 0, "housing", false);
    expect(changesOf(off)).toEqual([{ where: "mbs, whole family", label: "House-price response (illustrative)", from: null, to: "removed" }]);
    const added = setGroup(draftSet(housingSet), 1, "housing", true);
    expect(changesOf(added)).toEqual([{ where: "mortgages, whole family", label: "House-price response (illustrative)", from: null, to: "added" }]);
    const edited = setValue(draftSet(housingSet), 0, "housing.asOfLtv", "0.8");
    expect(changesOf(edited)).toEqual([{ where: "mbs, whole family", label: "As-of LTV", from: "0.7", to: "0.8" }]);
  });
  it("an added group with empty fields asks for each of the seven, and its issues go when the group is removed again", () => {
    const added = setGroup(draftSet(housingSet), 1, "housing", true);
    expect(issuesOf(added.bindings[1]!).filter((i) => i.message === "Enter a number").map((i) => i.path)).toEqual([
      "housing.asOfLtv", "housing.refiLtvMid", "housing.refiLtvSlope", "housing.turnoverLtvMid", "housing.turnoverLtvSlope", "housing.turnoverFloorShare", "housing.turnoverCprFloor"]);
    expect(fieldsToFix(added).length).toBe(7);
    expect(issuesOf(setGroup(added, 1, "housing", false).bindings[1]!)).toEqual([]);
  });
  it("the mapping lines read <seriesId> to <familyId> (house-price response); an unmapped set has none", () => {
    expect(macroMappingLines(housingSet.macroBindings)).toEqual(["hpi-down-30 to mbs (house-price response)"]);
    expect(macroMappingLines(undefined)).toEqual([]);
  });
});

describe("Edit a set and By kind", () => {
  const base: EditSetViewProps = {
    sets: [{ id: "housing-x", label: "Housing x", contentHash: "h" }], selected: "housing-x", draft: draftSet(housingSet), reading: false, loadError: null, listNote: null,
    saving: null, saveId: "housing-x-edit-1", note: null, book: null, bookId: null, bookNote: "Pick a book in the Book pill to list its families", stored: [], storedNote: null,
    onPick() {}, onDraft() {}, onSave() {}, onReread() {},
  };
  it("the housing group card sits under each four-factor binding, titled with the illustrative label, with Remove or Add", () => {
    expect(HOUSING_GROUP_LABEL).toBe("House-price response (illustrative)");
    const html = renderToStaticMarkup(<EditSetView {...base} />);
    expect(html.split(`aria-label="${HOUSING_GROUP_LABEL}"`).length - 1).toBe(2);
    expect(html).toContain(`aria-label="Remove ${HOUSING_GROUP_LABEL}"`);
    expect(html).toContain(`aria-label="Add ${HOUSING_GROUP_LABEL}"`);
    expect(html).toContain('id="edit-0-housing.asOfLtv"');
    expect(html).not.toContain('id="edit-1-housing.asOfLtv"');
    // The group-off copy promises fields to fill, not values (review M3).
    expect(html).toContain("Not carried: this binding has no house-price response. Add opens the seven parameters to fill, each illustrative.");
    expect(html).not.toContain("Add gives all seven parameters");
  });
  it("Edit a set shows the read-only Macro mapping row; an unmapped set shows none", () => {
    const html = renderToStaticMarkup(<EditSetView {...base} />);
    expect(html).toContain('aria-label="Macro mapping"');
    expect(html).toContain("hpi-down-30 to mbs (house-price response)");
    const { macroBindings: _m, ...unmapped } = housingSet;
    expect(renderToStaticMarkup(<EditSetView {...base} draft={draftSet(unmapped)} />)).not.toContain('aria-label="Macro mapping"');
  });
  it("By kind shows each mapped set's mapping row on the prepayment layer only", () => {
    const sets = [housingSet, { id: "plain", macroBindings: undefined }];
    const html = renderToStaticMarkup(<ByKindMapping kinds={["prepay"]} sets={sets} />);
    expect(html.split('aria-label="Macro mapping"').length - 1).toBe(1);
    expect(html).toContain("housing-x");
    expect(html).toContain("hpi-down-30 to mbs (house-price response)");
    expect(renderToStaticMarkup(<ByKindMapping kinds={["nmd-decay"]} sets={sets} />)).toBe("");
  });
});

describe("Compare, Plan and Dashboard copy", () => {
  it("Compare note renders outside the pinned components", () => {
    expect(MACRO_COMPARE_NOTE).toBe("The house-price response shows here, run against run: compare a mapped run with the unmapped run on the same market. Every scenario in a run shares one macro path, inherited from the base, so the Dashboard stress card and the EVE channel rows show none of it.");
    expect(renderToStaticMarkup(<ComparePage ws="ws-a" query={{}} />)).toContain(MACRO_COMPARE_NOTE);
    // Outside CompareBody, CompareTable, ProvenanceCard and RunPickers: the views file does not name it.
    expect(SRC("../pages/compare/CompareViews.tsx")).not.toContain("MACRO_COMPARE_NOTE");
  });
  // Re-expectation (mfu-3, final-review Minor 4): the note renders on unmapped runs too, so it says "at most one"; declared once, imported by both pages.
  it("Plan and Dashboard say a run's scenarios share at most one macro path, inherited from the base", () => {
    const want = "A run's scenarios share at most one macro path, inherited from the base scenario's assumption set.";
    expect(MACRO_PATH_NOTE).toBe(want);
    for (const page of ["../pages/plan/PlanPage.tsx", "../pages/dashboard/DashboardPage.tsx"]) {
      const src = SRC(page);
      expect(src).toContain('import { MACRO_PATH_NOTE } from "../../market/macroModel";');
      expect(src).not.toContain("const MACRO_PATH_NOTE");
      expect(src.split("{MACRO_PATH_NOTE}").length - 1).toBe(1);
    }
    expect(SRC("../market/macroModel.ts").split("export const MACRO_PATH_NOTE =").length - 1).toBe(1);
    const model = { cards: [], rows: [], newBusinessNote: null } as never;
    expect(renderToStaticMarkup(<DashboardView runId="r1" model={model} limitUse={{ state: "loading" }} />)).toContain("A run&#x27;s scenarios share at most one macro path, inherited from the base scenario&#x27;s assumption set.");
  });
});
