// apps/studio/src/__tests__/volatilityShockModel.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addVolOp, atmRows, emptyVolShockDraft, expiryChoices, removeVolOp, setVolBase, setVolOpField, VOL_OP_CHOICES, volRequestOf,
  type VolShockDraft,
} from "../scenarios/volatilityShockModel";

/** A fixture shaped like the public pack's capQuotes: 15 at-the-money expiries (1Y 63.45 bp and 30Y 54.44 bp are the pack's own values), each with one wing quote beside it. */
const ATM: Array<[number, number]> = [
  [1, 0.006345], [2, 0.006212], [3, 0.006117], [4, 0.006044], [5, 0.005984], [6, 0.005933], [7, 0.005890], [8, 0.005851],
  [9, 0.005816], [10, 0.005785], [12, 0.005730], [15, 0.005662], [20, 0.005572], [25, 0.005502], [30, 0.005444],
];
const BASE = {
  capQuotes: ATM.flatMap(([expiryYears, normalVol]) => [
    { expiryYears, strike: 0.02, normalVol: normalVol + 0.0003, isAtm: false },
    { expiryYears, strike: null, normalVol, isAtm: true },
  ]),
};
const BASE_ID = "market-public-2026-03-31";

function withOp(over: Partial<{ expiryYears: number | null; op: "scale-short-rate-vol" | "add-short-rate-vol"; valueText: string }>, d?: VolShockDraft): VolShockDraft {
  const added = addVolOp(d ?? setVolBase(emptyVolShockDraft(), BASE_ID));
  const key = added.ops[added.ops.length - 1]!.key;
  return setVolOpField(added, key, over);
}

describe("draft helpers", () => {
  it("starts empty with no base", () => {
    expect(emptyVolShockDraft()).toEqual({ baseId: null, ops: [], label: "", id: "", nextKey: 0 });
  });
  it("a new op reaches every expiry and scales", () => {
    const d = addVolOp(setVolBase(emptyVolShockDraft(), BASE_ID));
    expect(d.ops).toEqual([{ key: 0, expiryYears: null, op: "scale-short-rate-vol", valueText: "" }]);
    expect(d.nextKey).toBe(1);
  });
  it("another base drops the ops", () => {
    const d = setVolBase(withOp({ valueText: "1.5" }), "other");
    expect(d.baseId).toBe("other");
    expect(d.ops).toEqual([]);
  });
  it("removal keeps the key counter, so the next op takes a fresh key", () => {
    let d = withOp({ valueText: "1" });
    d = withOp({ valueText: "2" }, d);
    d = removeVolOp(d, 0);
    expect(d.ops.map((o) => o.key)).toEqual([1]);
    expect(addVolOp(d).ops.map((o) => o.key)).toEqual([1, 2]);
  });
  it("edits one row by key", () => {
    let d = withOp({ valueText: "1" });
    d = withOp({ valueText: "2" }, d);
    d = setVolOpField(d, 1, { expiryYears: 10, op: "add-short-rate-vol" });
    expect(d.ops).toEqual([
      { key: 0, expiryYears: null, op: "scale-short-rate-vol", valueText: "1" },
      { key: 1, expiryYears: 10, op: "add-short-rate-vol", valueText: "2" },
    ]);
  });
  it("offers Scale by and Add (bp)", () => {
    expect(VOL_OP_CHOICES).toEqual([{ op: "scale-short-rate-vol", text: "Scale by" }, { op: "add-short-rate-vol", text: "Add (bp)" }]);
  });
});

describe("atmRows and expiryChoices", () => {
  it("atmRows keeps the at-the-money quotes only, in stored order, with the stored value", () => {
    const rows = atmRows(BASE);
    expect(rows).toHaveLength(15);
    expect(rows[0]).toEqual({ expiryYears: 1, normalVol: 0.006345 });
    expect(rows[14]).toEqual({ expiryYears: 30, normalVol: 0.005444 });
    expect(rows.map((r) => r.expiryYears)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30]);
  });
  it("has 16 options: every expiry first, then the 15 at-the-money expiries", () => {
    const c = expiryChoices(BASE);
    expect(c).toHaveLength(16);
    expect(c[0]).toEqual({ expiryYears: null, text: "Every expiry" });
    expect(c[1]).toEqual({ expiryYears: 1, text: "1Y, stored 63.45 bp" });
    expect(c.find((o) => o.expiryYears === 30)?.text).toBe("30Y, stored 54.44 bp");
  });
  it("has no option for a strike-only expiry", () => {
    const c = expiryChoices({ capQuotes: [{ expiryYears: 3, strike: 0.02, normalVol: 0.007, isAtm: false }, ...BASE.capQuotes.slice(0, 2)] });
    expect(c.map((o) => o.expiryYears)).toEqual([null, 1]);
  });
});

describe("volRequestOf", () => {
  it("blocks with no base", () => {
    expect(volRequestOf(emptyVolShockDraft(), null)).toEqual({ block: "Pick a base market" });
  });
  it("blocks while the base is read", () => {
    expect(volRequestOf(setVolBase(emptyVolShockDraft(), BASE_ID), null)).toEqual({ block: "Reading the base market" });
  });
  it("blocks with no op", () => {
    expect(volRequestOf(setVolBase(emptyVolShockDraft(), BASE_ID), BASE)).toEqual({ block: "Add an op" });
  });
  it("blocks on a value that is not a number", () => {
    expect(volRequestOf(withOp({ valueText: "abc" }), BASE)).toEqual({ block: "Enter a number" });
    expect(volRequestOf(withOp({ valueText: "" }), BASE)).toEqual({ block: "Enter a number" });
  });
  it("an every-expiry scale of 1.5 omits the target", () => {
    const r = volRequestOf(withOp({ valueText: "1.5" }), BASE);
    expect(r).toEqual({ body: { baseId: BASE_ID, ops: [{ op: "scale-short-rate-vol", value: 1.5 }] } });
    expect("body" in r && "target" in r.body.ops[0]!).toBe(false);
  });
  it("a 1-year add of 10 carries the target expiry", () => {
    expect(volRequestOf(withOp({ expiryYears: 1, op: "add-short-rate-vol", valueText: "10" }), BASE)).toEqual({
      body: { baseId: BASE_ID, ops: [{ target: { expiryYears: 1 }, op: "add-short-rate-vol", value: 10 }] },
    });
  });
  it("trims id and label and omits them when empty", () => {
    const d = { ...withOp({ valueText: "1.5" }), label: "  x ", id: "   " };
    expect(volRequestOf(d, BASE)).toEqual({ body: { baseId: BASE_ID, ops: [{ op: "scale-short-rate-vol", value: 1.5 }], label: "x" } });
    const e = { ...withOp({ valueText: "1.5" }), id: " my-id " };
    expect(volRequestOf(e, BASE)).toEqual({ body: { baseId: BASE_ID, ops: [{ op: "scale-short-rate-vol", value: 1.5 }], id: "my-id" } });
  });
});

describe("browser safety", () => {
  const src = readFileSync(new URL("../scenarios/volatilityShockModel.ts", import.meta.url), "utf8");
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
  it("applies no arithmetic operator to a vol: no multiplication or division outside comments", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code.match(/\* /g) ?? []).toHaveLength(0);
    expect(code.match(/\/ /g) ?? []).toHaveLength(0);
  });
});
