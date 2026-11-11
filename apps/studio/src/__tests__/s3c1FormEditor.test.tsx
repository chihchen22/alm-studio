// apps/studio/src/__tests__/s3c1FormEditor.test.tsx
/**
 * The set editor's optional forms, the full beta form, the component decay form and the
 * replicating-portfolio credit, as new field shapes (choice, optional form, text).
 *
 *  1. Every field the forms declare is a field its validator knows, and every field the validator knows is declared.
 *  2. A seeded deposit desk binding opens with its forms on and writes back exactly the overlay it was stored with.
 *  3. Optional numbers and choices left empty write no key; a field hidden by its choice writes nothing.
 *  4. The editor refuses what intake refuses, in its words: each bad value is refused by the engine's bind check
 *     (bindAssumptions, the set route's check) with "<label> <message>", and the editor shows that message at that path.
 *  5. The form combinations the overlay merge refuses are refused here in the merge's own words.
 *  6. The series picker fills the series from the shipped history; the card renders each form with Add or Remove.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet, BehavioralOverlay, OverlayBinding, PortfolioSpec, PositionTerms } from "@alm/engine";
import { bindAssumptions } from "@alm/engine/src/scenario/bindAssumptions";
import { applyOverlayToTerms } from "@alm/engine/src/projection/static/applyOverlays";
import {
  COMPONENT_DECAY_LABEL, FORM_GROUPS, FULL_FORM_LABEL, REPLICATING_PORTFOLIO_LABEL, componentDecayIssues, formCombinationIssues, fullFormIssues, replicatingPortfolioIssues,
} from "@alm/engine/src/contracts/paramSchema";
import { depositFormSets } from "../../../server/src/examples/depositForms";
import { draftOf, draftSet, fillSeries, issuesOf, messagesAt, overlayOf, setForm, setValue, type BindingDraft } from "../assumptions/setEditModel";
import { EditSetView, type EditSetViewProps } from "../pages/assumptions/EditSetPage";

const ROOT = join(__dirname, "..", "..", "..", "..");
const SETS = depositFormSets(ROOT);
const credit = SETS.find((s) => s.id === "quillfield-desk-credit-v1")!;
const bindingOf = (set: AssumptionSet, familyId: string): OverlayBinding => set.bindings.find((b) => b.familyId === familyId)!;
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("the form shapes", () => {
  it("declare exactly the fields each validator knows: a complete form passes, and a form missing any declared required field is refused", () => {
    // A complete form of each kind passes its validator with no unknown key.
    const mma = bindingOf(credit, "dd-mma").overlay as Extract<BehavioralOverlay, { kind: "deposit-beta" }>;
    const savings = bindingOf(credit, "dd-savings").overlay as Extract<BehavioralOverlay, { kind: "nmd-decay" }>;
    expect(fullFormIssues(mma.fullForm)).toEqual([]);
    expect(componentDecayIssues(savings.componentDecay)).toEqual([]);
    expect(replicatingPortfolioIssues(mma.replicatingPortfolio)).toEqual([]);
    // Every declared path of the full form and the component form is a key the validator accepts (no "is not a field").
    const keysOf = (key: "fullForm" | "componentDecay") => FORM_GROUPS[key === "fullForm" ? "deposit-beta" : "nmd-decay"].find((g) => g.key === key)!.fields.map((f) => f.path.split(".")[1]!);
    const probe = (key: "fullForm" | "componentDecay") => Object.fromEntries(keysOf(key).map((k) => [k, 1]));
    expect(fullFormIssues(probe("fullForm")).filter((i) => i.message.includes("is not a field"))).toEqual([]);
    expect(componentDecayIssues(probe("componentDecay")).filter((i) => i.message.includes("is not a field"))).toEqual([]);
    // And the validator knows no field the editor leaves out: the stored forms' keys are all declared.
    expect(Object.keys(mma.fullForm!).every((k) => keysOf("fullForm").includes(k))).toBe(true);
    expect(Object.keys(savings.componentDecay!).every((k) => keysOf("componentDecay").includes(k))).toBe(true);
    const rpKeys = FORM_GROUPS["nmd-decay"].find((g) => g.key === "replicatingPortfolio")!.fields.map((f) => f.path.split(".")[1]!);
    for (const k of ["construction", "pillarGridMonths", "pillarMonths", "haircutMonths", "steepener", "life", "beta", "scenarioCurve"]) expect(rpKeys, k).toContain(k);
  });

  it("label each form with its validator's label", () => {
    expect(FORM_GROUPS["deposit-beta"].map((g) => g.label)).toEqual([FULL_FORM_LABEL, REPLICATING_PORTFOLIO_LABEL]);
    expect(FORM_GROUPS["nmd-decay"].map((g) => g.label)).toEqual([COMPONENT_DECAY_LABEL, REPLICATING_PORTFOLIO_LABEL]);
  });
});

describe("a seeded deposit desk binding", () => {
  it("opens with its forms on and writes back exactly the overlay it was stored with, for every desk set", () => {
    for (const set of SETS) {
      set.bindings.forEach((b, i) => {
        const d = draftOf(b, i, i);
        for (const k of ["fullForm", "componentDecay", "replicatingPortfolio"]) {
          if (k in b.overlay) expect(d.formOn[k], `${set.id} ${b.familyId} ${k}`).toBe(true);
        }
        expect(overlayOf(d).unparsed, `${set.id} ${b.familyId}`).toEqual([]);
        expect(overlayOf(d).overlay, `${set.id} ${b.familyId}`).toEqual(b.overlay);
        expect(issuesOf(d), `${set.id} ${b.familyId}`).toEqual([]);
      });
    }
  });

  it("an optional number or choice left empty writes no key; a field its choice hides writes nothing", () => {
    const d0 = draftSet(credit);
    const at = d0.bindings.findIndex((d) => d.stored.familyId === "dd-mma");
    // The credit's beta source left empty: no beta key. Staticbeta empty: no staticBeta key.
    const mma = overlayOf(d0.bindings[at]!).overlay as unknown as { fullForm: Record<string, unknown>; replicatingPortfolio: Record<string, unknown> };
    expect("staticBeta" in mma.fullForm).toBe(false);
    expect("beta" in mma.replicatingPortfolio).toBe(false);
    // Switch the construction to one pillar: the grid is hidden and not written; the pillar is shown and required.
    const d1 = setValue(d0, at, "replicatingPortfolio.construction", "pillar");
    const o1 = overlayOf(d1.bindings[at]!);
    expect("pillarGridMonths" in (o1.overlay as unknown as { replicatingPortfolio: object }).replicatingPortfolio).toBe(false);
    expect(o1.unparsed.map((i) => [i.path, i.message])).toEqual([["replicatingPortfolio.pillarMonths", "Enter a number"]]);
    const d2 = setValue(d1, at, "replicatingPortfolio.pillarMonths", "60");
    expect(issuesOf(d2.bindings[at]!)).toEqual([]);
    // A fixed beta source shows its value; empty, it is a number to enter.
    const d3 = setValue(d2, at, "replicatingPortfolio.beta.source", "fixed");
    expect(issuesOf(d3.bindings[at]!).map((i) => i.path)).toEqual(["replicatingPortfolio.beta.value"]);
  });

  it("a form turned off writes no root key, and back on writes its typed values again", () => {
    const d0 = draftSet(credit);
    const at = d0.bindings.findIndex((d) => d.stored.familyId === "dd-savings");
    const off = setForm(d0, at, "replicatingPortfolio", false);
    expect("replicatingPortfolio" in (overlayOf(off.bindings[at]!).overlay as object)).toBe(false);
    const on = setForm(off, at, "replicatingPortfolio", true);
    expect(overlayOf(on.bindings[at]!).overlay).toEqual(bindingOf(credit, "dd-savings").overlay);
  });
});

/** The engine's bind check on a set holding one binding, as the set route runs it: the message it throws, or null. */
function bindRefusal(b: OverlayBinding): string | null {
  try {
    bindAssumptions({ schemaVersion: "1.0.0", id: "probe", label: "probe", bindings: [b] });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("the editor refuses what intake refuses, in its words", () => {
  const cases: Array<{ family: string; path: string; text: string }> = [
    { family: "dd-mma", path: "fullForm.deltaUp", text: "1.5" },
    { family: "dd-mma", path: "fullForm.volRatio", text: "-1" },
    { family: "dd-mma", path: "fullForm.coreLifeYears", text: "0" },
    { family: "dd-mma", path: "replicatingPortfolio.life.months", text: "2.5" },
    { family: "dd-savings", path: "componentDecay.retention", text: "0" },
    { family: "dd-savings", path: "componentDecay.lookbackMonths", text: "1.5" },
    { family: "dd-savings", path: "componentDecay.window.firstMonth", text: "2022-13" },
    { family: "dd-savings", path: "componentDecay.window.lastMonth", text: "2030-01" },
    { family: "dd-savings", path: "componentDecay.series.label", text: " " },
    { family: "dd-operating", path: "replicatingPortfolio.haircutMonths", text: "0" },
  ];
  for (const c of cases) {
    it(`${c.family} ${c.path} = ${JSON.stringify(c.text)}`, () => {
      const d0 = draftSet(credit);
      const at = d0.bindings.findIndex((d) => d.stored.familyId === c.family);
      const d = setValue(d0, at, c.path, c.text).bindings[at]!;
      const issues = issuesOf(d);
      expect(issues.length, c.path).toBeGreaterThan(0);
      const first = issues[0]!;
      // The engine's own bind check on the overlay the draft stands for: the same field, the same words.
      const refusal = bindRefusal({ ...d.stored, overlay: overlayOf(d).overlay });
      expect(refusal, c.path).not.toBeNull();
      expect(refusal!, c.path).toContain(`overlay.${first.path}`);
      expect(refusal!, c.path).toContain(`${first.label} ${first.message}`);
      expect(messagesAt(issues, first.path)).toContain(first.message);
    });
  }

  it("a number field holding text is a number to enter, and the stored set still binds", () => {
    const d0 = draftSet(credit);
    const at = d0.bindings.findIndex((d) => d.stored.familyId === "dd-mma");
    const d = setValue(d0, at, "fullForm.alphaPct", "ten").bindings[at]!;
    expect(issuesOf(d).map((i) => [i.path, i.message])).toEqual([["fullForm.alphaPct", "Enter a number"]]);
    expect(bindRefusal(bindingOf(credit, "dd-mma"))).toBeNull();
  });
});

describe("the form combinations the overlay merge refuses", () => {
  const nmdTerms = (extra: Record<string, unknown> = {}): PositionTerms =>
    ({ id: "p", type: "nmd", label: "p", notional: 1, maturityMonths: 48, originationOffsetMonths: 0, amortType: "level-pay", side: "liability", depositRate: 0, beta: 0, nmdParams: {}, ...extra }) as unknown as PositionTerms;
  const nmdbTerms = (): PositionTerms => ({ id: "p", type: "nmd-b", label: "p", notional: 1, maturityMonths: 360, originationOffsetMonths: 0, amortType: "level-pay", side: "liability", sCurve: {}, nmdParams: {} }) as unknown as PositionTerms;
  const mergeRefusal = (terms: PositionTerms, overlay: BehavioralOverlay): string => {
    try {
      applyOverlayToTerms(terms, overlay, "p");
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const mma = bindingOf(credit, "dd-mma").overlay as Extract<BehavioralOverlay, { kind: "deposit-beta" }>;
  const savings = bindingOf(credit, "dd-savings").overlay as Extract<BehavioralOverlay, { kind: "nmd-decay" }>;
  const cases: Array<{ name: string; overlay: BehavioralOverlay; terms: PositionTerms }> = [
    { name: "a deposit-beta credit with no full form", overlay: { ...mma, fullForm: undefined } as unknown as BehavioralOverlay, terms: nmdbTerms() },
    { name: "a deposit-beta credit on the balance path", overlay: { ...mma, replicatingPortfolio: { ...mma.replicatingPortfolio!, life: { source: "balance-path" } } }, terms: nmdbTerms() },
    { name: "an nmd-decay credit on a capped life", overlay: { ...savings, replicatingPortfolio: { ...savings.replicatingPortfolio!, life: { source: "capped", months: 60 } } }, terms: nmdTerms() },
    { name: "an nmd-decay credit on the balance path with no component form", overlay: { ...savings, componentDecay: undefined } as unknown as BehavioralOverlay, terms: nmdTerms() },
    { name: "a straight-line credit beside a component form", overlay: { ...savings, replicatingPortfolio: { construction: "life-target", pillarGridMonths: [12, 60] } }, terms: nmdTerms({ linearDecay: { horizonMonths: 48 } }) },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const clean = JSON.parse(JSON.stringify(c.overlay)) as BehavioralOverlay;
      const issues = formCombinationIssues(clean);
      expect(issues).toHaveLength(1);
      const words = mergeRefusal(c.terms, clean);
      expect(words.length).toBeGreaterThan(0);
      expect(words).toContain(issues[0]!.message);
    });
  }
});

describe("the series picker and the card", () => {
  it("fills the component form's series from the shipped history, and the window stays as typed", () => {
    const history = JSON.parse(readFileSync(join(ROOT, "examples", "sofr-monthly-v1.json"), "utf8")) as { firstMonth: string; valuesPct: number[] };
    const set = SETS.find((s) => s.id === "quillfield-desk-component-decay-v1")!;
    const d0 = draftSet(set);
    const blank = setValue(setValue(d0, 0, "componentDecay.series.firstMonth", ""), 0, "componentDecay.series.label", "");
    const filled = fillSeries({ ...blank, bindings: blank.bindings.map((b) => ({ ...b, rows: { ...b.rows, "componentDecay.series.valuesPct": [] } })) }, 0, "componentDecay", { label: "SOFR history", firstMonth: history.firstMonth, valuesPct: history.valuesPct });
    const o = overlayOf(filled.bindings[0]!).overlay as unknown as { componentDecay: { series: { firstMonth: string; label: string; valuesPct: number[] }; window: unknown } };
    expect(o.componentDecay.series).toEqual({ label: "SOFR history", firstMonth: "2018-04", valuesPct: history.valuesPct });
    expect(o.componentDecay.window).toEqual({ firstMonth: "2022-04", lastMonth: "2026-03" });
    // A form with no picker is left as it is.
    expect(fillSeries(d0, 0, "replicatingPortfolio", { label: "x", firstMonth: "2018-04", valuesPct: [1] })).toEqual(d0);
  });

  it("renders each form of a deposit binding with Remove when on and Add when off, and the series picker", () => {
    const book = JSON.parse(readFileSync(join(ROOT, "examples", "quillfield-deposit-desk-v1.json"), "utf8")) as PortfolioSpec;
    const set = SETS.find((s) => s.id === "quillfield-desk-component-decay-v1")!;
    const props: EditSetViewProps = {
      sets: [{ id: set.id, label: set.label, contentHash: "h" }], selected: set.id, draft: draftSet(set), reading: false, loadError: null, listNote: null, saving: null,
      saveId: `${set.id}-edit-1`, note: null, book, bookId: book.id, bookNote: null, stored: [set], storedNote: null, onPick() {}, onDraft() {}, onSave() {}, onReread() {},
    };
    const raw = renderToStaticMarkup(<EditSetView {...props} />);
    const html = text(raw);
    expect(raw).toContain('aria-label="Remove Component decay form"');
    expect(raw).toContain('aria-label="Add Replicating-portfolio credit"');
    expect(html).toContain("Fill the series from the shipped SOFR history");
    expect(html).toContain("Rate series values: 96 values");
    expect(html).toContain("Monthly retention");
    expect(html).toContain("Driver past the window");
  });
});

// The draft type is used by the helpers above; keep the import honest.
export type { BindingDraft };
