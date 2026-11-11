// apps/studio/src/__tests__/bindingEdits.test.ts
/**
 * ALM Studio Piece 4b: adding, removing and model-switching a binding in the set editor's
 * model. Pure functions, no DOM. Expected values and texts are restated here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AssumptionSet, OverlayBinding, PortfolioSpec } from "@alm/engine";
import {
  ADD_BINDING_ID, ADD_MODELS, addBinding, addBlock, changeLine, changesOf, chipOn, draftSet, EMPTY_ADD, familyChoices, fieldsToFix, focusAfterRemoveBinding,
  issuesOf, newBindingDraft, pickAddFamily, pickAddModel, removeBinding, removeBindingId, restoreBindingId, saveBlock, saveIdFor, savePayload, selectorChips, setCell,
  bindsText, selectorText, setModelVersion, setValue, startBinding, startChoices, switchModel, switchTargets, takenIds, toggleChip, whereOf,
} from "../assumptions/setEditModel";

/** A stored set restated here: two prepay, one decay, one beta, one plugin kind. */
const PREPAY = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const DECAY = {
  closureSteady: 0.75, closureInitial: 2, closureTauMonths: 24, burnoutLambda: 0.1, maxRateDecay: 3, maxRateGrowth: -1, logisticK: 2, logisticMidpoint: 0,
  maPeriod: 24, regimeAlpha: 2, balanceSize: 1000000, sens: { gMin: 0.15, gMax: 1, bStar: 1100000, kappaB: 1.3 },
  buckets: [{ label: "small", repBalance: 100000, share: 0.6 }, { label: "large", repBalance: 5000000, share: 0.4 }],
};
const BETA = { betaMin: 0.45, betaMax: 0.8, k: 0.55, m: 4.0, lambda: 1 };
const BINDINGS: OverlayBinding[] = [
  { familyId: "mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY }, modelVersion: "kernel-four-factor-cpr-1" },
  { familyId: "mbs", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY }, modelVersion: "kernel-four-factor-cpr-1" },
  { familyId: "dda", overlay: { kind: "nmd-decay", params: DECAY }, modelVersion: "kernel-nmd-decay-1" },
  { familyId: "mma", overlay: { kind: "deposit-beta", params: BETA }, modelVersion: "kernel-deposit-beta-1" },
  { familyId: "acme", overlay: { kind: "registered", registeredKind: "acme-decay", params: { rate: 5 } }, modelVersion: "acme-1" },
];
const SET: AssumptionSet = { schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo base behavioral set", bindings: BINDINGS, contentHash: "h-demo" };
const OTHER: AssumptionSet = {
  schemaVersion: "1.0.0", id: "stress-v1", label: "Stress", contentHash: "h-stress",
  bindings: [{ familyId: "dda", overlay: { kind: "nmd-decay", params: { ...DECAY, closureSteady: 1.5 } }, modelVersion: "kernel-nmd-decay-1", selector: { "lcr-category": "retail-stable" } }],
};
const fresh = () => draftSet(structuredClone(SET));

/** A book restated here: the families the add form filters, a taxonomy with a declared and an open tag, and tagged dda positions. */
const BOOK = {
  id: "book-v1",
  label: "Book",
  asOf: "2026-03-31",
  coa: {
    schemaVersion: "1.0.0",
    nodes: [],
    families: [
      { id: "cash", label: "Cash", side: "asset", instrumentType: "fixed-loan", coaNodeId: "n" },
      { id: "mortgages", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "n" },
      { id: "mbs", label: "MBS", side: "asset", instrumentType: "mortgage", coaNodeId: "n" },
      { id: "dda", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "n" },
      { id: "mma", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "n" },
      { id: "cds", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: "n" },
      { id: "lines", label: "Lines", side: "asset", instrumentType: "commitment", coaNodeId: "n" },
      { id: "swaps", label: "Swaps", side: "derivative", instrumentType: "swap", coaNodeId: "n" },
    ],
  },
  taxonomy: {
    schemaVersion: "1.0.0", id: "tags-v1", label: "Tags",
    dimensions: [
      { id: "lcr-category", label: "LCR category", values: ["retail-stable", "retail-other", "operational"] },
      { id: "region", label: "Region" },
      { id: "hqla-level", label: "HQLA level", values: ["l1", "l2a"] },
    ],
  },
  positions: [
    { id: "d1", familyId: "dda", coaNodeId: "n", terms: {}, dimensions: { "lcr-category": "retail-other", region: "west" } },
    { id: "d2", familyId: "dda", coaNodeId: "n", terms: {}, dimensions: { "lcr-category": "retail-stable", region: "east" } },
    { id: "d3", familyId: "dda", coaNodeId: "n", terms: {} },
    { id: "c1", familyId: "cash", coaNodeId: "n", terms: {}, dimensions: { "hqla-level": "l1" } },
  ],
} as unknown as PortfolioSpec;

describe("the add form's pickers", () => {
  it("offers seven models in page order, the prepay kind with each of its two models", () => {
    expect(ADD_MODELS.map((m) => [m.key, m.label])).toEqual([
      ["prepay/four-factor-cpr", "Prepayment, four-factor CPR"],
      ["prepay/constant-cpr", "Prepayment, constant CPR"],
      ["nmd-decay", "Deposit decay"],
      ["deposit-beta", "Deposit repricing"],
      ["cd-rollover", "CD rollover"],
      ["commitment-draw", "Commitment draws"],
      ["loan-client-rate", "Loan client rate, flat carry"],
    ]);
  });
  it("lists only the book's families whose instrument type the kind fits, in the book's order", () => {
    const ids = (key: Parameters<typeof familyChoices>[1]) => familyChoices(BOOK, key).map((f) => f.id);
    expect(ids("prepay/four-factor-cpr")).toEqual(["mortgages", "mbs"]);
    expect(ids("prepay/constant-cpr")).toEqual(["mortgages", "mbs"]);
    expect(ids("nmd-decay")).toEqual(["dda", "mma"]);
    expect(ids("deposit-beta")).toEqual(["mma"]);
    expect(ids("cd-rollover")).toEqual(["cash", "cds"]);
    expect(ids("commitment-draw")).toEqual(["lines"]);
    expect(ids("loan-client-rate")).toEqual(["mortgages", "mbs"]);
    expect(familyChoices(BOOK, "nmd-decay")[1]).toEqual({ id: "mma", label: "MMA", instrumentType: "nmd-b" });
  });
  it("offers as chips the tags that family's positions carry: declared values in declared order, open values sorted", () => {
    expect(selectorChips(BOOK, "dda")).toEqual([
      { tag: "lcr-category", label: "LCR category", values: ["retail-stable", "retail-other"] },
      { tag: "region", label: "Region", values: ["east", "west"] },
    ]);
    expect(selectorChips(BOOK, "cash")).toEqual([{ tag: "hqla-level", label: "HQLA level", values: ["l1"] }]);
    expect(selectorChips(BOOK, "mma")).toEqual([]);
    expect(selectorChips({ ...BOOK, taxonomy: undefined } as PortfolioSpec, "dda")).toEqual([]);
  });
  it("toggles chips: one value is text, two are a list, none is the whole family", () => {
    let s = toggleChip(undefined, "lcr-category", "retail-stable");
    expect(s).toEqual({ "lcr-category": "retail-stable" });
    s = toggleChip(s, "lcr-category", "retail-other");
    expect(s).toEqual({ "lcr-category": ["retail-stable", "retail-other"] });
    s = toggleChip(s, "region", "west");
    expect(s).toEqual({ "lcr-category": ["retail-stable", "retail-other"], region: "west" });
    expect(chipOn(s, "lcr-category", "retail-other")).toBe(true);
    expect(chipOn(s, "region", "east")).toBe(false);
    s = toggleChip(toggleChip(s, "lcr-category", "retail-stable"), "region", "west");
    expect(s).toEqual({ "lcr-category": "retail-other" });
    expect(toggleChip(s, "lcr-category", "retail-other")).toBeUndefined();
  });
  it("reads a selector in words: tag and value, values of one tag joined by or, tags joined by and, in canonical order (critic I1)", () => {
    expect(selectorText(undefined)).toBe("whole family");
    expect(selectorText({})).toBe("whole family");
    expect(selectorText({ "lcr-category": "retail-stable" })).toBe("lcr-category: retail-stable");
    expect(selectorText({ "lcr-category": ["retail-stable", "retail-other"] })).toBe("lcr-category: retail-other or retail-stable");
    expect(selectorText({ region: "west", "lcr-category": ["retail-stable", "retail-other"] })).toBe("lcr-category: retail-other or retail-stable and region: west");
    expect(whereOf({ ...BINDINGS[2]!, selector: { region: ["west", "east"], "lcr-category": "operational" } })).toBe("dda, lcr-category: operational and region: east or west");
  });
  it("says what a binding will cover in one line: the whole family, or the positions its chips pick (critic I2)", () => {
    expect(bindsText(undefined)).toBe("Binds the whole family");
    expect(bindsText({ "lcr-category": "retail-stable" })).toBe("Binds positions with lcr-category: retail-stable");
    expect(bindsText({ region: "west", "lcr-category": ["retail-stable", "retail-other"] })).toBe("Binds positions with lcr-category: retail-other or retail-stable and region: west");
  });
  it("offers as starting values every stored binding of the same model, in every stored set", () => {
    expect(startChoices([SET, OTHER], "nmd-decay").map((c) => [c.id, c.label])).toEqual([
      ["demo-behavioral-v1#2", "demo-behavioral-v1: dda, whole family"],
      ["stress-v1#0", "stress-v1: dda, lcr-category: retail-stable"],
    ]);
    expect(startChoices([SET, OTHER], "cd-rollover")).toEqual([]);
    expect(startBinding(startChoices([SET], "nmd-decay"), "demo-behavioral-v1#2")).toBe(BINDINGS[2]);
    expect(startBinding(startChoices([SET], "nmd-decay"), "blank")).toBeNull();
  });
  it("does not offer a stored stack's bindings: each copies a base or layer binding offered under its own set (Polish 2 A6)", () => {
    // Shaped like the dev store's stack-ab60dc782a83 (demo-behavioral-v1 plus liquidity-stress-demo-v1): decay on dda at 2 and on mma at 4.
    const STACK: AssumptionSet = {
      ...SET, id: "stack-ab60dc782a83", label: "Stack: demo-behavioral-v1 + liquidity-stress-demo-v1",
      bindings: [...BINDINGS.slice(0, 4), { ...BINDINGS[2]!, familyId: "mma" }],
    };
    expect(startChoices([SET, STACK], "nmd-decay").map((c) => c.id)).toEqual(["demo-behavioral-v1#2"]);
  });
  it("says why Add is off: no model, no book, no fitting family, no family, a start no longer offered", () => {
    const starts = startChoices([SET], "nmd-decay");
    expect(addBlock(EMPTY_ADD, BOOK, null, [])).toBe("Pick a model");
    const decay = pickAddModel("nmd-decay");
    expect(addBlock(decay, null, "Reading book book-v1", starts)).toBe("Reading book book-v1");
    expect(addBlock(decay, null, null, starts)).toBe("Pick a book in the Book pill to list its families");
    expect(addBlock(decay, BOOK, null, starts)).toBe("Pick a family");
    expect(addBlock(pickAddFamily(decay, "cash"), BOOK, null, starts)).toBe("Pick a family");
    expect(addBlock(pickAddFamily(decay, "dda"), BOOK, null, starts)).toBeNull();
    expect(addBlock({ ...pickAddFamily(decay, "dda"), start: "gone#0" }, BOOK, null, starts)).toBe("Pick where the values start");
    const noLines = { ...BOOK, coa: { ...BOOK.coa, families: BOOK.coa.families.filter((f) => f.id !== "lines") } } as PortfolioSpec;
    expect(addBlock(pickAddModel("commitment-draw"), noLines, null, [])).toBe("Book book-v1 has no family this model fits");
  });
  it("a new model resets the family, selector and start; a new family resets the selector", () => {
    const a = { key: "nmd-decay" as const, familyId: "dda", selector: { region: "west" }, start: "demo-behavioral-v1#2" };
    expect(pickAddModel("cd-rollover")).toEqual({ key: "cd-rollover", familyId: null, selector: undefined, start: "blank" });
    expect(pickAddFamily(a, "mma")).toEqual({ key: "nmd-decay", familyId: "mma", selector: undefined, start: "demo-behavioral-v1#2" });
  });
});

describe("starting values: blank or copied, never the kernel defaults", () => {
  it("a blank start holds every field empty and every table without rows, for each of the six models", () => {
    for (const { key } of ADD_MODELS) {
      const d = newBindingDraft(key, "fam", undefined, null, 9);
      expect(Object.values(d.values).every((v) => v === ""), key).toBe(true);
      expect(Object.values(d.rows).every((r) => r.length === 0), key).toBe(true);
      expect(d.modelVersion, key).toBe("");
      expect(issuesOf(d).length, key).toBeGreaterThan(0);
    }
  });
  it("no Studio source file names a kernel defaults constant", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/MBS_DEFAULTS|NMD_DEFAULTS|BETA_S_CURVE_DEFAULTS|NMD_B_TERMS_DEFAULTS|BALANCE_SENS_DEFAULTS/);
    }
  });
  it("a blank binding holds Save off until every field passes; the model version is asked for first", () => {
    const d = addBinding(fresh(), "cd-rollover", "cds", undefined, null);
    const card = d.bindings[5]!;
    expect([card.key, card.sourceIndex, card.versionOpen, card.schemaKey]).toEqual([5, null, true, "cd-rollover"]);
    expect(issuesOf(card).map((i) => `${i.path}: ${i.message}`)).toEqual([
      "modelVersion: Enter a model version",
      "renewalProbability: Enter a number",
      "offeredSpreadBp: Enter a number",
      "termMonths: Enter a number",
    ]);
    expect(saveBlock(d, false, null)).toBe("Off: 4 fields need a fix");
    expect(fieldsToFix(d)[0]).toEqual({ label: "cds, whole family: Model version", target: "edit-5-modelVersion" });
    let filled = setModelVersion(d, 5, "studio-cd-rollover-1");
    filled = setValue(setValue(setValue(filled, 5, "renewalProbability", "0.6"), 5, "offeredSpreadBp", "25"), 5, "termMonths", "12");
    expect(saveBlock(filled, false, null)).toBeNull();
    expect(savePayload(filled, "x-edit-1").bindings[5]).toEqual({
      familyId: "cds",
      overlay: { kind: "cd-rollover", renewalProbability: 0.6, offeredSpreadBp: 25, termMonths: 12 },
      modelVersion: "studio-cd-rollover-1",
    });
  });
  it("a blank decay binding needs a bucket row: the table rule points at its Add row button", () => {
    const d = addBinding(fresh(), "nmd-decay", "mma", undefined, null);
    expect(issuesOf(d.bindings[5]!).filter((i) => i.path === "params.buckets")).toEqual([
      { path: "params.buckets", label: "Account-size buckets", message: "needs at least 1 row" },
    ]);
    expect(fieldsToFix(d).find((x) => x.target === "edit-5-params.buckets")?.label).toBe("mma, whole family: Account-size buckets");
  });
  it("a copied start takes the stored binding's values, rows and model version; the payload carries the picked family and selector", () => {
    const d = addBinding(fresh(), "nmd-decay", "mma", { "lcr-category": "retail-stable" }, BINDINGS[2]!);
    const card = d.bindings[5]!;
    expect(card.values["params.closureSteady"]).toBe("0.75");
    expect(card.rows["params.buckets"]!.map((r) => r.cells)).toEqual([
      { label: "small", repBalance: "100000", share: "0.6" },
      { label: "large", repBalance: "5000000", share: "0.4" },
    ]);
    expect(card.modelVersion).toBe("kernel-nmd-decay-1");
    expect(issuesOf(card)).toEqual([]);
    expect(saveBlock(d, false, null)).toBeNull();
    expect(savePayload(d, "x-edit-1").bindings[5]).toEqual({
      familyId: "mma", overlay: { kind: "nmd-decay", params: DECAY }, modelVersion: "kernel-nmd-decay-1", selector: { "lcr-category": "retail-stable" },
    });
    // The copy is a start, not a link: an edit on the new card leaves the stored binding it came from alone.
    const edited = setCell(d, 5, "params.buckets", 0, "share", "0.5");
    expect((savePayload(edited, "x").bindings[2]!.overlay as unknown as { params: typeof DECAY }).params.buckets[0]!.share).toBe(0.6);
    expect((savePayload(edited, "x").bindings[5]!.overlay as unknown as { params: typeof DECAY }).params.buckets[0]!.share).toBe(0.5);
  });
  it("an added binding is one line in Changes, naming its model", () => {
    const d = addBinding(fresh(), "nmd-decay", "mma", { "lcr-category": "retail-stable" }, BINDINGS[2]!);
    expect(changesOf(d).map(changeLine)).toEqual(["mma, lcr-category: retail-stable: Deposit decay binding: added"]);
  });
});

describe("removing a binding", () => {
  it("drops it from the payload and lists it once as removed; the rest keep their stored form", () => {
    const d = removeBinding(fresh(), 3);
    expect(changesOf(d).map(changeLine)).toEqual(["mma, whole family: Deposit repricing binding: removed"]);
    expect(saveBlock(d, false, null)).toBeNull();
    const p = savePayload(d, "x-edit-1");
    expect(p.bindings).toEqual([BINDINGS[0], BINDINGS[1], BINDINGS[2], BINDINGS[4]]);
  });
  it("removing an added binding leaves no line at all", () => {
    const d = removeBinding(addBinding(fresh(), "cd-rollover", "cds", undefined, null), 5);
    expect(changesOf(d)).toEqual([]);
    expect(saveBlock(d, false, null)).toBe("Off: nothing has changed");
  });
  it("moves focus to a removed stored card's Restore; after an added card, to the next card's Remove in page order, passing over a plugin card, else to Add a binding (Polish 2 M5)", () => {
    const d = fresh();
    // Page order: Prepayment (0, 1), Deposit decay (2), Deposit repricing (3), Plugin kinds (4).
    expect(focusAfterRemoveBinding(d, 0)).toBe(restoreBindingId(0));
    expect(focusAfterRemoveBinding(d, 3)).toBe("restore-binding-3");
    expect(ADD_BINDING_ID).toBe("add-binding");
    // Added cards: a decay card (index 5) follows dda in its group, so the beta card's Remove comes next; a CD card
    // (index 6) is followed only by the plugin card, so focus goes to Add a binding.
    const added = addBinding(addBinding(d, "nmd-decay", "mma", undefined, null), "cd-rollover", "cds", undefined, null);
    expect(focusAfterRemoveBinding(added, 5)).toBe(removeBindingId(3));
    expect(focusAfterRemoveBinding(added, 6)).toBe(ADD_BINDING_ID);
    // Keys follow the card, not its index: after a removal the next card keeps its key.
    const after = removeBinding(d, 0);
    expect(after.bindings.map((b) => b.key)).toEqual([1, 2, 3, 4]);
    expect(focusAfterRemoveBinding(after, 0)).toBe("restore-binding-1");
    // An added card takes a key no card has had.
    expect(addBinding(after, "cd-rollover", "cds", undefined, null).bindings[4]!.key).toBe(5);
  });
});

describe("switching the prepay model", () => {
  it("only a prepay binding switches, to its other model", () => {
    const d = fresh();
    expect(switchTargets(d.bindings[0]!)).toEqual(["prepay/constant-cpr"]);
    expect(switchTargets(switchModel(d, 0, "prepay/constant-cpr", null).bindings[0]!)).toEqual(["prepay/four-factor-cpr"]);
    expect(switchTargets(d.bindings[2]!)).toEqual([]);
    expect(switchTargets(d.bindings[4]!)).toEqual([]);
  });
  it("replaces the overlay: the new model's fields start blank and the model version is asked for again", () => {
    const d = switchModel(fresh(), 1, "prepay/constant-cpr", null);
    const card = d.bindings[1]!;
    expect([card.schemaKey, card.versionOpen, card.modelVersion, card.values]).toEqual(["prepay/constant-cpr", true, "", { annualCpr: "" }]);
    expect(changesOf(d).map(changeLine)).toEqual([
      "mbs, whole family: Model: Four-factor CPR -> Constant CPR",
      "mbs, whole family: Model version: kernel-four-factor-cpr-1 -> blank",
    ]);
    expect(saveBlock(d, false, null)).toBe("Off: 2 fields need a fix");
    const filled = setValue(setModelVersion(d, 1, "studio-constant-cpr-1"), 1, "annualCpr", "0.08");
    expect(changesOf(filled).map(changeLine)).toEqual([
      "mbs, whole family: Model: Four-factor CPR -> Constant CPR",
      "mbs, whole family: Model version: kernel-four-factor-cpr-1 -> studio-constant-cpr-1",
      "mbs, whole family: Annual CPR: none -> 0.08",
    ]);
    expect(savePayload(filled, "x-edit-1").bindings[1]).toEqual({
      familyId: "mbs", overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.08 }, modelVersion: "studio-constant-cpr-1",
    });
  });
  it("switching back with the stored binding as the start is no change at all", () => {
    const there = switchModel(fresh(), 0, "prepay/constant-cpr", null);
    const back = switchModel(there, 0, "prepay/four-factor-cpr", BINDINGS[0]!);
    expect(changesOf(back)).toEqual([]);
    expect(savePayload(back, "x").bindings[0]).toEqual(BINDINGS[0]);
  });
  it("keeps a selector through a switch", () => {
    const withSelector: AssumptionSet = { ...SET, bindings: [{ ...BINDINGS[0]!, selector: { region: "west" } }] };
    const d = setValue(setModelVersion(switchModel(draftSet(withSelector), 0, "prepay/constant-cpr", null), 0, "v1"), 0, "annualCpr", "0.05");
    expect(savePayload(d, "x").bindings[0]!.selector).toEqual({ region: "west" });
  });
});

describe("the Save id while the set list is read again (critic M5)", () => {
  it("keeps the last list read, the set on screen and every id this page saved as taken", () => {
    const last = [{ id: "demo-behavioral-v1" }, { id: "demo-behavioral-v1-edit-1" }];
    expect([...takenIds(last, "demo-behavioral-v1", new Set(["demo-behavioral-v1-edit-2"]))].sort()).toEqual([
      "demo-behavioral-v1", "demo-behavioral-v1-edit-1", "demo-behavioral-v1-edit-2",
    ]);
    expect(saveIdFor("demo-behavioral-v1", last, new Set(["demo-behavioral-v1-edit-2"]))).toBe("demo-behavioral-v1-edit-3");
    // The saved set is on screen before the list read that lists it lands.
    expect(saveIdFor("demo-behavioral-v1-edit-2", last, new Set(["demo-behavioral-v1-edit-2"]))).toBe("demo-behavioral-v1-edit-3");
  });
  it("names no id before the list has been read once, and Save says why it is off", () => {
    expect(saveIdFor("demo-behavioral-v1", null, new Set())).toBeNull();
    expect(saveIdFor(null, [], new Set())).toBeNull();
    expect(saveBlock(removeBinding(fresh(), 3), false, null, false)).toBe("Reading the set list");
    expect(saveBlock(removeBinding(fresh(), 3), false, null, true)).toBeNull();
  });
});
