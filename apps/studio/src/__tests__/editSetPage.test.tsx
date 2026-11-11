// apps/studio/src/__tests__/editSetPage.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { ChangesList, EditSetView, type EditSetViewProps } from "../pages/assumptions/EditSetPage";
import { addRow, draftSet, removeRow, setCell, setValue } from "../assumptions/setEditModel";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/\s+/g, " ").trim();

const SET: AssumptionSet = {
  schemaVersion: "1.0.0",
  id: "squeeze",
  label: "Squeeze",
  bindings: [
    { familyId: "acme", overlay: { kind: "registered", registeredKind: "acme-decay", params: { rate: 5 } }, modelVersion: "acme-1" },
    { familyId: "lines", overlay: { kind: "commitment-draw", rampRates: [0.35, 0.15], steadyRate: 0.02 }, modelVersion: "engine-commitment-draw-1" },
    {
      familyId: "dda",
      overlay: {
        kind: "nmd-decay",
        params: {
          closureSteady: 5, closureInitial: 5, closureTauMonths: 24, burnoutLambda: 0.1, maxRateDecay: 0, maxRateGrowth: 0, logisticK: 2, logisticMidpoint: 0,
          maPeriod: 24, regimeAlpha: 2, balanceSize: 1000000, sens: { gMin: 0.15, gMax: 1, bStar: 1100000, kappaB: 1.3 },
          buckets: [{ label: "small", repBalance: 100000, share: 0.6 }, { label: "large", repBalance: 5000000, share: 0.4 }],
        },
      },
      modelVersion: "kernel-nmd-decay-1",
    },
  ],
};
const base: EditSetViewProps = {
  sets: [{ id: "squeeze", label: "Squeeze", contentHash: "h" }, { id: "other", label: "other", contentHash: "h2" }],
  selected: "squeeze",
  draft: draftSet(SET),
  reading: false,
  loadError: null,
  listNote: null,
  saving: null,
  saveId: "squeeze-edit-1",
  note: null,
  book: null,
  bookId: null,
  bookNote: "Pick a book in the Book pill to list its families",
  stored: [],
  storedNote: null,
  onPick() {}, onDraft() {}, onSave() {}, onReread() {},
};
const render = (over: Partial<EditSetViewProps> = {}) => renderToStaticMarkup(<EditSetView {...base} {...over} />);
const saveButton = (html: string) => html.match(/<button[^>]*btn-primary[^>]*>[\s\S]*?<\/button>/)![0];

describe("EditSetView", () => {
  it("with no set picked shows the picker only: no form, no Save", () => {
    const html = render({ selected: null, draft: null, saveId: null });
    expect(text(html)).toContain("Assumption set Pick a set squeeze: Squeeze other");
    expect(html).not.toContain("btn-primary");
    expect(html).not.toContain("<article");
  });
  it("groups the bindings by kind in page order, the plugin kind last as one read-only line", () => {
    const t = text(render());
    expect(t.indexOf("Deposit decay")).toBeLessThan(t.indexOf("Commitment draws"));
    expect(t.indexOf("Commitment draws")).toBeLessThan(t.indexOf("Plugin kinds"));
    expect(t).toContain("acme, whole family Plugin kind acme-decay. Studio cannot edit it.");
    expect(t).toContain("Model version kernel-nmd-decay-1 , kept on save.");
  });
  it("labels each field from the schema with its unit and help line, the typed value in the input", () => {
    const html = render();
    const t = text(html);
    expect(t).toContain("Closure ramp time months Months for the closure rate to move from its starting to its steady value; the ramp settles by about three times this.");
    expect(html).toContain('value="24"');
    expect(t).toContain("Steady draw rate fraction");
  });
  it("reads a USD value back grouped beside its unit, in a field and a table cell; nothing for another unit or a draft that does not parse (fix I2)", () => {
    const html = render();
    const t = text(html);
    expect(t).toContain("Book size USD = 1,000,000 Total book balance");
    expect(t).toContain("Sensitivity midpoint balance USD = 1,100,000");
    expect(t).toContain("= 5,000,000");
    expect(t).not.toContain("= 0.4");
    expect(t).not.toContain("= 24");
    expect(html).toMatch(/aria-describedby="[^"]*:rb [^"]*" value="1000000"/);
    expect(html).toMatch(/aria-describedby="[^"]*rb1repBalance" value="5000000"\/><div class="field-help" id="[^"]*rb1repBalance">= 5,000,000<\/div>/);
    const typed = text(render({ draft: setValue(draftSet(SET), 2, "params.sens.bStar", "abc") }));
    expect(typed).toContain("Sensitivity midpoint balance USD Enter a number");
    expect(typed).not.toContain("= abc");
  });
  it("draws the ramp as Month rows before the steady rate, and the buckets as rows with the share sum", () => {
    const t = text(render());
    expect(t).toContain("Month 1");
    expect(t).toContain("Month 2");
    expect(t).toContain("Add month");
    expect(t.indexOf("Add month")).toBeLessThan(t.indexOf("Steady draw rate"));
    expect(t).toContain("Share sum: 1");
    expect(t).toContain("Add row");
    expect(render()).toContain('aria-label="Remove month 2"');
    expect(render()).toContain('aria-label="Share, row 2"');
  });
  it("shows an issue under its field in words, and marks the input invalid", () => {
    const html = render({ draft: setValue(draftSet(SET), 2, "params.sens.bStar", "abc") });
    expect(text(html)).toContain("Sensitivity midpoint balance USD Enter a number");
    expect(html).toContain('aria-invalid="true"');
    expect(text(saveButton(html))).toBe("Save as squeeze-edit-1");
    expect(saveButton(html)).toContain('aria-disabled="true"');
    expect(text(html)).toContain("Off: one field needs a fix");
  });
  it("under the off reason, lists each field to fix as a button that names it; Save is described by the reason (fix I4)", () => {
    let d = setValue(draftSet(SET), 2, "params.sens.bStar", "abc");
    d = setCell(d, 2, "params.buckets", 1, "share", "2");
    const html = render({ draft: d });
    const t = text(html);
    expect(t).toContain("Off: 2 fields need a fix Deposit decay, dda, whole family: Sensitivity midpoint balance Deposit decay, dda, whole family: Share, row 2");
    const reasonId = html.match(/<span class="muted" id="([^"]+)" role="status">Off: 2 fields need a fix<\/span>/)![1];
    expect(saveButton(html)).toContain(`aria-describedby="${reasonId}"`);
    expect(saveButton(html)).toContain('aria-disabled="true"');
    expect(html).toMatch(/<button type="button" class="btn btn-quiet"[^>]*>Deposit decay, dda, whole family: Share, row 2<\/button>/);
    expect(html).toContain('id="edit-2-params.sens.bStar"');
    expect(html).toContain('for="edit-2-params.sens.bStar"');
    expect(html).toContain('id="edit-2-params.buckets[1].share"');
    expect(html).toContain('id="edit-2-params.buckets"');
    expect(html).toContain('id="edit-1-rampRates[0]"');
    expect(render()).not.toContain("Fields to fix");
  });
  it("changes one live region per input: an invalid share cell leaves only Save's reason live (Polish 2 C5)", () => {
    // Every polite region in the markup: role="status" and aria-live. Before Polish 2 this draft held 3 (the cell's
    // message, the share sum and Save's reason), so one keystroke changed all three.
    const live = (h: string) => (h.match(/role="status"|aria-live=/g) ?? []).length;
    const html = render({ draft: setCell(draftSet(SET), 2, "params.buckets", 1, "share", "1.5") });
    expect(text(html)).toContain("Must be at most 1");
    expect(text(html)).toContain("Share sum: 2.1");
    expect(live(html)).toBe(1);
    expect(html).toMatch(/<span class="muted" id="[^"]+" role="status">Off: one field needs a fix<\/span>/);
    expect(live(render({ draft: setValue(draftSet(SET), 2, "params.sens.bStar", "abc") }))).toBe(1);
    expect(live(render({ reading: true }))).toBe(1);
    expect(text(render({ reading: true }))).toContain("Reading assumption set");
  });
  it("keeps Save off with nothing changed, and on with a change listed above it", () => {
    expect(saveButton(render())).toContain('aria-disabled="true"');
    expect(text(render())).toContain("Off: nothing has changed");
    const html = render({ draft: setCell(draftSet(SET), 2, "params.buckets", 1, "share", "0.3") });
    expect(saveButton(html)).not.toContain("aria-disabled");
    expect(text(html)).toContain("Changes dda, whole family: Share, row 2: 0.4 -> 0.3");
    expect(html.indexOf('aria-label="Changes"')).toBeLessThan(html.indexOf("btn-primary"));
  });
  it("says Saving <id> with Save off while a save is in flight", () => {
    const html = render({ draft: setCell(draftSet(SET), 2, "params.buckets", 1, "share", "0.3"), saving: "squeeze-edit-1" });
    expect(saveButton(html)).toContain('aria-disabled="true"');
    expect(text(html)).toContain("Saving squeeze-edit-1");
  });
  it("prints a failed read as an alert, a saved note as a status, a refusal as an alert", () => {
    expect(render({ draft: null, loadError: 'assumption set "gone" not found' })).toContain('role="alert"');
    expect(text(render({ draft: null, loadError: 'assumption set "gone" not found' }))).toContain('Assumption set not read assumption set "gone" not found');
    expect(render({ note: { text: "Saved squeeze-edit-1", error: false } })).toContain('<span role="status">Saved squeeze-edit-1</span>');
    expect(render({ note: { text: "422: invalid assumption set at x", error: true } })).toContain('<div class="card" role="alert">422: invalid assumption set at x</div>');
  });
});

describe("ChangesList", () => {
  it("renders nothing until a value changes", () => {
    expect(renderToStaticMarkup(<ChangesList changes={[]} />)).toBe("");
  });
  it("prints a removed bucket as one line", () => {
    const d = removeRow(draftSet(SET), 2, "params.buckets", 0);
    const html = renderToStaticMarkup(<EditSetView {...base} draft={d} />);
    expect(text(html)).toContain("dda, whole family: Account-size buckets, stored row 1: small -> removed");
  });
  it("prints an added bucket as one added line, with no none -> none (fix I3)", () => {
    const html = renderToStaticMarkup(<EditSetView {...base} draft={addRow(draftSet(SET), 2, "params.buckets")} />);
    expect(text(html)).toContain("Changes dda, whole family: Account-size buckets, row 3: added");
    expect(text(html)).not.toContain("none");
  });
});
