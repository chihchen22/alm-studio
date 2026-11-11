// apps/studio/src/__tests__/polish2Edits.test.ts
/**
 * ALM Studio Polish 2: the pure helpers behind the Edit a set fixes. No DOM,
 * no effects; expected values and texts are restated here.
 */
import { describe, expect, it } from "vitest";
import type { AssumptionSet, OverlayBinding, PortfolioSpec } from "@alm/engine";
import { PARAM_SCHEMAS } from "@alm/engine/src/contracts/paramSchema";
import { ApiError, type AssumptionSetListItem } from "@alm/reader";
import {
  ADD_MODELS, addBinding, addLabel, cardMarker, changeLine, changesOf, draftSet, EMPTY_ADD, fieldsToFix, fixGroups, fixListItems, focusAfterReread, groupsOf, KIND_GROUPS,
  listFailure, noteShown, readStore, removeBinding, removedName, restoreBinding, restoreBindingId, savePayload, selectorNote, setValue, START_BLANK,
  startBlock, storedShown, switchModel, type SaveNote,
} from "../assumptions/setEditModel";

const DECAY_BINDING: OverlayBinding = {
  familyId: "dda",
  overlay: {
    kind: "nmd-decay",
    params: {
      closureSteady: 0.75, closureInitial: 2, closureTauMonths: 24, burnoutLambda: 0.1, maxRateDecay: 3, maxRateGrowth: -1, logisticK: 2, logisticMidpoint: 0,
      maPeriod: 24, regimeAlpha: 2, balanceSize: 1000000, sens: { gMin: 0.15, gMax: 1, bStar: 1100000, kappaB: 1.3 },
      buckets: [{ label: "small", repBalance: 100000, share: 1 }],
    },
  },
  modelVersion: "kernel-nmd-decay-1",
};
const SET_A: AssumptionSet = { schemaVersion: "1.0.0", id: "a", label: "A", bindings: [DECAY_BINDING] };

/** Two books restated here: one with no taxonomy, one whose dda positions carry a tag. */
const FAMILIES = [
  { id: "dda", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "n" },
  { id: "cds", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: "n" },
];
const PLAIN = { id: "book-plain", label: "Plain", asOf: "2026-03-31", coa: { schemaVersion: "1.0.0", nodes: [], families: FAMILIES }, positions: [] } as unknown as PortfolioSpec;
const TAGGED = {
  ...PLAIN,
  id: "book-tagged",
  taxonomy: { schemaVersion: "1.0.0", id: "t", label: "T", dimensions: [{ id: "lcr-category", label: "LCR category", values: ["retail-stable"] }] },
  positions: [{ id: "d1", familyId: "dda", coaNodeId: "n", terms: {}, dimensions: { "lcr-category": "retail-stable" } }],
} as unknown as PortfolioSpec;

describe("the save note lives only while its draft and its book do (A1)", () => {
  const refused: SaveNote = { text: "422: invalid assumption set at bindings[4]", error: true, edits: 3, bookId: "b1" };
  it("shows the note while the draft has had no edit since Save and the Book pill names the same book", () => {
    expect(noteShown(refused, 3, "b1")).toBe(refused);
  });
  it("hides it after one more edit, under another book or none, and when there is no note", () => {
    expect(noteShown(refused, 4, "b1")).toBeNull();
    expect(noteShown(refused, 3, "b2")).toBeNull();
    expect(noteShown(refused, 3, null)).toBeNull();
    expect(noteShown(null, 3, "b1")).toBeNull();
  });
  it("holds a Saved line to the same rule", () => {
    const saved: SaveNote = { text: "Saved demo-behavioral-v1-edit-5", error: false, edits: 0, bookId: null };
    expect(noteShown(saved, 0, null)).toBe(saved);
    expect(noteShown(saved, 0, "b1")).toBeNull();
  });
});

describe("a failed read of the set list keeps the editor when a list is held (A2)", () => {
  const down = { state: "error" as const, error: new TypeError("Failed to fetch") };
  it("is the page's own error only when no list was ever read", () => {
    expect(listFailure(down, null)).toEqual({ kind: "page", text: "The platform could not be reached. Is it running?" });
  });
  it("is a note over the held list otherwise, with the error text", () => {
    expect(listFailure(down, [{ id: "a" }])).toEqual({
      kind: "note",
      text: "The set list was not read again; the list shown is the last one read. The platform could not be reached. Is it running?",
    });
    expect(listFailure({ state: "error", error: new ApiError(500, "store_unreadable", "store offline") }, [])).toEqual({
      kind: "note",
      text: "The set list was not read again; the list shown is the last one read. 500: store offline",
    });
  });
  it("is nothing while the list is read or once it has been", () => {
    expect(listFailure({ state: "ok", value: [] }, null)).toBeNull();
    expect(listFailure({ state: "loading" }, [{ id: "a" }])).toBeNull();
  });
  it("hands focus from Read the list again to Save, or to the set picker when no set is shown (drive X1)", () => {
    expect(focusAfterReread(true)).toBe("edit-set-save");
    expect(focusAfterReread(false)).toBe("edit-set-pick");
  });
});

describe("one read of the store, held while it is read again (A3)", () => {
  const LISTED: AssumptionSetListItem[] = [{ id: "a", label: "A", contentHash: "ha" }, { id: "b", label: "B", contentHash: "hb" }];
  it("lists once, reads every listed set, and counts the ones it could not read", async () => {
    let lists = 0;
    const gets: string[] = [];
    const r = await readStore(
      async () => { lists += 1; return LISTED; },
      async (id) => { gets.push(id); if (id === "b") throw new Error("gone"); return SET_A; },
    );
    expect(lists).toBe(1);
    expect(gets).toEqual(["a", "b"]);
    expect(r).toEqual({ listed: LISTED, stored: { sets: [SET_A], unread: 1 } });
  });
  it("rejects when the list cannot be read, so the page's list failure reports it", async () => {
    await expect(readStore(async () => { throw new TypeError("Failed to fetch"); }, async () => SET_A)).rejects.toThrow("Failed to fetch");
  });
  it("keeps the last stored read while the store is read again or could not be, so the start choices never empty", () => {
    const held = { sets: [SET_A], unread: 0 };
    expect(storedShown({ state: "loading" }, held)).toBe(held);
    expect(storedShown({ state: "error", error: new Error("down") }, held)).toBe(held);
    const next = { sets: [], unread: 2 };
    expect(storedShown({ state: "ok", value: next }, held)).toBe(next);
    expect(storedShown({ state: "loading" }, null)).toBeNull();
  });
  it("holds a start no longer offered, and passes a blank or offered one", () => {
    expect(startBlock("demo#0", [])).toBe("Pick where the values start");
    expect(startBlock(START_BLANK, [])).toBeNull();
    expect(startBlock("demo#0", [{ id: "demo#0", label: "x", binding: DECAY_BINDING }])).toBeNull();
  });
});

describe("the no-tags line shows whatever else holds Add off (A7)", () => {
  const stale = { key: "nmd-decay" as const, familyId: "dda", selector: undefined, start: "gone#0" };
  it("names the book when the picked family is offered and carries no tag", () => {
    expect(selectorNote(stale, PLAIN)).toBe("This family's positions carry no tags in book-plain; the binding covers the whole family.");
  });
  it("is nothing with no book, no family, a family the model does not fit, or a family with chips", () => {
    expect(selectorNote(stale, null)).toBeNull();
    expect(selectorNote({ ...stale, familyId: null }, PLAIN)).toBeNull();
    expect(selectorNote({ ...stale, familyId: "cds" }, PLAIN)).toBeNull();
    expect(selectorNote(stale, TAGGED)).toBeNull();
  });
});

describe("one name per model (A4)", () => {
  it("the schema names each one-model kind, and the add picker and group headings read those names", () => {
    expect(["nmd-decay", "deposit-beta", "cd-rollover", "commitment-draw"].map((k) => PARAM_SCHEMAS[k as "nmd-decay"].label)).toEqual([
      "Deposit decay", "Deposit repricing", "CD rollover", "Commitment draws",
    ]);
    expect(ADD_MODELS.map((m) => m.label)).toEqual([
      "Prepayment, four-factor CPR", "Prepayment, constant CPR", "Deposit decay", "Deposit repricing", "CD rollover", "Commitment draws", "Loan client rate, flat carry",
    ]);
    expect(KIND_GROUPS.map((g) => g.heading)).toEqual(["Prepayment", "Deposit decay", "Deposit repricing", "CD rollover", "Commitment draws", "Loan client rate, flat carry", "Plugin kinds"]);
    for (const k of ["nmd-decay", "deposit-beta", "cd-rollover", "commitment-draw"] as const) {
      expect(ADD_MODELS.find((m) => m.key === k)!.label, k).toBe(PARAM_SCHEMAS[k].label);
      expect(KIND_GROUPS.find((g) => g.kind === k)!.heading, k).toBe(PARAM_SCHEMAS[k].label);
    }
  });
});

/** A stored set shaped like the seeded demo set, restated here: two four-factor prepay, one decay, one beta. */
const PREPAY = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const DEMO: AssumptionSet = {
  schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo base behavioral set",
  bindings: [
    { familyId: "mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY }, modelVersion: "kernel-four-factor-cpr-1" },
    { familyId: "mbs", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY }, modelVersion: "kernel-four-factor-cpr-1" },
    DECAY_BINDING,
    { familyId: "mma", overlay: { kind: "deposit-beta", params: { betaMin: 0.45, betaMax: 0.8, k: 0.55, m: 4.0, lambda: 1 } }, modelVersion: "kernel-deposit-beta-1" },
  ],
};

describe("the add form's commit names what it adds (M1)", () => {
  it("reads Add <model> on <family> once both are picked, the model named as on its card, else Add binding", () => {
    expect(addLabel({ key: "nmd-decay", familyId: "dda", selector: undefined, start: START_BLANK })).toBe("Add Deposit decay on dda");
    expect(addLabel({ key: "prepay/constant-cpr", familyId: "mortgages", selector: undefined, start: START_BLANK })).toBe("Add Constant CPR on mortgages");
    expect(addLabel(EMPTY_ADD)).toBe("Add binding");
    expect(addLabel({ ...EMPTY_ADD, key: "nmd-decay" })).toBe("Add binding");
  });
});

describe("the fix list groups by binding and collapses a long group (M3)", () => {
  it("collapses a blank decay binding's 17 open fields to one button on its first, the model version", () => {
    const d = addBinding(draftSet(DEMO), "nmd-decay", "mma", undefined, null);
    expect(fixGroups(d).map((g) => [g.name, g.fixes.length])).toEqual([["Deposit decay, mma, whole family", 17]]);
    expect(fixListItems(d)).toEqual([{ label: "Deposit decay, mma, whole family: 17 fields to fix", target: "edit-4-modelVersion" }]);
    expect(fieldsToFix(d)).toHaveLength(17);
  });
  it("lists a group of 5 or fewer field by field, each named with its binding; a lower cap collapses it", () => {
    const d = addBinding(draftSet(DEMO), "cd-rollover", "cds", undefined, null);
    expect(fixListItems(d)).toEqual([
      { label: "CD rollover, cds, whole family: Model version", target: "edit-4-modelVersion" },
      { label: "CD rollover, cds, whole family: Renewal probability", target: "edit-4-renewalProbability" },
      { label: "CD rollover, cds, whole family: Offered spread", target: "edit-4-offeredSpreadBp" },
      { label: "CD rollover, cds, whole family: Renewal term", target: "edit-4-termMonths" },
    ]);
    expect(fixListItems(d, 3)).toEqual([{ label: "CD rollover, cds, whole family: 4 fields to fix", target: "edit-4-modelVersion" }]);
    expect(fixListItems(d, 4)).toEqual([
      { label: "CD rollover, cds, whole family: Model version", target: "edit-4-modelVersion" },
      { label: "CD rollover, cds, whole family: Renewal probability", target: "edit-4-renewalProbability" },
      { label: "CD rollover, cds, whole family: Offered spread", target: "edit-4-offeredSpreadBp" },
      { label: "CD rollover, cds, whole family: Renewal term", target: "edit-4-termMonths" },
    ]);
    expect(fieldsToFix(d)[1]).toEqual({ label: "cds, whole family: Renewal probability", target: "edit-4-renewalProbability" });
  });
});

describe("a switched card is marked, and a switch back to the stored model closes the version (M4)", () => {
  it("marks an added card New binding, a switched stored card Model switched, and a stored card nothing", () => {
    const s = draftSet(DEMO);
    expect(cardMarker(s.bindings[0]!)).toBeNull();
    expect(cardMarker(switchModel(s, 0, "prepay/constant-cpr", null).bindings[0]!)).toBe("Model switched");
    expect(cardMarker(addBinding(s, "cd-rollover", "cds", undefined, null).bindings[4]!)).toBe("New binding");
  });
  it("a round trip closes the version on the stored one: no marker, and no Model or Model version line in Changes", () => {
    const rt = switchModel(switchModel(draftSet(DEMO), 0, "prepay/constant-cpr", null), 0, "prepay/four-factor-cpr", null);
    const card = rt.bindings[0]!;
    expect([card.versionOpen, card.modelVersion, cardMarker(card)]).toEqual([false, "kernel-four-factor-cpr-1", null]);
    expect(changesOf(rt).map(changeLine)).toEqual([
      "mortgages, whole family: Securitization spread: 120 -> blank",
      "mortgages, whole family: Primary spread: 130 -> blank",
      "mortgages, whole family: Pool coupon: 6.5 -> blank",
      "mortgages, whole family: Minimum CPR: 2 -> blank",
      "mortgages, whole family: Maximum CPR: 65 -> blank",
      "mortgages, whole family: Refinance steepness: 2.5 -> blank",
      "mortgages, whole family: Refinance midpoint: 50 -> blank",
      "mortgages, whole family: Seasoning ramp: 30 -> blank",
      "mortgages, whole family: Seasonality amplitude: 20 -> blank",
      "mortgages, whole family: Burnout decay: 0.1 -> blank",
    ]);
  });
  it("an added card keeps its version open through a round trip: it has no stored version", () => {
    const a = addBinding(draftSet(DEMO), "prepay/four-factor-cpr", "mbs", undefined, null);
    const rt = switchModel(switchModel(a, 4, "prepay/constant-cpr", null), 4, "prepay/four-factor-cpr", null);
    expect([rt.bindings[4]!.versionOpen, cardMarker(rt.bindings[4]!)]).toEqual([true, "New binding"]);
  });
});

describe("Remove keeps a stored binding for Restore (M5)", () => {
  it("remove then restore an edited binding gives back the same bindings and the same changes", () => {
    const edited = setValue(draftSet(DEMO), 2, "params.closureSteady", "2");
    const removed = removeBinding(edited, 2);
    expect(changesOf(removed).map(changeLine)).toContain("dda, whole family: Deposit decay binding: removed");
    expect(removed.removed.map((d) => d.key)).toEqual([2]);
    const back = restoreBinding(removed, edited.bindings[2]!.key);
    expect(back.bindings).toEqual(edited.bindings);
    expect(back.removed).toEqual([]);
    expect(changesOf(back)).toEqual(changesOf(edited));
  });
  it("puts a restored binding back in stored order, before any added binding", () => {
    let d = addBinding(draftSet(DEMO), "cd-rollover", "cds", undefined, null);
    d = removeBinding(removeBinding(d, 0), 0);
    expect(d.bindings.map((b) => b.key)).toEqual([2, 3, 4]);
    expect(restoreBinding(d, 1).bindings.map((b) => b.key)).toEqual([1, 2, 3, 4]);
    expect(restoreBinding(restoreBinding(d, 1), 0).bindings.map((b) => b.key)).toEqual([0, 1, 2, 3, 4]);
  });
  it("puts the last stored binding back before an added one when no stored binding follows it", () => {
    const d = removeBinding(addBinding(draftSet(DEMO), "cd-rollover", "cds", undefined, null), 3);
    expect(d.bindings.map((b) => b.key)).toEqual([0, 1, 2, 4]);
    expect(restoreBinding(d, 3).bindings.map((b) => b.key)).toEqual([0, 1, 2, 3, 4]);
  });
  it("discards an added binding: there is nothing to restore", () => {
    expect(removeBinding(addBinding(draftSet(DEMO), "cd-rollover", "cds", undefined, null), 4).removed).toEqual([]);
  });
  it("keeps a placeholder where the card was, in its kind group; Save posts and checks only the bindings on the page", () => {
    const d = removeBinding(draftSet(DEMO), 0);
    expect(groupsOf(d).map((g) => [g.heading, g.items.map((x) => `${x.removed ? "removed" : "card"} ${x.draft.key}`)])).toEqual([
      ["Prepayment", ["removed 0", "card 1"]], ["Deposit decay", ["card 2"]], ["Deposit repricing", ["card 3"]],
    ]);
    expect(removedName(d.removed[0]!)).toBe("Four-factor CPR, mortgages, whole family");
    expect(restoreBindingId(0)).toBe("restore-binding-0");
    expect(savePayload(d, "x").bindings.map((b) => b.familyId)).toEqual(["mbs", "dda", "mma"]);
    expect(fieldsToFix(d)).toEqual([]);
  });
});
