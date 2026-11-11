// apps/studio/src/__tests__/polish2Page.test.tsx
/**
 * ALM Studio Polish 2: the Edit a set fixes as rendered, with
 * renderToStaticMarkup (no DOM, no effects). Expected texts are restated here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet, PortfolioSpec } from "@alm/engine";
import {
  AddBindingForm, AddBindingPanelView, cardKey, EditSetView, focusAfterStart, SwitchModelView, type AddBindingFormProps, type AddBindingPanelViewProps, type EditSetViewProps,
  type SwitchModelViewProps,
} from "../pages/assumptions/EditSetPage";
import { addBinding, draftSet, EMPTY_ADD, pickAddFamily, pickAddModel, removeBinding, START_BLANK, switchModel } from "../assumptions/setEditModel";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const PREPAY = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const DEMO: AssumptionSet = {
  schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo base behavioral set",
  bindings: [
    { familyId: "mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY }, modelVersion: "kernel-four-factor-cpr-1" },
    { familyId: "mma", overlay: { kind: "deposit-beta", params: { betaMin: 0.45, betaMax: 0.8, k: 0.55, m: 4.0, lambda: 1 } }, modelVersion: "kernel-deposit-beta-1" },
  ],
};
const FAMILIES = [
  { id: "mortgages", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "n" },
  { id: "dda", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "n" },
  { id: "mma", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "n" },
];
/** A book with no taxonomy, and one whose dda positions carry a tag, restated here. */
const PLAIN = { id: "book-plain", label: "Plain", asOf: "2026-03-31", coa: { schemaVersion: "1.0.0", nodes: [], families: FAMILIES }, positions: [] } as unknown as PortfolioSpec;
const TAGGED = {
  ...PLAIN,
  id: "book-tagged",
  taxonomy: { schemaVersion: "1.0.0", id: "t", label: "T", dimensions: [{ id: "lcr-category", label: "LCR category", values: ["retail-stable"] }] },
  positions: [{ id: "d1", familyId: "dda", coaNodeId: "n", terms: {}, dimensions: { "lcr-category": "retail-stable" } }],
} as unknown as PortfolioSpec;

const base: EditSetViewProps = {
  sets: [{ id: "demo-behavioral-v1", label: "Demo base behavioral set", contentHash: "h" }],
  selected: "demo-behavioral-v1",
  draft: draftSet(DEMO),
  reading: false,
  loadError: null,
  listNote: null,
  saving: null,
  saveId: "demo-behavioral-v1-edit-1",
  note: null,
  book: PLAIN,
  bookId: "book-plain",
  bookNote: null,
  stored: [DEMO],
  storedNote: null,
  onPick() {}, onDraft() {}, onSave() {}, onReread() {},
};
const render = (over: Partial<EditSetViewProps> = {}) => renderToStaticMarkup(<EditSetView {...base} {...over} />);
const form = (over: Partial<AddBindingFormProps> = {}) =>
  renderToStaticMarkup(<AddBindingForm value={EMPTY_ADD} book={PLAIN} bookNote={null} stored={[DEMO]} storedNote={null} onChange={() => {}} onAdd={() => {}} onCancel={() => {}} {...over} />);
const panel = (over: Partial<AddBindingPanelViewProps> = {}) =>
  renderToStaticMarkup(<AddBindingPanelView adding={null} book={PLAIN} bookNote={null} stored={[DEMO]} storedNote={null} onOpen={() => {}} onChange={() => {}} onAdd={() => {}} onCancel={() => {}} {...over} />);
const switcher = (over: Partial<SwitchModelViewProps> = {}) =>
  renderToStaticMarkup(<SwitchModelView cardKey={0} name="Four-factor CPR, mortgages, whole family" target="prepay/constant-cpr" open={false} start={START_BLANK} starts={[]} storedNote={null}
    onOpen={() => {}} onStart={() => {}} onSwitch={() => {}} onCancel={() => {}} {...over} />);

describe("a failed read of the set list keeps the editor (A2)", () => {
  const note = "The set list was not read again; the list shown is the last one read. The platform could not be reached. Is it running?";
  const alert = `<section class="card unobs-panel" role="alert"><span class="status status-unobs">Set list not read</span><p class="unobs-text">${note}</p>`
    + '<button type="button" class="btn">Read the list again</button></section>';
  it("shows the note as one alert with the Set list not read tag and Read the list again, under Save and its fix list (Task 8 critic I2)", () => {
    const html = render({ listNote: note });
    expect(html).toContain(alert);
    expect(html).toContain("btn-primary");
    expect(html.indexOf("Read the list again")).toBeGreaterThan(html.indexOf("btn-primary"));
    expect(html.indexOf("Read the list again")).toBeGreaterThan(html.indexOf('aria-label="Prepayment"'));
    const fixing = render({ listNote: note, draft: addBinding(draftSet(DEMO), "nmd-decay", "mma", undefined, null) });
    expect(fixing.indexOf('class="fix-list"')).toBeGreaterThan(-1);
    expect(fixing.indexOf("Read the list again")).toBeGreaterThan(fixing.indexOf('class="fix-list"'));
    expect(render()).not.toContain("Read the list again");
  });
  it("keeps the alert with no set picked, where there is no Save", () => {
    const html = render({ listNote: note, selected: null, draft: null, saveId: null });
    expect(html).toContain(alert);
    expect(html).not.toContain("btn-primary");
  });
  it("gives Save and the set picker the ids Read the list again hands focus to (drive X1)", () => {
    expect(render()).toMatch(/<button type="button" class="btn btn-primary" id="edit-set-save"/);
    expect(render()).toContain('<select id="edit-set-pick" aria-label="Assumption set">');
  });
});

describe("the switch control (A3, M2)", () => {
  it("closed, is one quiet Switch model button named for its card, with no picker", () => {
    const html = switcher();
    expect(html).toBe('<button type="button" class="btn btn-quiet" id="switch-model-0" aria-label="Switch model of Four-factor CPR, mortgages, whole family">Switch model</button>');
    expect(html).not.toContain("<select");
  });
  it("open with nothing to copy, says it starts blank beside the confirm and Cancel, and that switching replaces the values (Task 8 critic M1)", () => {
    const html = switcher({ open: true });
    expect(text(html)).toBe("Starts blank Switch to Constant CPR Cancel Switching replaces the values in this card.");
    const warnId = html.match(/<span class="field-help" id="([^"]+)">Switching replaces the values in this card.<\/span>/)![1];
    expect(html).toContain(`id="switch-confirm-0" aria-describedby="${warnId}">Switch to Constant CPR</button>`);
    expect(html).not.toContain("<select");
  });
  it("open with a stale start and nothing to copy, still offers the picker so Blank can be picked (Task 5 review)", () => {
    const html = switcher({ open: true, start: "gone#0" });
    expect(html).toContain('<select id="switch-start-0">');
    expect(html).toContain('<option value="blank">Blank</option>');
    expect(text(html)).toContain("Pick where the values start");
    expect(text(html)).not.toContain("Starts blank");
  });
  it("open with stored bindings to copy, offers them, and ties the unread-sets note to the choice as plain text", () => {
    const starts = [{ id: "demo#0", label: "demo: mortgages, whole family", binding: DEMO.bindings[0]! }];
    const note = "1 stored set could not be read; it is not offered as a starting value.";
    const html = switcher({ open: true, target: "prepay/four-factor-cpr", starts, storedNote: note });
    expect(text(html)).toContain(`Start the Four-factor CPR fields from Blank demo: mortgages, whole family Switch to Four-factor CPR Cancel Switching replaces the values in this card. ${note}`);
    const noteId = html.match(/<span class="field-help" id="([^"]+)">1 stored set could not be read/)![1];
    expect(html).toContain(`<select id="switch-start-0" aria-describedby="${noteId}">`);
    expect(html).not.toMatch(/role="status"[^>]*>1 stored set/);
    const warnId = html.match(/<span class="field-help" id="([^"]+)">Switching replaces the values in this card.<\/span>/)![1];
    expect(html).toContain(`id="switch-confirm-0" aria-describedby="${warnId}">Switch to Four-factor CPR</button>`);
  });
  it("hands focus to the confirm when Blank on a stale start leaves no picker, and leaves it on the select otherwise (final review I1)", () => {
    expect(focusAfterStart(3, START_BLANK, 0)).toBe("switch-confirm-3");
    expect(focusAfterStart(3, START_BLANK, 1)).toBeNull();
    expect(focusAfterStart(3, "demo#0", 1)).toBeNull();
    expect(focusAfterStart(3, "gone#0", 0)).toBeNull();
    // The render after that pick: no select, and the confirm carries the id focus goes to.
    const html = switcher({ cardKey: 3, open: true, start: START_BLANK });
    expect(html).not.toContain("<select");
    expect(html).toContain('id="switch-confirm-3"');
  });
  it("holds the confirm off, with the reason tied to it, while the start picked is no longer offered", () => {
    const html = switcher({ open: true, start: "gone#0" });
    const reasonId = html.match(/<span class="muted" id="([^"]+)" role="status">Pick where the values start<\/span>/)![1];
    const warnId = html.match(/<span class="field-help" id="([^"]+)">Switching replaces the values in this card.<\/span>/)![1];
    expect(html).toContain(`id="switch-confirm-0" aria-disabled="true" aria-describedby="${reasonId} ${warnId}">Switch to Constant CPR</button>`);
  });
  it("sits in the card head beside Remove, and the card carries Model switched after a switch (M4)", () => {
    const html = render();
    expect(html).toContain('<div class="card-head-actions"><button type="button" class="btn btn-quiet" id="switch-model-0"');
    expect(html.indexOf('id="switch-model-0"')).toBeLessThan(html.indexOf('id="remove-binding-0"'));
    const switched = render({ draft: switchModel(draftSet(DEMO), 0, "prepay/constant-cpr", null) });
    expect(switched).toContain('Constant CPR, mortgages, whole family <span class="chip chip-edited">Model switched</span>');
  });
  it("keys each card by its set and card, so an adopted set starts every switch pick over", () => {
    expect(cardKey("demo-behavioral-v1", 0)).not.toBe(cardKey("demo-behavioral-v1-edit-1", 0));
    expect(cardKey("demo-behavioral-v1", 0)).toBe(cardKey("demo-behavioral-v1", 0));
  });
});

describe("the add form and its control (A7, M1, M6)", () => {
  it("closed, is the one Add a binding button; open, the form alone, its Model select carrying the control's id", () => {
    expect(panel()).toBe('<div class="sheet-actions"><button type="button" class="btn" id="add-binding">Add a binding</button></div>');
    const open = panel({ adding: EMPTY_ADD });
    expect(open).not.toContain(">Add a binding</button>");
    expect(open).toContain('<select id="add-binding">');
    expect(text(open)).toContain("Add binding Cancel");
  });
  it("names the commit Add <model> on <family> once both are picked", () => {
    expect(form({ value: pickAddFamily(pickAddModel("nmd-decay"), "dda") })).toContain(">Add Deposit decay on dda</button>");
  });
  it("says the family carries no tags even while a stale start holds Add off", () => {
    const t = text(form({ value: { ...pickAddFamily(pickAddModel("nmd-decay"), "dda"), start: "gone#0" } }));
    expect(t).toContain("This family's positions carry no tags in book-plain; the binding covers the whole family.");
    expect(t).toContain("Pick where the values start");
  });
  it("sets a chip group's label at the legend's size, as help text", () => {
    expect(form({ value: pickAddFamily(pickAddModel("nmd-decay"), "dda"), book: TAGGED })).toContain('<span class="field-help">LCR category</span>');
  });
});

describe("the fix list and Remove (M3, M5)", () => {
  it("lists a blank decay binding's 17 open fields as one button", () => {
    const html = render({ book: PLAIN, draft: addBinding(draftSet(DEMO), "nmd-decay", "mma", undefined, null) });
    expect(text(html)).toContain("Off: 17 fields need a fix Deposit decay, mma, whole family: 17 fields to fix");
    expect(html.match(/<ul class="fix-list"[\s\S]*?<\/ul>/)![0].match(/<li>/g)).toHaveLength(1);
  });
  it("leaves a placeholder with Restore where a removed stored card was", () => {
    const html = render({ draft: removeBinding(draftSet(DEMO), 0) });
    expect(html).toContain('<article class="card" aria-label="Four-factor CPR, mortgages, whole family: removed"><div class="card-head"><span class="muted">Four-factor CPR, mortgages, whole family: removed</span>'
      + '<button type="button" class="btn btn-quiet" id="restore-binding-0" aria-label="Restore Four-factor CPR, mortgages, whole family">Restore</button></div></article>');
    expect(text(html)).toContain("Changes mortgages, whole family: Four-factor CPR binding: removed");
  });
});
