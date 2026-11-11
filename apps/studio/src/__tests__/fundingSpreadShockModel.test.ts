// apps/studio/src/__tests__/fundingSpreadShockModel.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "@alm/reader";
import type { DerivedMarketSaveReply } from "@alm/reader";
import {
  addFundingOp, emptyFundingShockDraft, FUNDING_OP_CHOICES, fundingRequestOf, fundingSaveNoteOf, nodeChoices, planLinkFor,
  removeFundingOp, setFundingBase, setFundingOpField, spreadText,
  type FundingShockDraft,
} from "../scenarios/fundingSpreadShockModel";

/** The public pack's TLP nodes, restated: t = 0 pinned at 0, then 11 tenors. */
const BASE = {
  tlpNodes: [
    { tYears: 0, spread: 0 }, { tYears: 0.083333, spread: 0.002 }, { tYears: 0.25, spread: 0.002 }, { tYears: 0.5, spread: 0.0025 },
    { tYears: 1, spread: 0.0025 }, { tYears: 2, spread: 0.003 }, { tYears: 3, spread: 0.0035 }, { tYears: 5, spread: 0.0045 },
    { tYears: 7, spread: 0.0055 }, { tYears: 10, spread: 0.0065 }, { tYears: 20, spread: 0.009 }, { tYears: 30, spread: 0.01 },
  ],
};
const BASE_ID = "market-public-2026-03-31";

function withOp(over: Partial<{ tYears: number | null; op: "add" | "scale"; valueText: string }>, d?: FundingShockDraft): FundingShockDraft {
  const added = addFundingOp(d ?? setFundingBase(emptyFundingShockDraft(), BASE_ID));
  const key = added.ops[added.ops.length - 1]!.key;
  return setFundingOpField(added, key, over);
}

describe("draft helpers", () => {
  it("starts empty with no base", () => {
    expect(emptyFundingShockDraft()).toEqual({ baseId: null, ops: [], label: "", id: "", nextKey: 0 });
  });
  it("a new op reaches every node and adds", () => {
    const d = addFundingOp(setFundingBase(emptyFundingShockDraft(), BASE_ID));
    expect(d.ops).toEqual([{ key: 0, tYears: null, op: "add", valueText: "" }]);
    expect(d.nextKey).toBe(1);
  });
  it("another base drops the ops", () => {
    const d = setFundingBase(withOp({ valueText: "50" }), "other");
    expect(d.baseId).toBe("other");
    expect(d.ops).toEqual([]);
  });
  it("removal keeps the key counter, so the next op takes a fresh key", () => {
    let d = withOp({ valueText: "1" });
    d = withOp({ valueText: "2" }, d);
    d = removeFundingOp(d, 0);
    expect(d.ops.map((o) => o.key)).toEqual([1]);
    expect(addFundingOp(d).ops.map((o) => o.key)).toEqual([1, 2]);
  });
  it("edits one row by key", () => {
    let d = withOp({ valueText: "1" });
    d = withOp({ valueText: "2" }, d);
    d = setFundingOpField(d, 1, { tYears: 10, op: "scale" });
    expect(d.ops).toEqual([
      { key: 0, tYears: null, op: "add", valueText: "1" },
      { key: 1, tYears: 10, op: "scale", valueText: "2" },
    ]);
  });
  it("offers Add (bp) and Scale by", () => {
    expect(FUNDING_OP_CHOICES).toEqual([{ op: "add", text: "Add (bp)" }, { op: "scale", text: "Scale by" }]);
  });
});

describe("nodeChoices", () => {
  const c = nodeChoices(BASE);
  it("has 12 options: every node first, then the 11 tenors above zero", () => {
    expect(c).toHaveLength(12);
    expect(c[0]).toEqual({ tYears: null, text: "Every node except t = 0 (pinned at 0)" });
    expect(c.slice(1).every((o) => o.tYears !== null && o.tYears > 0)).toBe(true);
  });
  it("labels a tenor and its stored spread", () => {
    expect(c[1]).toEqual({ tYears: 0.083333, text: "1M, stored 0.2000%" });
    expect(c.find((o) => o.tYears === 10)?.text).toBe("10Y, stored 0.6500%");
  });
  it("has no option for t = 0", () => {
    expect(c.some((o) => o.tYears === 0)).toBe(false);
  });
});

describe("fundingRequestOf", () => {
  it("blocks with no base", () => {
    expect(fundingRequestOf(emptyFundingShockDraft(), null)).toEqual({ block: "Pick a base market" });
  });
  it("blocks while the base is read", () => {
    expect(fundingRequestOf(setFundingBase(emptyFundingShockDraft(), BASE_ID), null)).toEqual({ block: "Reading the base market" });
  });
  it("blocks with no op", () => {
    expect(fundingRequestOf(setFundingBase(emptyFundingShockDraft(), BASE_ID), BASE)).toEqual({ block: "Add an op" });
  });
  it("blocks on a value that is not a number", () => {
    expect(fundingRequestOf(withOp({ valueText: "" }), BASE)).toEqual({ block: "Enter a number" });
    expect(fundingRequestOf(withOp({ valueText: "abc" }), BASE)).toEqual({ block: "Enter a number" });
  });
  it("an every-node add omits the target", () => {
    expect(fundingRequestOf(withOp({ valueText: "50" }), BASE)).toEqual({ body: { baseId: BASE_ID, ops: [{ op: "add", value: 50 }] } });
  });
  it("a 10Y add carries the target tenor", () => {
    expect(fundingRequestOf(withOp({ tYears: 10, valueText: "25" }), BASE)).toEqual({
      body: { baseId: BASE_ID, ops: [{ target: { tYears: 10 }, op: "add", value: 25 }] },
    });
  });
  it("a scale op carries its kind and the typed factor", () => {
    expect(fundingRequestOf(withOp({ op: "scale", valueText: "1.5" }), BASE)).toEqual({ body: { baseId: BASE_ID, ops: [{ op: "scale", value: 1.5 }] } });
  });
  it("trims id and label and omits them when empty", () => {
    const d = { ...withOp({ valueText: "50" }), label: "  x ", id: "   " };
    expect(fundingRequestOf(d, BASE)).toEqual({ body: { baseId: BASE_ID, ops: [{ op: "add", value: 50 }], label: "x" } });
    const e = { ...withOp({ valueText: "50" }), id: " my-id " };
    expect(fundingRequestOf(e, BASE)).toEqual({ body: { baseId: BASE_ID, ops: [{ op: "add", value: 50 }], id: "my-id" } });
  });
});

describe("spreadText", () => {
  it("prints a spread as a percent to four places", () => {
    expect(spreadText(0.00375)).toBe("0.3750%");
    expect(spreadText(0)).toBe("0.0000%");
  });
});

describe("fundingSaveNoteOf", () => {
  const reply = (outcome: "created" | "unchanged"): DerivedMarketSaveReply => ({
    outcome, id: "derived-mk-cc5f69059269", label: "L", snapshot: {} as DerivedMarketSaveReply["snapshot"], changes: [], indexChanges: [], volChanges: [], termFundingQuotesDropped: 11,
  });
  it("a 201 names the id", () => {
    expect(fundingSaveNoteOf(reply("created"))).toEqual({ kind: "created", text: "Saved as derived-mk-cc5f69059269", problems: [], savedId: "derived-mk-cc5f69059269" });
  });
  it("a 200 says it was already saved", () => {
    expect(fundingSaveNoteOf(reply("unchanged"))).toEqual({
      kind: "unchanged", text: "derived-mk-cc5f69059269 already saved with this content", problems: [], savedId: "derived-mk-cc5f69059269",
    });
  });
  it("a 409 is a conflict with the server's text", () => {
    const e = new ApiError(409, "conflict", 'market "x" already exists with different content (the store is append-only); save it under a new id');
    expect(fundingSaveNoteOf(e)).toMatchObject({
      kind: "conflict", text: '409: market "x" already exists with different content (the store is append-only); save it under a new id', savedId: null,
    });
  });
  it("a 422 lists both problems the server sent", () => {
    const e = new ApiError(422, "validation", "derived market refused: 2 problem(s); every problem is listed: a; b", {
      problems: [{ at: "ops[0]", message: "ops[0]: first" }, { at: "ops[1]", message: "ops[1]: second" }],
    });
    expect(fundingSaveNoteOf(e)).toEqual({ kind: "refused", text: "Refused: every problem is listed.", problems: ["ops[0]: first", "ops[1]: second"], savedId: null });
  });
  it("a plain error prints its page line", () => {
    expect(fundingSaveNoteOf(new Error("boom"))).toMatchObject({ kind: "error", text: "boom", problems: [], savedId: null });
  });
});

describe("planLinkFor", () => {
  it("links Run setups in the workspace, carrying the page state and not the book", () => {
    expect(planLinkFor("ws-a", {})).toBe("#/ws/ws-a/run/setups");
    expect(planLinkFor("ws-a", { book: "b1", plan: "p1" })).toBe("#/ws/ws-a/run/setups?plan=p1");
  });
});

describe("browser safety", () => {
  const src = readFileSync(new URL("../scenarios/fundingSpreadShockModel.ts", import.meta.url), "utf8");
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
