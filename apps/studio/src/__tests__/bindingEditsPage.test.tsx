// apps/studio/src/__tests__/bindingEditsPage.test.tsx
/**
 * ALM Studio Piece 4b: the set editor's binding edits as rendered, with
 * renderToStaticMarkup (no DOM, no effects). Expected texts are restated here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet, PortfolioSpec } from "@alm/engine";
import { ApiError } from "@alm/reader";
import { AddBindingForm, addPanelKey, EditSetView, storedNoteOf, type AddBindingFormProps, type EditSetViewProps } from "../pages/assumptions/EditSetPage";
import { addBinding, draftSet, EMPTY_ADD, pickAddFamily, pickAddModel, switchModel } from "../assumptions/setEditModel";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const SET: AssumptionSet = {
  schemaVersion: "1.0.0",
  id: "squeeze",
  label: "Squeeze",
  bindings: [
    { familyId: "acme", overlay: { kind: "registered", registeredKind: "acme-decay", params: { rate: 5 } }, modelVersion: "acme-1" },
    { familyId: "mortgages", overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.06 }, modelVersion: "kernel-constant-cpr-1" },
    { familyId: "lines", overlay: { kind: "commitment-draw", rampRates: [0.35], steadyRate: 0.02 }, modelVersion: "engine-commitment-draw-1" },
  ],
};
const OTHER: AssumptionSet = {
  schemaVersion: "1.0.0", id: "demo", label: "Demo",
  bindings: [{ familyId: "mbs", overlay: { kind: "prepay", model: "four-factor-cpr", params: { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 } }, modelVersion: "kernel-four-factor-cpr-1" }],
};
const BOOK = {
  id: "book-v1", label: "Book", asOf: "2026-03-31",
  coa: {
    schemaVersion: "1.0.0", nodes: [],
    families: [
      { id: "dda", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "n" },
      { id: "mma", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "n" },
      { id: "cds", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: "n" },
    ],
  },
  taxonomy: { schemaVersion: "1.0.0", id: "t", label: "T", dimensions: [{ id: "lcr-category", label: "LCR category", values: ["retail-stable", "retail-other"] }] },
  positions: [{ id: "d1", familyId: "dda", coaNodeId: "n", terms: {}, dimensions: { "lcr-category": "retail-stable" } }],
} as unknown as PortfolioSpec;

const base: EditSetViewProps = {
  sets: [{ id: "squeeze", label: "Squeeze", contentHash: "h" }],
  selected: "squeeze",
  draft: draftSet(SET),
  reading: false,
  loadError: null,
  listNote: null,
  saving: null,
  saveId: "squeeze-edit-1",
  note: null,
  book: BOOK,
  bookId: "book-v1",
  bookNote: null,
  stored: [SET, OTHER],
  storedNote: null,
  onPick() {}, onDraft() {}, onSave() {}, onReread() {},
};
const render = (over: Partial<EditSetViewProps> = {}) => renderToStaticMarkup(<EditSetView {...base} {...over} />);
const form = (over: Partial<AddBindingFormProps> = {}) =>
  renderToStaticMarkup(<AddBindingForm value={EMPTY_ADD} book={BOOK} bookNote={null} stored={[SET, OTHER]} storedNote={null} onChange={() => {}} onAdd={() => {}} onCancel={() => {}} {...over} />);
/** The add form's commit: "Add binding" until a model and a family are picked, then "Add <model> on <family>" (Polish 2 M1). */
const addButton = (html: string) => html.match(/<button[^>]*>Add (?:binding|[^<]+ on [^<]+)<\/button>/)![0];

describe("binding cards (Piece 4b)", () => {
  it("gives each editable card one Remove button, named for its card and keyed for focus; a plugin card has none", () => {
    const html = render();
    expect(html).toContain('id="remove-binding-1" aria-label="Remove Constant CPR, mortgages, whole family">Remove</button>');
    expect(html).toContain('id="remove-binding-2" aria-label="Remove Commitment draws, lines, whole family">Remove</button>');
    expect(html).not.toContain("remove-binding-0");
  });
  it("offers a prepay card one quiet Switch model in its head beside Remove; the picker is a second step (Polish 2 M2)", () => {
    const html = render();
    expect(html).toContain('<div class="card-head-actions"><button type="button" class="btn btn-quiet" id="switch-model-1" aria-label="Switch model of Constant CPR, mortgages, whole family">Switch model</button>'
      + '<button type="button" class="btn btn-quiet" id="remove-binding-1" aria-label="Remove Constant CPR, mortgages, whole family">Remove</button></div>');
    expect(text(html).match(/Switch model/g)).toHaveLength(1);
    expect(text(html)).not.toContain("Switch to");
  });
  it("after a switch, the card asks for a model version beside the new model's fields", () => {
    const html = render({ draft: switchModel(draftSet(SET), 1, "prepay/four-factor-cpr", null) });
    expect(html).toContain('for="edit-1-modelVersion">Model version</label>');
    expect(html).toContain('id="edit-1-modelVersion"');
    expect(text(html)).toContain("Four-factor CPR, mortgages, whole family");
    expect(text(html)).toContain("Model version Enter a model version Names the model's form; it travels into each run's provenance.");
    expect(text(html)).toContain("Changes mortgages, whole family: Model: Constant CPR -> Four-factor CPR");
  });
  it("marks an added card as new, with its model version input first", () => {
    const html = render({ draft: addBinding(draftSet(SET), "cd-rollover", "cds", undefined, null) });
    const t = text(html);
    expect(t).toContain("CD rollover CD rollover, cds, whole family New binding Remove");
    expect(html).toContain('id="remove-binding-3"');
    expect(html).toContain('id="edit-3-modelVersion"');
    expect(t).toContain("Changes cds, whole family: CD rollover binding: added");
    expect(t).toContain("Off: 4 fields need a fix");
  });
  it("names an added binding with a selector in words, not JSON, in its title, Remove name and Changes (critic I1)", () => {
    const html = render({ draft: addBinding(draftSet(SET), "cd-rollover", "cds", { "lcr-category": ["retail-stable", "retail-other"] }, null) });
    const t = text(html);
    expect(t).toContain("CD rollover, cds, lcr-category: retail-other or retail-stable New binding Remove");
    expect(html).toContain('aria-label="Remove CD rollover, cds, lcr-category: retail-other or retail-stable">Remove</button>');
    expect(t).toContain("Changes cds, lcr-category: retail-other or retail-stable: CD rollover binding: added");
    expect(html).not.toContain("&quot;lcr-category&quot;");
  });
  it("puts the Add a binding button after the cards and before Changes and Save", () => {
    const html = render({ draft: addBinding(draftSet(SET), "cd-rollover", "cds", undefined, null) });
    expect(html).toContain('<button type="button" class="btn" id="add-binding">Add a binding</button>');
    expect(html.indexOf('id="add-binding"')).toBeLessThan(html.indexOf('aria-label="Changes"'));
    expect(html.indexOf('aria-label="Changes"')).toBeLessThan(html.indexOf("btn-primary"));
  });
  it("names no Save id before the set list has been read once (critic M5)", () => {
    const html = render({ saveId: null, draft: addBinding(draftSet(SET), "cd-rollover", "cds", undefined, null) });
    expect(text(html.match(/<button[^>]*btn-primary[^>]*>[\s\S]*?<\/button>/)![0])).toBe("Save");
    expect(text(html)).toContain("Reading the set list");
  });
});

describe("the add form (Piece 4b)", () => {
  it("starts with the model and Add off, saying why", () => {
    const t = text(form());
    expect(t).toContain("Add a binding Model Pick a model Prepayment, four-factor CPR Prepayment, constant CPR Deposit decay Deposit repricing CD rollover Commitment draws");
    expect(addButton(form())).toContain('aria-disabled="true"');
    expect(t).toContain("Pick a model");
  });
  it("lists only the book's families the model fits, and says which book", () => {
    const t = text(form({ value: pickAddModel("nmd-decay") }));
    expect(t).toContain("Family in book-v1 Pick a family dda: DDA mma: MMA");
    expect(t).not.toContain("cds: CDs");
    expect(text(form({ value: pickAddModel("cd-rollover") }))).toContain("Pick a family cds: CDs");
  });
  it("without a book names what is missing instead of a family list", () => {
    const t = text(form({ value: pickAddModel("nmd-decay"), book: null, bookNote: "Pick a book in the Book pill to list its families" }));
    expect(t).not.toContain("Family in");
    expect(t).toContain("Pick a book in the Book pill to list its families");
  });
  it("offers the family's tags as chips, none pressed: the live line says the whole family", () => {
    const html = form({ value: pickAddFamily(pickAddModel("nmd-decay"), "dda") });
    expect(text(html)).toContain("Selector LCR category retail-stable Binds the whole family");
    expect(html).toContain('<button type="button" class="pill" aria-pressed="false">retail-stable</button>');
    expect(html).toContain('<p class="card-desc" aria-live="polite">Binds the whole family</p>');
    expect(html).not.toContain(">retail-other</button>");
    const on = form({ value: { ...pickAddFamily(pickAddModel("nmd-decay"), "dda"), selector: { "lcr-category": "retail-stable" } } });
    expect(addButton(on)).not.toContain("aria-disabled");
  });
  it("a pressed chip carries a check glyph as well as colour, and the live line names what the binding covers (critic I2)", () => {
    const on = form({ value: { ...pickAddFamily(pickAddModel("nmd-decay"), "dda"), selector: { "lcr-category": "retail-stable" } } });
    expect(on).toContain('aria-pressed="true"><span class="chip-check" aria-hidden="true">✓</span>retail-stable</button>');
    expect(on).toContain('<p class="card-desc" aria-live="polite">Binds positions with lcr-category: retail-stable</p>');
    expect(on).not.toContain("no chip binds");
    const two = form({ value: { ...pickAddFamily(pickAddModel("nmd-decay"), "dda"), selector: { "lcr-category": ["retail-stable", "retail-other"] } } });
    expect(text(two)).toContain("Binds positions with lcr-category: retail-other or retail-stable");
  });
  it("says so when the family's positions carry no tags", () => {
    expect(text(form({ value: pickAddFamily(pickAddModel("nmd-decay"), "mma") }))).toContain("This family's positions carry no tags in book-v1; the binding covers the whole family.");
  });
  it("starts the values blank or from a stored binding of the same model", () => {
    expect(text(form({ value: pickAddModel("prepay/four-factor-cpr") }))).toContain("Start the values from Blank demo: mbs, whole family");
    expect(text(form({ value: pickAddModel("prepay/constant-cpr") }))).toContain("Start the values from Blank squeeze: mortgages, whole family");
    expect(text(form({ value: pickAddModel("cd-rollover") }))).toContain("Start the values from Blank Add binding");
  });
});

describe("stored sets that could not be read (Task 5 fix I2)", () => {
  it("says how many stored sets are missing, and nothing while they are read or when all were read", () => {
    expect(storedNoteOf({ state: "loading" })).toBeNull();
    expect(storedNoteOf({ state: "ok", value: { sets: [SET], unread: 0 } })).toBeNull();
    expect(storedNoteOf({ state: "ok", value: { sets: [SET], unread: 1 } })).toBe("1 stored set could not be read; it is not offered as a starting value.");
    expect(storedNoteOf({ state: "ok", value: { sets: [], unread: 2 } })).toBe("2 stored sets could not be read; they are not offered as starting values.");
  });
  it("carries the error text when the whole read fails, never an empty list alone", () => {
    expect(storedNoteOf({ state: "error", error: new ApiError(500, "store_unreadable", "store offline") }))
      .toBe("The stored sets could not be read, so none is offered as a starting value. 500: store offline");
    expect(storedNoteOf({ state: "error", error: new TypeError("Failed to fetch") }))
      .toBe("The stored sets could not be read, so none is offered as a starting value. The platform could not be reached. Is it running?");
  });
  it("shows the note under the starting-values choice once a model is picked, tied to it for a screen reader", () => {
    const note = "2 stored sets could not be read; they are not offered as starting values.";
    const html = form({ value: pickAddModel("prepay/constant-cpr"), storedNote: note });
    expect(text(html)).toContain(`Start the values from Blank squeeze: mortgages, whole family ${note}`);
    // Tied to the choice, not live: it changes with no keystroke of its own (Polish 2 C5).
    const id = html.match(/<p class="card-desc" id="([^"]+)">2 stored sets/)![1];
    expect(html).toContain(`<select aria-describedby="${id}">`);
    expect(text(form({ storedNote: note }))).not.toContain("could not be read");
  });
});

describe("a Book pill switch starts the add form over (final review I1)", () => {
  // The panel's React key cannot be read through renderToStaticMarkup, so this tests the key the view gives it.
  it("keys the add panel on the book as well as the set", () => {
    expect(addPanelKey("squeeze", "synthetic-2500-lcr-v1")).not.toBe(addPanelKey("squeeze", "synthetic-2500-v1"));
    expect(addPanelKey("squeeze", "synthetic-2500-lcr-v1")).not.toBe(addPanelKey("squeeze", null));
    expect(addPanelKey("squeeze", "synthetic-2500-v1")).not.toBe(addPanelKey("other", "synthetic-2500-v1"));
    expect(addPanelKey("squeeze", "synthetic-2500-v1")).toBe(addPanelKey("squeeze", "synthetic-2500-v1"));
  });
});
