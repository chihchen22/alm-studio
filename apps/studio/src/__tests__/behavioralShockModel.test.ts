// apps/studio/src/__tests__/behavioralShockModel.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError, type DerivedSetSaveReply } from "@alm/reader";
import type { AssumptionSet } from "@alm/engine";
import { bindAssumptions } from "@alm/engine/src/scenario";
import type { NumberBounds } from "@alm/engine/src/contracts/paramSchema";
import { buildDemoAssumptions, buildLoanRepricingAssumptions } from "@alm/data/src/demo/request";
import {
  addOp, bindingChoices, boundsText, emptyShockDraft, paramChoices, previewShown, readValue, removeOp, requestKey, requestOf,
  saveNoteOf, setBase, setOpField, setsHref, storedValueText, changeBindingText,
  type ShockDraft,
} from "../scenarios/behavioralShockModel";

/** The em-dash and the section sign, built from code points so this file holds neither. */
const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
const demo = bindAssumptions(buildDemoAssumptions());
const loan = bindAssumptions(buildLoanRepricingAssumptions());

/** A draft with one op already set on the demo set's dda binding (index 2). */
function fullDraft(valueText: string): ShockDraft {
  let d = setBase(emptyShockDraft(), "demo-behavioral-v1");
  d = addOp(d);
  const key = d.ops[0]!.key;
  d = setOpField(d, key, { bindingIndex: 2 });
  d = setOpField(d, key, { path: "params.closureSteady", op: "scale", valueText });
  return d;
}

describe("bindingChoices and paramChoices", () => {
  it("names each binding of the demo set as family, model label", () => {
    expect(bindingChoices(demo).map((c) => c.text)).toEqual([
      "mortgages, Four-factor CPR",
      "mbs, Four-factor CPR",
      "dda, Deposit decay",
      "mma, Deposit repricing",
    ]);
    expect(bindingChoices(demo).map((c) => [c.index, c.disabled])).toEqual([[0, false], [1, false], [2, false], [3, false]]);
  });
  it("the loan repricing set adds the flat carry client rate binding", () => {
    const texts = bindingChoices(loan).map((c) => c.text);
    expect(texts).toContain("mortgages, Loan client rate, flat carry");
  });
  it("adds the selector in words, and disables a registered binding", () => {
    const set = {
      schemaVersion: demo.schemaVersion,
      id: "x",
      label: "x",
      bindings: [
        { ...demo.bindings[2]!, selector: { segment: "retail" } },
        { familyId: "plug", modelVersion: "v1", overlay: { kind: "registered", registeredKind: "acme-model", params: {} } },
      ],
    } as unknown as AssumptionSet;
    expect(bindingChoices(set)).toEqual([
      { index: 0, text: "dda, Deposit decay, segment: retail", disabled: false },
      { index: 1, text: "plug, acme-model (registered, not offered)", disabled: true },
    ]);
  });
  it("lists the 15 number parameters of the decay binding, no buckets", () => {
    const ps = paramChoices(demo.bindings[2]!);
    expect(ps).toHaveLength(15);
    expect(ps[0]).toEqual({ path: "params.closureSteady", text: "Steady closure rate (% per month)" });
    expect(ps.some((p) => p.path === "params.buckets")).toBe(false);
  });
  it("lists the one parameter of the loan client rate", () => {
    const b = loan.bindings.find((x) => x.overlay.kind === "loan-client-rate")!;
    expect(paramChoices(b)).toEqual([{ path: "totalSpreadBp", text: "Total spread (bp)" }]);
  });
});

describe("boundsText", () => {
  const field = (bounds: NumberBounds) => ({ shape: "number" as const, path: "p", label: "L", unit: "u", help: "h", ...bounds });
  const vectors: Array<[string, NumberBounds, string]> = [
    ["closureSteady", { min: 0, max: 100 }, "0 to 100"],
    ["maxCpr", { max: 100 }, "at most 100"],
    ["totalSpreadBp", { min: 0, max: 1000 }, "0 to 1000"],
    ["renewalProbability", { min: 0, max: 1 }, "0 to 1"],
    ["lambda", { min: 0, minExclusive: true, max: 1 }, "above 0, at most 1"],
    ["maPeriod", { min: 1, integer: true, max: 297 }, "whole number, 1 to 297"],
    ["termMonths", { min: 1, integer: true }, "whole number, at least 1"],
    ["secSpread", {}, "no bound"],
    ["balanceSize", { min: 0, minExclusive: true }, "above 0"],
    ["burnoutDecay", { min: 0 }, "at least 0"],
    ["synthetic below", { max: 5, maxExclusive: true }, "below 5"],
    ["synthetic whole", { integer: true }, "whole number"],
  ];
  for (const [name, bounds, want] of vectors) {
    it(`${name} reads "${want}"`, () => expect(boundsText(field(bounds))).toBe(want));
  }
});

describe("storedValueText", () => {
  it("prints the stored value as JavaScript prints it", () => {
    expect(storedValueText(demo, 2, "params.closureSteady")).toBe("0.75");
    expect(storedValueText(demo, 2, "params.closureInitial")).toBe("2");
  });
});

describe("readValue", () => {
  it("reads a number and blocks anything else", () => {
    expect(readValue("1.25")).toEqual({ value: 1.25 });
    expect(readValue(" -3 ")).toEqual({ value: -3 });
    expect(readValue("abc")).toEqual({ block: "Enter a number" });
    expect(readValue("")).toEqual({ block: "Enter a number" });
    expect(readValue("1e999")).toEqual({ block: "Enter a number" });
  });
});

describe("requestOf", () => {
  it("blocks an empty draft, a draft with no ops, and an unfinished op, in that order", () => {
    expect(requestOf(emptyShockDraft(), null)).toEqual({ block: "Pick a base set" });
    expect(requestOf({ ...emptyShockDraft(), baseId: "demo-v1" }, null)).toEqual({ block: "Reading the base set" });
    const noOps = setBase(emptyShockDraft(), "demo-behavioral-v1");
    expect(requestOf(noOps, demo)).toEqual({ block: "Add an op" });
    const blank = addOp(noOps);
    expect(requestOf(blank, demo)).toEqual({ block: "Pick a binding" });
    const key = blank.ops[0]!.key;
    const bound = setOpField(blank, key, { bindingIndex: 2 });
    expect(requestOf(bound, demo)).toEqual({ block: "Pick a parameter" });
    const picked = setOpField(bound, key, { path: "params.closureSteady" });
    expect(requestOf(picked, demo)).toEqual({ block: "Enter a number" });
    expect(requestOf(fullDraft("abc"), demo)).toEqual({ block: "Enter a number" });
  });
  it("builds the body from the typed values, with no id or label keys when they are empty", () => {
    const r = requestOf(fullDraft("1.25"), demo);
    expect(r).toEqual({
      body: {
        baseId: "demo-behavioral-v1",
        ops: [{ target: { familyId: "dda", kind: "nmd-decay" }, path: "params.closureSteady", op: "scale", value: 1.25 }],
      },
    });
    const body = (r as { body: object }).body;
    expect("id" in body).toBe(false);
    expect("label" in body).toBe(false);
  });
  it("carries a trimmed id and label when typed, and a binding's own selector in the target", () => {
    const set = { ...demo, bindings: demo.bindings.map((b, i) => (i === 2 ? { ...b, selector: { segment: "retail" } } : b)) } as AssumptionSet;
    const d = { ...fullDraft("1.25"), id: " my-shock ", label: " Decay up " };
    expect(requestOf(d, set)).toEqual({
      body: {
        baseId: "demo-behavioral-v1",
        ops: [{ target: { familyId: "dda", kind: "nmd-decay", selector: { segment: "retail" } }, path: "params.closureSteady", op: "scale", value: 1.25 }],
        id: "my-shock",
        label: "Decay up",
      },
    });
  });
});

describe("requestKey and previewShown", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(requestKey({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(requestKey({ a: [{ c: 3, d: 2 }], b: 1 })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(requestKey({ a: [2, 1] })).toBe('{"a":[2,1]}');
  });
  it("the preview is shown only for the request it was made for", () => {
    const r1 = requestOf(fullDraft("1.25"), demo);
    const k1 = requestKey((r1 as { body: object }).body);
    expect(previewShown(k1, k1)).toBe(true);
    expect(previewShown(null, k1)).toBe(false);
    expect(previewShown(k1, null)).toBe(false);
    // Any op edit moves the key, so the preview goes.
    const edited = fullDraft("1.25");
    const key = edited.ops[0]!.key;
    for (const patch of [{ valueText: "1.3" }, { op: "add" as const }, { path: "params.closureInitial" }, { bindingIndex: 3 }]) {
      const r2 = requestOf(setOpField(edited, key, patch), demo);
      const k2 = "body" in r2 ? requestKey(r2.body) : null;
      expect(previewShown(k1, k2), JSON.stringify(patch)).toBe(false);
    }
    const added = requestOf(addOp(edited), demo);
    expect(previewShown(k1, "body" in added ? requestKey(added.body) : null)).toBe(false);
  });
});

describe("draft edits", () => {
  it("adds, edits and removes ops by key, and a changed binding clears the parameter", () => {
    let d = setBase(emptyShockDraft(), "demo-behavioral-v1");
    d = addOp(d);
    d = addOp(d);
    expect(d.ops.map((o) => o.key)).toEqual([0, 1]);
    d = setOpField(d, 0, { bindingIndex: 2, path: "params.closureSteady" });
    d = setOpField(d, 0, { bindingIndex: 3 });
    expect(d.ops[0]).toMatchObject({ bindingIndex: 3, path: null });
    d = removeOp(d, 0);
    expect(d.ops.map((o) => o.key)).toEqual([1]);
    d = addOp(d);
    expect(d.ops.map((o) => o.key)).toEqual([1, 2]);
  });
  it("picking another base set drops the ops, which index the old base", () => {
    let d = addOp(setBase(emptyShockDraft(), "a"));
    d = setBase(d, "b");
    expect(d).toMatchObject({ baseId: "b", ops: [] });
  });
});

describe("changeBindingText", () => {
  it("names the family and kind, with the selector in words when there is one", () => {
    expect(changeBindingText({ familyId: "dda", kind: "nmd-decay" })).toBe("dda, nmd-decay");
    expect(changeBindingText({ familyId: "dda", kind: "nmd-decay", selector: { segment: "retail" } })).toBe("dda, nmd-decay, segment: retail");
  });
});

describe("saveNoteOf", () => {
  const reply = (outcome: "created" | "unchanged"): DerivedSetSaveReply => ({
    outcome,
    set: { schemaVersion: demo.schemaVersion, id: "derived-0123456789ab", label: "x", bindings: [] },
    changes: [],
  });
  it("created and unchanged name the id", () => {
    expect(saveNoteOf(reply("created"))).toMatchObject({ kind: "created", text: "Saved as derived-0123456789ab", savedId: "derived-0123456789ab", problems: [] });
    expect(saveNoteOf(reply("unchanged"))).toMatchObject({ kind: "unchanged", text: "derived-0123456789ab already saved with this content", savedId: "derived-0123456789ab" });
  });
  it("a 409 is a conflict with the server's text", () => {
    const e = new ApiError(409, "conflict", 'assumption set "x" already exists with different content (the store is append-only); save it under a new id');
    expect(saveNoteOf(e)).toMatchObject({
      kind: "conflict",
      text: '409: assumption set "x" already exists with different content (the store is append-only); save it under a new id',
      savedId: null,
    });
  });
  it("a 422 lists every problem the server sent", () => {
    const e = new ApiError(422, "validation", "derived set refused: 2 problem(s); every problem is listed: a; b", {
      problems: [{ at: "ops[0]", message: "ops[0]: first" }, { at: "bindings[3].overlay.params.lambda", message: "mma deposit-beta: Adjustment speed must be at most 1" }],
    });
    expect(saveNoteOf(e)).toEqual({
      kind: "refused",
      text: "Refused: every problem is listed.",
      problems: ["ops[0]: first", "mma deposit-beta: Adjustment speed must be at most 1"],
      savedId: null,
    });
  });
  it("a 422 with no problems list prints the server message", () => {
    const e = new ApiError(422, "validation", 'unknown field "extra" in the request body');
    expect(saveNoteOf(e)).toMatchObject({ kind: "refused", text: '422: unknown field "extra" in the request body', problems: [] });
  });
  it("any other failure prints its page error line", () => {
    expect(saveNoteOf(new Error("boom"))).toMatchObject({ kind: "error", text: "boom", problems: [] });
  });
});

describe("setsHref", () => {
  it("opens the scenario choice of Run setups with the set carried in the query", () => {
    expect(setsHref("ws-a", { book: "b1" }, "x")).toBe("#/ws/ws-a/run/setups?tab=scenarios&set=x");
    expect(setsHref("ws-a", {}, "derived-0123456789ab")).toBe("#/ws/ws-a/run/setups?tab=scenarios&set=derived-0123456789ab");
  });
});

describe("browser safety", () => {
  it("the model file never imports the engine barrel, the content hash module or node:crypto as a value", () => {
    const src = readFileSync(new URL("../scenarios/behavioralShockModel.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import\s+([^;]*?)\s+from\s+"([^"]+)";/gm)].map((m) => ({ clause: m[1]!, from: m[2]! }));
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i.from).not.toContain("runtime/contentHash");
      expect(i.from).not.toBe("node:crypto");
      if (i.from === "@alm/engine") expect(i.clause.startsWith("type ")).toBe(true);
    }
  });
  it("holds neither an em-dash nor a section sign", () => {
    const src = readFileSync(new URL("../scenarios/behavioralShockModel.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(BANNED_CHARS);
  });
});
