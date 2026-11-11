// apps/studio/src/__tests__/balanceShockModel.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError, type DerivedBalancePlanSaveReply } from "@alm/reader";
import type { BalancePlan, NewBusinessRule } from "@alm/engine";
import {
  addBalanceOp, balanceRequestOf, balanceSaveNoteOf, emptyBalanceShockDraft, familyChoices, growthRateText, knotChoices, lowersToText,
  removeBalanceOp, setBalanceBase, setBalanceOpField, setsLinkFor,
  type BalanceShockDraft,
} from "../scenarios/balanceShockModel";

/** The seeded base plan, restated: dda and mma one knot at month 12, the synthetic book's own openings. */
const PLAN: BalancePlan = {
  schemaVersion: "1.0.0",
  id: "balance-targets-demo-v1",
  label: "Deposit targets held flat at month 12 on the synthetic book (demonstration values)",
  asOf: "2026-03-31",
  targets: [
    { familyId: "dda", path: [{ month: 12, balance: 97178194 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
    { familyId: "mma", path: [{ month: 12, balance: 156318023 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
  ],
  unlistedFamilies: "runoff",
};

/** A two-knot plan to read the plural choice text. */
const TWO_KNOTS: BalancePlan = {
  ...PLAN,
  targets: [{ familyId: "dda", path: [{ month: 6, balance: 1 }, { month: 12, balance: 2 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 12 } }],
};

const BOOK = "synthetic-2500-v1";

function ready(over: { month?: number | null; op?: "add" | "scale" | "set"; value?: string; familyId?: string | null } = {}): BalanceShockDraft {
  let d = addBalanceOp(setBalanceBase(emptyBalanceShockDraft(), PLAN.id));
  d = setBalanceOpField(d, 0, { familyId: over.familyId === undefined ? "dda" : over.familyId });
  return setBalanceOpField(d, 0, { month: over.month === undefined ? 12 : over.month, op: over.op ?? "scale", valueText: over.value ?? "0.9" });
}

describe("choices", () => {
  it("one family option per target, with its knots in words", () => {
    expect(familyChoices(PLAN).map((c) => c.text)).toEqual(["dda, 1 knot at month 12", "mma, 1 knot at month 12"]);
    expect(familyChoices(TWO_KNOTS).map((c) => c.text)).toEqual(["dda, 2 knots at months 6, 12"]);
    expect(familyChoices(PLAN).map((c) => c.familyId)).toEqual(["dda", "mma"]);
  });
  it("every knot first, then one option per stored knot with its stored balance", () => {
    expect(knotChoices(PLAN, "dda")).toEqual([
      { month: null, text: "Every knot" },
      { month: 12, text: "Month 12, stored 97,178,194" },
    ]);
    expect(knotChoices(PLAN, "mma").map((c) => c.text)).toEqual(["Every knot", "Month 12, stored 156,318,023"]);
  });
  it("an unknown family offers only every knot", () => {
    expect(knotChoices(PLAN, "cash")).toEqual([{ month: null, text: "Every knot" }]);
  });
});

describe("the draft", () => {
  it("another base drops the ops", () => {
    expect(setBalanceBase(ready(), "other").ops).toEqual([]);
    expect(setBalanceBase(ready(), "other").baseId).toBe("other");
  });
  it("an added op starts as scale with an empty value", () => {
    const d = addBalanceOp(emptyBalanceShockDraft());
    expect(d.ops).toEqual([{ key: 0, familyId: null, month: null, op: "scale", valueText: "" }]);
  });
  it("a family change resets the month; the same family keeps it", () => {
    const d = ready();
    expect(setBalanceOpField(d, 0, { familyId: "mma" }).ops[0]!.month).toBeNull();
    expect(setBalanceOpField(d, 0, { familyId: "dda" }).ops[0]!.month).toBe(12);
  });
  it("keys survive a removal", () => {
    let d = addBalanceOp(addBalanceOp(addBalanceOp(emptyBalanceShockDraft())));
    d = removeBalanceOp(d, 1);
    expect(d.ops.map((o) => o.key)).toEqual([0, 2]);
    expect(addBalanceOp(d).ops.map((o) => o.key)).toEqual([0, 2, 3]);
  });
});

describe("balanceRequestOf", () => {
  it("builds the body for one knot", () => {
    expect(balanceRequestOf(ready(), PLAN, BOOK)).toEqual({
      body: { baseId: "balance-targets-demo-v1", bookId: BOOK, ops: [{ target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 }] },
    });
  });
  it("every knot gives a target with no month key", () => {
    const r = balanceRequestOf(ready({ month: null }), PLAN, BOOK);
    if (!("body" in r)) throw new Error("blocked");
    expect(r.body.ops[0]!.target).toEqual({ familyId: "dda" });
    expect("month" in r.body.ops[0]!.target).toBe(false);
  });
  it("a set with a month is a request, and an add keeps its sign", () => {
    expect(balanceRequestOf(ready({ op: "set", value: "110000000" }), PLAN, BOOK)).toMatchObject({ body: { ops: [{ op: "set", value: 110000000 }] } });
    expect(balanceRequestOf(ready({ op: "add", value: "-10000000" }), PLAN, BOOK)).toMatchObject({ body: { ops: [{ op: "add", value: -10000000 }] } });
  });
  it("blocks, in order", () => {
    expect(balanceRequestOf(ready(), PLAN, null)).toEqual({ block: "Pick a book in the top bar" });
    expect(balanceRequestOf({ ...ready(), baseId: null }, PLAN, BOOK)).toEqual({ block: "Pick a base plan" });
    expect(balanceRequestOf(ready(), null, BOOK)).toEqual({ block: "Reading the base plan" });
    expect(balanceRequestOf(ready(), { ...PLAN, id: "other" }, BOOK)).toEqual({ block: "Reading the base plan" });
    expect(balanceRequestOf(setBalanceBase(emptyBalanceShockDraft(), PLAN.id), PLAN, BOOK)).toEqual({ block: "Add an op" });
    expect(balanceRequestOf(ready({ familyId: null }), PLAN, BOOK)).toEqual({ block: "Pick a family" });
    expect(balanceRequestOf(ready({ familyId: "cash" }), PLAN, BOOK)).toEqual({ block: "Pick a family" });
    expect(balanceRequestOf(ready({ month: 6 }), PLAN, BOOK)).toEqual({ block: "Pick a knot month" });
    expect(balanceRequestOf(ready({ op: "set", month: null, value: "5" }), PLAN, BOOK)).toEqual({ block: "Set to needs a knot month" });
    expect(balanceRequestOf(ready({ value: "abc" }), PLAN, BOOK)).toEqual({ block: "Enter a number" });
    expect(balanceRequestOf(ready({ value: "" }), PLAN, BOOK)).toEqual({ block: "Enter a number" });
  });
  it("the book block comes before the base block", () => {
    expect(balanceRequestOf({ ...ready(), baseId: null }, PLAN, null)).toEqual({ block: "Pick a book in the top bar" });
  });
  it("label and id are trimmed and left out when empty", () => {
    const withText = { ...ready(), label: "  Lower dda  ", id: " my-shock " };
    expect(balanceRequestOf(withText, PLAN, BOOK)).toMatchObject({ body: { label: "Lower dda", id: "my-shock" } });
    const r = balanceRequestOf({ ...ready(), label: "   ", id: "" }, PLAN, BOOK);
    if (!("body" in r)) throw new Error("blocked");
    expect("label" in r.body).toBe(false);
    expect("id" in r.body).toBe(false);
  });
});

describe("balanceSaveNoteOf", () => {
  const reply = (outcome: "created" | "unchanged"): DerivedBalancePlanSaveReply => ({ outcome, plan: { ...PLAN, id: "derived-bp-0123456789ab" }, changes: [], rules: [] });
  it("created and unchanged name the id", () => {
    expect(balanceSaveNoteOf(reply("created"))).toEqual({ kind: "created", text: "Saved as derived-bp-0123456789ab", problems: [], savedId: "derived-bp-0123456789ab" });
    expect(balanceSaveNoteOf(reply("unchanged"))).toEqual({ kind: "unchanged", text: "derived-bp-0123456789ab already saved with this content", problems: [], savedId: "derived-bp-0123456789ab" });
  });
  it("a 409 is a conflict with the server's text", () => {
    const e = new ApiError(409, "conflict", 'balance plan "x" already exists with different content (the store is append-only); save it under a new id');
    expect(balanceSaveNoteOf(e)).toMatchObject({
      kind: "conflict",
      text: '409: balance plan "x" already exists with different content (the store is append-only); save it under a new id',
      savedId: null,
    });
  });
  it("a 422 lists every problem the server sent", () => {
    const e = new ApiError(422, "validation", "derived balance plan refused: 2 problem(s); every problem is listed: a; b", {
      problems: [{ at: "ops[0]", message: "ops[0]: first" }, { at: "targets[1]", message: "second" }],
    });
    expect(balanceSaveNoteOf(e)).toEqual({ kind: "refused", text: "Refused: every problem is listed.", problems: ["ops[0]: first", "second"], savedId: null });
  });
  it("a plain error prints its page line", () => {
    expect(balanceSaveNoteOf(new Error("boom"))).toMatchObject({ kind: "error", text: "boom", problems: [], savedId: null });
  });
});

describe("what a rule says", () => {
  const flat: NewBusinessRule = { familyId: "mma", reinvest: "flat", spreadOverIndexBp: -100, termMonths: 12 };
  const growth: NewBusinessRule = { familyId: "dda", reinvest: "growth", monthlyGrowthRate: -0.008741610954696721, spreadOverIndexBp: -100, termMonths: 12 };
  it("flat holds, growth is one rate", () => {
    expect(lowersToText(flat)).toBe("Hold flat");
    expect(lowersToText(growth)).toBe("One growth rate");
  });
  it("the rate prints as the server sent it, and a flat rule says none", () => {
    expect(growthRateText(growth)).toBe("-0.008741610954696721");
    expect(growthRateText(flat)).toBe("none");
  });
  it("the scenario choice link lands on Run setups in the workspace, and the book is not carried", () => {
    expect(setsLinkFor("ws-a", {})).toBe("#/ws/ws-a/run/setups?tab=scenarios");
    expect(setsLinkFor("ws-a", { book: "b1" })).toBe("#/ws/ws-a/run/setups?tab=scenarios");
  });
});

describe("browser safety", () => {
  const src = readFileSync(new URL("../scenarios/balanceShockModel.ts", import.meta.url), "utf8");
  it("imports the engine only as types and never the hash module or node:crypto", () => {
    const imports = [...src.matchAll(/^import\s+([^;]*?)\s+from\s+"([^"]+)";/gm)].map((m) => ({ clause: m[1]!, from: m[2]! }));
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i.from).not.toContain("runtime/contentHash");
      expect(i.from).not.toBe("node:crypto");
      if (i.from === "@alm/engine") expect(i.clause.startsWith("type ")).toBe(true);
    }
  });
  it("holds neither an em-dash nor a section sign", () => {
    expect(src).not.toMatch(new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`));
  });
});
