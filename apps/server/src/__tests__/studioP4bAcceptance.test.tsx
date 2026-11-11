// apps/server/src/__tests__/studioP4bAcceptance.test.tsx
/**
 * ALM Studio Piece 4b acceptance on a freshly seeded test platform. The Studio set editor's model
 * opens the seeded demo set, removes a binding, switches a prepay model, adds a
 * binding on a family the seeded book offers, and saves through the real server
 * and store; the stored copy carries exactly those changes and compiles for the
 * book. A blank-start binding holds Save off and, posted around the form, is
 * refused with nothing stored. A whole-family duplicate is refused at save in
 * the resolver's words; overlapping selectors pass save and are refused when a
 * plan for a tagged book is validated. Expected values and texts are restated
 * here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, createAssumptionSet, getAssumptionSet, getPortfolio, getRunPlan, listAssumptionSets, validatePlan } from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { bootTestPlatform, type TestPlatform } from "./harness";
import {
  addBinding, changeLine, changesOf, draftSet, familyChoices, saveBlock, saveEdited, savePayload, selectorChips, setModelVersion, setValue,
  startChoices, switchModel, removeBinding, toggleChip,
} from "../../../studio/src/assumptions/setEditModel";
import { pageErrText } from "../../../studio/src/errText";

let t: TestPlatform;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  // Studio's reader client calls relative /api paths; send them to the test platform.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${t.base}${input}` : input, init));
});
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const SOURCE = "demo-behavioral-v1";
const BOOK = "synthetic-2500-v1";

/** The seeded plan for the book, pointed at one stored set, validated by the real compiler. */
async function validateWith(setId: string, book: string) {
  const plan = structuredClone(await getRunPlan(`plan-${BOOK}`));
  plan.inputs.positionBook = book;
  plan.inputs.assumptionSets = [setId];
  return (await validatePlan(plan)).compile;
}

describe("ALM Studio P4b acceptance", () => {
  it("removes a binding, switches a prepay model and adds a copied binding, saves under a new id, and the copy compiles for the book", async () => {
    const source = await getAssumptionSet(SOURCE);
    expect(source.bindings.map((b) => `${b.familyId} ${b.overlay.kind}`)).toEqual(["mortgages prepay", "mbs prepay", "dda nmd-decay", "mma deposit-beta"]);
    const book = await getPortfolio(BOOK);
    const stored = await Promise.all((await listAssumptionSets()).map((s) => getAssumptionSet(s.id)));

    // Remove the mbs prepay binding; switch mortgages to constant CPR, blank; add a decay binding on mma, copied from the stored dda one.
    let d = removeBinding(draftSet(source), 1);
    d = switchModel(d, 0, "prepay/constant-cpr", null);
    expect(familyChoices(book, "nmd-decay").map((f) => f.id)).toEqual(["dda", "mma"]);
    expect(familyChoices(book, "cd-rollover").map((f) => f.id)).toEqual(["cash", "investments", "fixed-loans", "cds", "fhlb", "borrowings"]);
    const starts = startChoices(stored, "nmd-decay");
    expect(starts.map((c) => c.id)).toContain("demo-behavioral-v1#2");
    d = addBinding(d, "nmd-decay", "mma", undefined, starts.find((c) => c.id === "demo-behavioral-v1#2")!.binding);
    expect(saveBlock(d, false, null)).toBe("Off: 2 fields need a fix");
    d = setValue(setModelVersion(d, 0, "studio-constant-cpr-1"), 0, "annualCpr", "0.08");
    expect(saveBlock(d, false, null)).toBeNull();
    expect(changesOf(d).map(changeLine)).toEqual([
      "mbs, whole family: Four-factor CPR binding: removed",
      "mortgages, whole family: Model: Four-factor CPR -> Constant CPR",
      "mortgages, whole family: Model version: kernel-four-factor-cpr-1 -> studio-constant-cpr-1",
      "mortgages, whole family: Annual CPR: none -> 0.08",
      "mma, whole family: Deposit decay binding: added",
    ]);

    const r = await saveEdited(d, new Set((await listAssumptionSets()).map((s) => s.id)));
    if (r.kind !== "saved") throw new Error(r.text);
    expect(r.set.id).toBe("demo-behavioral-v1-edit-1");
    const saved = await getAssumptionSet("demo-behavioral-v1-edit-1");
    expect(saved.bindings).toEqual([
      { familyId: "mortgages", overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.08 }, modelVersion: "studio-constant-cpr-1" },
      source.bindings[2],
      source.bindings[3],
      { familyId: "mma", overlay: source.bindings[2]!.overlay, modelVersion: "kernel-nmd-decay-1" },
    ]);
    expect(saved.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // The book only filled the pickers: the saved set passes the compile gate for that book's seeded plan.
    expect(await validateWith("demo-behavioral-v1-edit-1", BOOK)).toEqual({ passed: true });
  });

  it("holds Save off on a blank-start binding; posted around the form, the server refuses it and stores nothing", async () => {
    const source = await getAssumptionSet(SOURCE);
    const before = (await listAssumptionSets()).map((s) => s.id).sort();
    const d = addBinding(draftSet(source), "nmd-decay", "mma", undefined, null);
    expect(saveBlock(d, false, null)).toBe("Off: 17 fields need a fix");

    let refused: unknown;
    try { await createAssumptionSet(savePayload(d, "demo-behavioral-v1-blank")); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(ApiError);
    expect(pageErrText(refused)).toBe("422: invalid assumption set at bindings[4].modelVersion: must be a non-empty string");

    const versioned = setModelVersion(d, 4, "studio-nmd-decay-1");
    expect(await saveEdited(versioned, new Set(before))).toEqual({
      kind: "refused",
      text: "422: invalid assumption set at bindings[4].overlay.params.closureSteady: Steady closure rate must be a number",
    });
    expect((await listAssumptionSets()).map((s) => s.id).sort()).toEqual(before);
  });

  it("refuses a whole-family duplicate at save in the resolver's words; overlapping selectors save, and a tagged book's plan is refused at validate", async () => {
    const source = await getAssumptionSet(SOURCE);
    // The ids this test finds, read first, so it passes alone (-t) as well as after the others in this file (Polish 2 C7).
    const before = (await listAssumptionSets()).map((s) => s.id).sort();
    const stored = await Promise.all(before.map((id) => getAssumptionSet(id)));
    const copy = startChoices(stored, "nmd-decay").find((c) => c.id === "demo-behavioral-v1#2")!.binding;

    const dup = addBinding(draftSet(source), "nmd-decay", "dda", undefined, copy);
    expect(saveBlock(dup, false, null)).toBeNull();
    expect(await saveEdited(dup, new Set(before))).toEqual({
      kind: "refused",
      text: '422: invalid assumption set at bindings[4]: family "dda" has two "nmd-decay" overlays; one family, one overlay per kind',
    });
    // The refused duplicate stored nothing.
    expect((await listAssumptionSets()).map((s) => s.id).sort()).toEqual(before);

    const lcr = await getPortfolio("synthetic-2500-lcr-v1");
    expect(selectorChips(lcr, "dda")).toEqual([{ tag: "lcr-category", label: "LCR run-off category for a liability family", values: ["retail-stable"] }]);
    const narrowed = addBinding(draftSet(source), "nmd-decay", "dda", toggleChip(undefined, "lcr-category", "retail-stable"), copy);
    const r = await saveEdited(narrowed, new Set(before));
    if (r.kind !== "saved") throw new Error(r.text);
    expect(r.set.id).toMatch(/^demo-behavioral-v1-edit-\d+$/);
    expect(before).not.toContain(r.set.id);
    const compile = await validateWith(r.set.id, "synthetic-2500-lcr-v1");
    expect(compile.passed).toBe(false);
    expect(compile.error).toBe("OverlappingBindingError");
    expect(compile.detail).toContain('is matched by two "nmd-decay" bindings, bindings[2] (selector <whole family>) and bindings[4] (selector {"lcr-category":["retail-stable"]})');
  });
});
