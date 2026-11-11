// apps/studio/src/__tests__/setEditModel.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssumptionSet, OverlayBinding } from "@alm/engine";
import {
  ADD_MODELS, KIND_GROUPS, addRow, bareOverlay, changeLine, changesOf, draftSet, draftShown, editHref, editSelected, fieldsToFix, focusAfterRemove, groupsOf, inputId, issuesOf, readDraft, removeRow, saveBlock, saveEdited,
  savePayload, saveOutcome, segmentsOf, setCell, setLabel, setValue, shareSumText, usdReadBack, whereOf,
} from "../assumptions/setEditModel";
import { PARAM_SCHEMAS, type TableField } from "@alm/engine/src/contracts/paramSchema";

afterEach(() => vi.unstubAllGlobals());

/** A stored set shaped like the seeded demo set, restated here: one prepay, a plugin kind, one decay with four buckets, a draw ramp with a selector, one beta. */
const PREPAY = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const DECAY = {
  closureSteady: 0.75, closureInitial: 2, closureTauMonths: 24, burnoutLambda: 0.1, maxRateDecay: 3, maxRateGrowth: -1, logisticK: 2, logisticMidpoint: 0,
  maPeriod: 24, regimeAlpha: 2, balanceSize: 1000000, sens: { gMin: 0.15, gMax: 1, bStar: 1100000, kappaB: 1.3 },
  buckets: [
    { label: "small", repBalance: 100000, share: 0.45 },
    { label: "mid", repBalance: 500000, share: 0.25 },
    { label: "large", repBalance: 2500000, share: 0.2 },
    { label: "jumbo", repBalance: 10000000, share: 0.1 },
  ],
};
const BINDINGS: OverlayBinding[] = [
  { familyId: "mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: PREPAY }, modelVersion: "kernel-four-factor-cpr-1" },
  { familyId: "acme", overlay: { kind: "registered", registeredKind: "acme-decay", params: { rate: 5 } }, modelVersion: "acme-1" },
  { familyId: "dda", overlay: { kind: "nmd-decay", params: DECAY }, modelVersion: "kernel-nmd-decay-1" },
  { familyId: "lines", overlay: { kind: "commitment-draw", rampRates: [0.35, 0.15, 0.1], steadyRate: 0.02 }, modelVersion: "engine-commitment-draw-1", selector: { tier: "retail" } },
  { familyId: "mma", overlay: { kind: "deposit-beta", params: { betaMin: 0.45, betaMax: 0.8, k: 0.55, m: 4.0, lambda: 1 } }, modelVersion: "kernel-deposit-beta-1" },
];
const SET: AssumptionSet = { schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo base behavioral set", bindings: BINDINGS, contentHash: "h-demo" };
const fresh = () => draftSet(structuredClone(SET));
const DECAY_AT = 2;
const DRAW_AT = 3;
const BETA_AT = 4;

describe("draftSet", () => {
  it("opens each number as the text JavaScript prints, the buckets and the ramp as keyed rows, a plugin kind as not editable", () => {
    const d = fresh();
    expect(d.label).toBe("Demo base behavioral set");
    expect(d.bindings[DECAY_AT]!.values["params.closureSteady"]).toBe("0.75");
    expect(d.bindings[DECAY_AT]!.values["params.sens.bStar"]).toBe("1100000");
    expect(d.bindings[DECAY_AT]!.rows["params.buckets"]![1]).toEqual({ key: 1, cells: { label: "mid", repBalance: "500000", share: "0.25" } });
    expect(d.bindings[DRAW_AT]!.rows.rampRates!.map((r) => r.cells.value)).toEqual(["0.35", "0.15", "0.1"]);
    expect(d.bindings[DRAW_AT]!.values.steadyRate).toBe("0.02");
    expect(d.bindings[1]!.schemaKey).toBeNull();
  });
});

describe("readDraft", () => {
  it("reads a plain or exponent decimal and nothing else, never a coerced 0", () => {
    expect(readDraft("0.75")).toBe(0.75);
    expect(readDraft(" 2 ")).toBe(2);
    expect(readDraft("-1")).toBe(-1);
    expect(readDraft(".5")).toBe(0.5);
    expect(readDraft("1e-7")).toBe(1e-7);
    for (const bad of ["", "abc", "1,000", "0x10", "1.2.3", "5%", "Infinity"]) expect(readDraft(bad), bad).toBeNull();
  });
});

describe("issuesOf", () => {
  it("text that is not a number reads Enter a number, once, not also the engine's finite-number message", () => {
    const d = setValue(fresh(), DECAY_AT, "params.sens.bStar", "abc");
    expect(issuesOf(d.bindings[DECAY_AT]!)).toEqual([{ path: "params.sens.bStar", label: "Sensitivity midpoint balance", message: "Enter a number" }]);
  });
  it("a number outside a hard bound carries the engine schema's label and message", () => {
    const d = setValue(fresh(), DECAY_AT, "params.sens.bStar", "-5");
    expect(issuesOf(d.bindings[DECAY_AT]!)).toEqual([{ path: "params.sens.bStar", label: "Sensitivity midpoint balance", message: "must be above 0" }]);
  });
  it("a cross rule sits under the second field; a bucket cell under its row", () => {
    expect(issuesOf(setValue(fresh(), BETA_AT, "params.betaMax", "0.4").bindings[BETA_AT]!)).toEqual([
      { path: "params.betaMax", label: "Beta ceiling", message: "must be above the beta floor" },
    ]);
    expect(issuesOf(setCell(fresh(), DECAY_AT, "params.buckets", 1, "share", "1.2").bindings[DECAY_AT]!)).toEqual([
      { path: "params.buckets[1].share", label: "Share, row 2", message: "must be at most 1" },
    ]);
  });
  it("a plugin binding has no issues: its params are its plugin's", () => {
    expect(issuesOf(fresh().bindings[1]!)).toEqual([]);
  });
});

describe("usdReadBack", () => {
  it("reads a USD draft back grouped when it parses, by unit not by field name; nothing otherwise (fix I2)", () => {
    expect(usdReadBack("USD", "1100000")).toBe("= 1,100,000");
    expect(usdReadBack("USD", " 10000000 ")).toBe("= 10,000,000");
    expect(usdReadBack("USD", "2500000.5")).toBe("= 2,500,000.5");
    expect(usdReadBack("USD", "1e6")).toBe("= 1,000,000");
    expect(usdReadBack("USD", "-5")).toBe(`= ${String.fromCharCode(0x2212)}5`);
    for (const bad of ["", "abc", "1,000", "0x10", "Infinity"]) expect(usdReadBack("USD", bad), bad).toBeNull();
    expect(usdReadBack("bp", "1100000")).toBeNull();
    expect(usdReadBack("fraction", "0.25")).toBeNull();
  });
});

describe("changesOf", () => {
  it("is empty until a value changes, and a re-typed equal number is no change", () => {
    expect(changesOf(fresh())).toEqual([]);
    expect(changesOf(setValue(fresh(), DECAY_AT, "params.closureSteady", "0.750"))).toEqual([]);
  });
  it("lists each changed field as label: old -> new, under its binding", () => {
    let d = setCell(fresh(), DECAY_AT, "params.buckets", 1, "share", "0.3");
    d = setValue(d, BETA_AT, "params.lambda", "0.5");
    d = setLabel(d, "Demo, mid bucket 30%");
    expect(changesOf(d)).toEqual([
      { where: "Set", label: "Label", from: "Demo base behavioral set", to: "Demo, mid bucket 30%" },
      { where: "dda, whole family", label: "Share, row 2", from: "0.25", to: "0.3" },
      { where: "mma, whole family", label: "Adjustment speed", from: "1", to: "0.5" },
    ]);
  });
  it("a removed bucket is one removal, not every later bucket changing; ramp months compare by position", () => {
    expect(changesOf(removeRow(fresh(), DECAY_AT, "params.buckets", 1))).toEqual([
      { where: "dda, whole family", label: "Account-size buckets, stored row 2", from: "mid", to: "removed" },
    ]);
    expect(changesOf(removeRow(fresh(), DRAW_AT, "rampRates", 0))).toEqual([
      { where: "lines, tier: retail", label: "Draw ramp, month 1", from: "0.35", to: "0.15" },
      { where: "lines, tier: retail", label: "Draw ramp, month 2", from: "0.15", to: "0.1" },
      { where: "lines, tier: retail", label: "Draw ramp, month 3", from: "0.1", to: "removed" },
    ]);
  });
  it("an added month is one line, added, empty or filled, and holds Save off until it is filled (fix I3)", () => {
    const d = addRow(fresh(), DRAW_AT, "rampRates");
    expect(changesOf(d)).toEqual([{ where: "lines, tier: retail", label: "Draw ramp, month 4", from: null, to: "added" }]);
    expect(issuesOf(d.bindings[DRAW_AT]!)).toEqual([{ path: "rampRates[3]", label: "Draw ramp, month 4", message: "Enter a number" }]);
    const filled = setCell(d, DRAW_AT, "rampRates", 3, "value", "0.05");
    expect(issuesOf(filled.bindings[DRAW_AT]!)).toEqual([]);
    expect(changesOf(filled)).toEqual([{ where: "lines, tier: retail", label: "Draw ramp, month 4", from: null, to: "added" }]);
    expect(changeLine(changesOf(d)[0]!)).toBe("lines, tier: retail: Draw ramp, month 4: added");
  });
  it("an added bucket is one line naming the table and row, not one line per cell (fix I3)", () => {
    const d = addRow(fresh(), DECAY_AT, "params.buckets");
    expect(changesOf(d)).toEqual([{ where: "dda, whole family", label: "Account-size buckets, row 5", from: null, to: "added" }]);
    const filled = setCell(setCell(setCell(d, DECAY_AT, "params.buckets", 4, "label", "mega"), DECAY_AT, "params.buckets", 4, "repBalance", "20000000"), DECAY_AT, "params.buckets", 4, "share", "0.05");
    expect(changesOf(filled).map(changeLine)).toEqual(["dda, whole family: Account-size buckets, row 5: added"]);
  });
  it("a cell or field left blank reads blank, not none (fix I3)", () => {
    expect(changesOf(setCell(fresh(), DRAW_AT, "rampRates", 2, "value", "")).map(changeLine)).toEqual([
      "lines, tier: retail: Draw ramp, month 3: 0.1 -> blank",
    ]);
    expect(changesOf(setCell(fresh(), DECAY_AT, "params.buckets", 1, "share", " ")).map(changeLine)).toEqual([
      "dda, whole family: Share, row 2: 0.25 -> blank",
    ]);
    expect(changesOf(setValue(fresh(), BETA_AT, "params.lambda", "")).map(changeLine)).toEqual([
      "mma, whole family: Adjustment speed: 1 -> blank",
    ]);
    expect(changeLine({ where: "dda, whole family", label: "Share, row 2", from: "0.25", to: "0.3" })).toBe("dda, whole family: Share, row 2: 0.25 -> 0.3");
  });
});

describe("saveBlock", () => {
  it("says why Save is off: saving, reading, no set, an open issue, nothing changed; null when it is on", () => {
    const edited = setCell(fresh(), DECAY_AT, "params.buckets", 1, "share", "0.3");
    expect(saveBlock(edited, false, "demo-behavioral-v1-edit-1")).toBe("Saving demo-behavioral-v1-edit-1");
    expect(saveBlock(edited, true, null)).toBe("Reading the set");
    expect(saveBlock(null, false, null)).toBe("Pick a set to edit");
    expect(saveBlock(fresh(), false, null)).toBe("Off: nothing has changed");
    expect(saveBlock(setValue(edited, DECAY_AT, "params.sens.bStar", "abc"), false, null)).toBe("Off: one field needs a fix");
    expect(saveBlock(setValue(setValue(edited, DECAY_AT, "params.sens.bStar", "abc"), BETA_AT, "params.lambda", "0"), false, null)).toBe("Off: 2 fields need a fix");
    expect(saveBlock(edited, false, null)).toBeNull();
  });
  it("counts fields, not issues: a field with a bound and a cross-rule issue is one field (fix I4)", () => {
    // Maximum CPR 101 is above 100 and not above the minimum 102; the minimum is above 100 too: three issues, two fields.
    const d = setValue(setValue(fresh(), 0, "params.maxCpr", "101"), 0, "params.minCpr", "102");
    expect(issuesOf(d.bindings[0]!)).toHaveLength(3);
    expect(saveBlock(d, false, null)).toBe("Off: 2 fields need a fix");
  });
});

describe("fieldsToFix", () => {
  it("lists each field with an issue once, in page order, as where: label, with the input it focuses (fix I4)", () => {
    let d = setValue(fresh(), 0, "params.maxCpr", "101");
    d = setValue(d, 0, "params.minCpr", "102");
    d = setValue(d, BETA_AT, "params.lambda", "0");
    d = setCell(d, DECAY_AT, "params.buckets", 1, "share", "abc");
    d = setValue(d, DECAY_AT, "params.sens.bStar", "-5");
    d = addRow(d, DRAW_AT, "rampRates");
    expect(fieldsToFix(d)).toEqual([
      { label: "mortgages, whole family: Minimum CPR", target: "edit-0-params.minCpr" },
      { label: "mortgages, whole family: Maximum CPR", target: "edit-0-params.maxCpr" },
      { label: "dda, whole family: Sensitivity midpoint balance", target: "edit-2-params.sens.bStar" },
      { label: "dda, whole family: Share, row 2", target: "edit-2-params.buckets[1].share" },
      { label: "mma, whole family: Adjustment speed", target: "edit-4-params.lambda" },
      { label: "lines, tier: retail: Draw ramp, month 4", target: "edit-3-rampRates[3]" },
    ]);
    expect(fieldsToFix(fresh())).toEqual([]);
  });
  it("a table rule focuses the table's first cell, or its Add button when it has no rows (fix I4)", () => {
    let d = fresh();
    for (let i = 0; i < 4; i += 1) d = setCell(d, DECAY_AT, "params.buckets", i, "share", "0");
    expect(fieldsToFix(d)).toEqual([{ label: "dda, whole family: Account-size buckets", target: "edit-2-params.buckets[0].label" }]);
    let e = fresh();
    for (let i = 0; i < 4; i += 1) e = removeRow(e, DECAY_AT, "params.buckets", 0);
    expect(fieldsToFix(e)).toEqual([{ label: "dda, whole family: Account-size buckets", target: "edit-2-params.buckets" }]);
  });
  it("names an input by its binding and path", () => {
    expect(inputId(2, "params.buckets[1].share")).toBe("edit-2-params.buckets[1].share");
  });
});

describe("savePayload", () => {
  it("posts the new id and the edited values; family, selector and modelVersion unchanged; a plugin binding verbatim; no contentHash", () => {
    const d = setCell(fresh(), DECAY_AT, "params.buckets", 1, "share", "0.3");
    const p = savePayload(d, "demo-behavioral-v1-edit-1");
    expect(Object.keys(p).sort()).toEqual(["bindings", "id", "label", "schemaVersion"]);
    expect(p.id).toBe("demo-behavioral-v1-edit-1");
    expect(p.label).toBe("Demo base behavioral set");
    expect(p.bindings.map((b) => b.modelVersion)).toEqual(["kernel-four-factor-cpr-1", "acme-1", "kernel-nmd-decay-1", "engine-commitment-draw-1", "kernel-deposit-beta-1"]);
    expect(p.bindings[1]).toEqual(BINDINGS[1]);
    expect(p.bindings[DRAW_AT]!.selector).toEqual({ tier: "retail" });
    const buckets = (p.bindings[DECAY_AT]!.overlay as unknown as { params: { buckets: Array<{ label: string; share: number }> } }).params.buckets;
    expect(buckets.map((b) => [b.label, b.share])).toEqual([["small", 0.45], ["mid", 0.3], ["large", 0.2], ["jumbo", 0.1]]);
    for (const k of [0, DRAW_AT, BETA_AT]) expect(p.bindings[k], `binding ${k}`).toEqual(BINDINGS[k]);
  });
  it("a blank label saves as the id", () => {
    expect(savePayload(setLabel(fresh(), "  "), "x-edit-1").label).toBe("x-edit-1");
  });
  it("carries the source's macroBindings verbatim (Piece 7b)", () => {
    const MB = [{ seriesId: "hpi-down-30", feeder: "prepay-housing" as const, familyId: "mortgages" }];
    const mappedSet: AssumptionSet = { ...structuredClone(SET), macroBindings: MB };
    expect(savePayload(draftSet(mappedSet), "x").macroBindings).toEqual([{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mortgages" }]);
  });
});

describe("rows, focus and the share sum", () => {
  it("after Remove, focus goes to the next row's Remove, else to Add", () => {
    const rows = fresh().bindings[DECAY_AT]!.rows["params.buckets"]!;
    expect(focusAfterRemove(rows, 1)).toBe(2);
    expect(focusAfterRemove(rows, 3)).toBe("add");
  });
  it("a new row takes a key no stored row has", () => {
    const d = addRow(removeRow(fresh(), DECAY_AT, "params.buckets", 3), DECAY_AT, "params.buckets");
    expect(d.bindings[DECAY_AT]!.rows["params.buckets"]!.map((r) => r.key)).toEqual([0, 1, 2, 4]);
  });
  it("prints the share sum to twelve significant digits, and waits while a share is not a number", () => {
    const table = PARAM_SCHEMAS["nmd-decay"].fields.find((f) => f.shape === "table") as TableField;
    expect(shareSumText(fresh().bindings[DECAY_AT]!, table)).toBe("Share sum: 1");
    expect(shareSumText(setCell(fresh(), DECAY_AT, "params.buckets", 1, "share", "0.3").bindings[DECAY_AT]!, table)).toBe("Share sum: 1.05");
    expect(shareSumText(setCell(fresh(), DECAY_AT, "params.buckets", 1, "share", "x").bindings[DECAY_AT]!, table)).toBe("Share sum: shown once every share is a number");
  });
});

describe("layout helpers", () => {
  it("editHref names the set on Assumption sets inside the workspace; no set drops the key, and the book is not carried", () => {
    expect(editHref("ws-a", { book: "b1", set: "old" }, "demo-behavioral-v1")).toBe("#/ws/ws-a/assumptions/sets?set=demo-behavioral-v1");
    expect(editHref("ws-a", { book: "b1", set: "old" }, null)).toBe("#/ws/ws-a/assumptions/sets");
  });
  it("groups bindings by kind in page order, the plugin kind last", () => {
    expect(groupsOf(fresh()).map((g) => [g.heading, g.items.map((i) => i.index)])).toEqual([
      ["Prepayment", [0]], ["Deposit decay", [DECAY_AT]], ["Deposit repricing", [BETA_AT]], ["Commitment draws", [DRAW_AT]], ["Plugin kinds", [1]],
    ]);
  });
  it("keeps schema order: the draw ramp comes before the steady rate", () => {
    expect(segmentsOf("commitment-draw").map((s) => (s.kind === "numbers" ? s.fields.map((f) => f.path) : s.field.path))).toEqual(["rampRates", ["steadyRate"]]);
  });
  it("names a binding by family and selector", () => {
    expect(whereOf(BINDINGS[2]!)).toBe("dda, whole family");
    expect(whereOf(BINDINGS[DRAW_AT]!)).toBe("lines, tier: retail");
  });
  it("shows a held draft only for the set the address names", () => {
    const d = fresh();
    expect(draftShown(d, "demo-behavioral-v1")).toBe(d);
    expect(draftShown(d, "other")).toBeNull();
    expect(draftShown(null, "demo-behavioral-v1")).toBeNull();
  });
  it("selects the just-saved set before the address catches up, else the address's set (fix round 1)", () => {
    // Save sets the pending id in the same batch as the saved draft, so the form (and a focused Save) never unmounts.
    expect(editSelected("demo-behavioral-v1-edit-1", { set: "demo-behavioral-v1" })).toBe("demo-behavioral-v1-edit-1");
    expect(editSelected(null, { set: "demo-behavioral-v1" })).toBe("demo-behavioral-v1");
    expect(editSelected(null, { book: "b1" })).toBeNull();
    const saved = draftSet({ ...SET, id: "demo-behavioral-v1-edit-1" });
    expect(draftShown(saved, editSelected("demo-behavioral-v1-edit-1", { set: "demo-behavioral-v1" }))).toBe(saved);
  });
  it("adopts a late save reply only while the page is mounted and still on the saving set's source (fix round 1)", () => {
    expect(saveOutcome("demo-behavioral-v1", "demo-behavioral-v1", true)).toBe("adopt");
    expect(saveOutcome("demo-behavioral-v1", "other", true)).toBe("note");
    expect(saveOutcome("demo-behavioral-v1", null, true)).toBe("note");
    expect(saveOutcome("demo-behavioral-v1", "demo-behavioral-v1", false)).toBe("none");
    expect(saveOutcome("demo-behavioral-v1", "other", false)).toBe("none");
  });
});

/** A fetch stub that answers in order and records each call's method, path and body. */
function scriptedFetch(replies: Array<[number, unknown]>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const [status, body] = replies.shift() ?? [500, { error: { code: "internal", message: "no scripted reply" } }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

describe("saveEdited", () => {
  const edited = () => setCell(fresh(), DECAY_AT, "params.buckets", 1, "share", "0.3");
  it("posts once under the next free id and returns the stored set", async () => {
    const calls = scriptedFetch([[201, { ...savePayload(edited(), "demo-behavioral-v1-edit-2"), contentHash: "h2" }]]);
    const r = await saveEdited(edited(), new Set(["demo-behavioral-v1", "demo-behavioral-v1-edit-1"]));
    expect(r).toMatchObject({ kind: "saved", set: { id: "demo-behavioral-v1-edit-2", contentHash: "h2" } });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["POST", "/api/assumption-sets"]]);
    expect((calls[0]!.body as AssumptionSet).id).toBe("demo-behavioral-v1-edit-2");
  });
  it("on a 409, reads the list again, takes the next free id, and retries once", async () => {
    const calls = scriptedFetch([
      [409, { error: { code: "conflict", message: 'assumption set "demo-behavioral-v1-edit-1" already exists; the store is append-only; import under a new id instead of overwriting' } }],
      [200, [{ id: "demo-behavioral-v1", label: "", contentHash: "a" }, { id: "demo-behavioral-v1-edit-1", label: "", contentHash: "b" }, { id: "demo-behavioral-v1-edit-2", label: "", contentHash: "c" }]],
      [201, { ...savePayload(edited(), "demo-behavioral-v1-edit-3"), contentHash: "h3" }],
    ]);
    const r = await saveEdited(edited(), new Set(["demo-behavioral-v1"]));
    expect(r).toMatchObject({ kind: "saved", set: { id: "demo-behavioral-v1-edit-3" } });
    expect(calls.map((c) => [c.method, c.url, (c.body as { id?: string } | undefined)?.id])).toEqual([
      ["POST", "/api/assumption-sets", "demo-behavioral-v1-edit-1"],
      ["GET", "/api/assumption-sets", undefined],
      ["POST", "/api/assumption-sets", "demo-behavioral-v1-edit-3"],
    ]);
  });
  it("prints a 422 verbatim through pageErrText and does not retry", async () => {
    const calls = scriptedFetch([[422, { error: { code: "validation", message: "invalid assumption set at bindings[2].overlay.params.sens.bStar: Sensitivity midpoint balance must be a number" } }]]);
    expect(await saveEdited(edited(), new Set())).toEqual({
      kind: "refused",
      text: "422: invalid assumption set at bindings[2].overlay.params.sens.bStar: Sensitivity midpoint balance must be a number",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("the loan client rate kind (Piece 9)", () => {
  /** The seeded loan repricing set, restated: the demo's four bindings plus the flat-carry client rate on mortgages. */
  const LOAN: AssumptionSet = {
    schemaVersion: "1.0.0", id: "loan-repricing-demo-v1", label: "Demo loan repricing set (demonstration values)", contentHash: "h-loan",
    bindings: [
      BINDINGS[0]!,
      { familyId: "mortgages", overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 250 }, modelVersion: "illustrative-flat-carry-1" },
    ],
  };
  it("is the last add model, with its own group heading before Plugin kinds", () => {
    expect(ADD_MODELS[ADD_MODELS.length - 1]).toEqual({ key: "loan-client-rate", label: "Loan client rate, flat carry" });
    expect(KIND_GROUPS.map((g) => g.heading)).toEqual(["Prepayment", "Deposit decay", "Deposit repricing", "CD rollover", "Commitment draws", "Loan client rate, flat carry", "Plugin kinds"]);
  });
  it("a blank start is the kind with the flat-carry model and no spread", () => {
    expect(bareOverlay("loan-client-rate")).toEqual({ kind: "loan-client-rate", model: "flat-carry" });
  });
  it("round-trips the stored set unchanged and groups the binding under its heading", () => {
    const d = draftSet(structuredClone(LOAN));
    expect(d.bindings[1]!.schemaKey).toBe("loan-client-rate");
    expect(d.bindings[1]!.values.totalSpreadBp).toBe("250");
    expect(changesOf(d)).toEqual([]);
    expect(issuesOf(d.bindings[1]!)).toEqual([]);
    expect(savePayload(d, LOAN.id).bindings).toEqual(LOAN.bindings);
    expect(groupsOf(d).map((g) => [g.heading, g.items.length])).toEqual([["Prepayment", 1], ["Loan client rate, flat carry", 1]]);
  });
  it("a typed spread outside the stored bounds is an issue on the root path", () => {
    const d = setValue(draftSet(structuredClone(LOAN)), 1, "totalSpreadBp", "1001");
    expect(issuesOf(d.bindings[1]!)).toEqual([{ path: "totalSpreadBp", label: "Total spread", message: "must be at most 1000" }]);
  });
});
