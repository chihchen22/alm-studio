// apps/studio/src/__tests__/rateIndexModel.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "@alm/reader";
import type { DerivedCurveListRow, DerivedMarketSaveReply } from "@alm/reader";
import {
  addHistoryOp, addRateIndexOp, baseOf, emptyRateIndexDraft, indexRows, kindDefaults, levelEcho, NO_SPREAD_CURVE, parentChoices, planLinkFor, RATE_INDEX_TENOR_CHOICES, rateIndexRequestOf, rateIndexSaveNoteOf,
  removeRateIndexOp, setRateIndexMarket, setRateIndexOpField, shiftChoices, spreadCurveChoices, spreadCurveText, tenorText,
  type RateIndexDraft, type RateIndexOpDraft, type RateIndexSource,
} from "../market/rateIndexModel";

/** The number block, restated as a literal rather than read from the module the code under test uses. */
const ENTER_A_NUMBER = "Enter a number";

const PUBLIC_ID = "market-public-2026-03-31";
const SEED_ID = "rate-indices-demo-v1";

/** The three seed ops, restated from the seeded demonstration market. */
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
] as const;

const PLAIN: RateIndexSource = {};
const SEEDED: RateIndexSource = {
  rateIndices: [
    { id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basis: 0.03 },
    { id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basis: 0 },
    { id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basis: 0 },
  ],
  derivedFrom: { baseId: PUBLIC_ID, baseContentHash: "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651", ops: SEED_OPS.map((o) => ({ ...o })) },
};

function withRow(kind: "set" | "shift", over: Partial<Omit<RateIndexOpDraft, "key">>, d?: RateIndexDraft, marketId = PUBLIC_ID): RateIndexDraft {
  const added = addRateIndexOp(d ?? setRateIndexMarket(emptyRateIndexDraft(), marketId), kind);
  return setRateIndexOpField(added, added.ops[added.ops.length - 1]!.key, over);
}

describe("draft helpers", () => {
  it("starts empty with no market", () => {
    expect(emptyRateIndexDraft()).toEqual({ marketId: null, ops: [], label: "", id: "", nextKey: 0 });
  });
  it("a new set row is a one-month index with nothing typed, a new shift row names no index", () => {
    const d = addRateIndexOp(addRateIndexOp(setRateIndexMarket(emptyRateIndexDraft(), PUBLIC_ID), "set"), "shift");
    expect(d.ops).toEqual([
      { key: 0, kind: "set", indexId: "", label: "", tenorMonths: 1, valueText: "" },
      { key: 1, kind: "shift", indexId: "", label: "", tenorMonths: 1, valueText: "" },
    ]);
    expect(d.nextKey).toBe(2);
  });
  it("another market drops the ops, which belong to the old market's indices", () => {
    const d = setRateIndexMarket(withRow("set", { indexId: "x" }), SEED_ID);
    expect(d.marketId).toBe(SEED_ID);
    expect(d.ops).toEqual([]);
  });
  it("removal keeps the key counter, so the next row takes a fresh key", () => {
    let d = withRow("set", { indexId: "a" });
    d = withRow("set", { indexId: "b" }, d);
    d = removeRateIndexOp(d, 0);
    expect(d.ops.map((o) => o.key)).toEqual([1]);
    expect(addRateIndexOp(d, "shift").ops.map((o) => o.key)).toEqual([1, 2]);
  });
  it("edits one row by key", () => {
    let d = withRow("set", { indexId: "a", valueText: "1" });
    d = withRow("set", { indexId: "b", valueText: "2" }, d);
    d = setRateIndexOpField(d, 1, { tenorMonths: 6, label: "B" });
    expect(d.ops[0]).toEqual({ key: 0, kind: "set", indexId: "a", label: "", tenorMonths: 1, valueText: "1" });
    expect(d.ops[1]).toEqual({ key: 1, kind: "set", indexId: "b", label: "B", tenorMonths: 6, valueText: "2" });
  });
  it("offers the four tenors the engine accepts", () => {
    expect(RATE_INDEX_TENOR_CHOICES).toEqual([
      { tenorMonths: 1, text: "1 month" }, { tenorMonths: 3, text: "3 months" }, { tenorMonths: 6, text: "6 months" }, { tenorMonths: 12, text: "12 months" },
    ]);
  });
});

describe("indexRows and tenorText", () => {
  it("prints the stored indices with the basis as a percent to four places and the tenor in words", () => {
    expect(indexRows(SEEDED)).toEqual([
      { id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorText: "1 month", basisText: "3.0000%" },
      { id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorText: "1 month", basisText: "0.0000%" },
      { id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorText: "3 months", basisText: "0.0000%" },
    ]);
  });
  it("a market with no block has no rows", () => {
    expect(indexRows(PLAIN)).toEqual([]);
  });
  it("tenorText", () => {
    expect([1, 3, 6, 12].map(tenorText)).toEqual(["1 month", "3 months", "6 months", "12 months"]);
  });
});

describe("baseOf", () => {
  it("a market that is not derived is its own base, with nothing carried", () => {
    expect(baseOf(PUBLIC_ID, PLAIN)).toEqual({ baseId: PUBLIC_ID, carried: [] });
  });
  it("a derived market builds on its immediate base and carries its own ops", () => {
    const b = baseOf(SEED_ID, SEEDED);
    expect(b.baseId).toBe(PUBLIC_ID);
    expect(b.carried).toEqual(SEED_OPS);
  });
  it("the immediate base need not be the root", () => {
    const chained: RateIndexSource = { derivedFrom: { baseId: "derived-mk-aaaaaaaaaaaa", baseContentHash: "h", ops: [{ op: "add", value: 50 }] } };
    expect(baseOf("derived-mk-bbbbbbbbbbbb", chained)).toEqual({ baseId: "derived-mk-aaaaaaaaaaaa", carried: [{ op: "add", value: 50 }] });
  });
});

describe("rateIndexRequestOf", () => {
  it("blocks with no market, while it is read, and with no row", () => {
    expect(rateIndexRequestOf(emptyRateIndexDraft(), null)).toEqual({ block: "Pick a market" });
    expect(rateIndexRequestOf(setRateIndexMarket(emptyRateIndexDraft(), PUBLIC_ID), null)).toEqual({ block: "Reading the market" });
    expect(rateIndexRequestOf(setRateIndexMarket(emptyRateIndexDraft(), PUBLIC_ID), PLAIN)).toEqual({ block: "Add an op" });
  });
  it("blocks a set row with no id, no label, or no number, in that order", () => {
    expect(rateIndexRequestOf(withRow("set", { label: "P", valueText: "1" }), PLAIN)).toEqual({ block: "Enter an index id" });
    expect(rateIndexRequestOf(withRow("set", { indexId: "   ", label: "P", valueText: "1" }), PLAIN)).toEqual({ block: "Enter an index id" });
    expect(rateIndexRequestOf(withRow("set", { indexId: "p", valueText: "1" }), PLAIN)).toEqual({ block: "Enter a label" });
    expect(rateIndexRequestOf(withRow("set", { indexId: "p", label: "P" }), PLAIN)).toEqual({ block: "Enter a number" });
    expect(rateIndexRequestOf(withRow("set", { indexId: "p", label: "P", valueText: "abc" }), PLAIN)).toEqual({ block: "Enter a number" });
  });
  it("blocks a shift row that names no index, then one with no number", () => {
    expect(rateIndexRequestOf(withRow("shift", { valueText: "25" }, undefined, SEED_ID), SEEDED)).toEqual({ block: "Pick an index" });
    expect(rateIndexRequestOf(withRow("shift", { indexId: "prime-demo" }, undefined, SEED_ID), SEEDED)).toEqual({ block: "Enter a number" });
  });
  it("a set row on a market that is not derived builds on that market", () => {
    const d = withRow("set", { indexId: "prime-x", label: "P", tenorMonths: 3, valueText: "150" });
    expect(rateIndexRequestOf(d, PLAIN)).toEqual({
      body: { baseId: PUBLIC_ID, ops: [{ op: "set-index", id: "prime-x", label: "P", tenorMonths: 3, basisBp: 150 }] },
    });
  });
  it("a shift row on the seeded market builds on its base, carrying the seed ops first", () => {
    const d = withRow("shift", { indexId: "prime-demo", valueText: "25" }, undefined, SEED_ID);
    expect(rateIndexRequestOf(d, SEEDED)).toEqual({
      body: { baseId: PUBLIC_ID, ops: [...SEED_OPS, { op: "add-index-basis", indexId: "prime-demo", value: 25 }] },
    });
  });
  it("a market whose base is a derived market builds on that base", () => {
    const chained: RateIndexSource = { derivedFrom: { baseId: "derived-mk-aaaaaaaaaaaa", baseContentHash: "h", ops: [{ op: "add", value: 50 }] } };
    const d = withRow("set", { indexId: "x", label: "X", valueText: "0" }, undefined, "derived-mk-bbbbbbbbbbbb");
    const r = rateIndexRequestOf(d, chained);
    expect("body" in r && r.body.baseId).toBe("derived-mk-aaaaaaaaaaaa");
    expect("body" in r && r.body.ops).toEqual([{ op: "add", value: 50 }, { op: "set-index", id: "x", label: "X", tenorMonths: 1, basisBp: 0 }]);
  });
  it("trims id, label and the typed index id, and leaves the optional fields out when empty", () => {
    const d = { ...withRow("set", { indexId: " p ", label: " P ", valueText: "5" }), label: "  L ", id: "  " };
    expect(rateIndexRequestOf(d, PLAIN)).toEqual({
      body: { baseId: PUBLIC_ID, ops: [{ op: "set-index", id: "p", label: "P", tenorMonths: 1, basisBp: 5 }], label: "L" },
    });
    const e = { ...withRow("set", { indexId: "p", label: "P", valueText: "5" }), id: " my-id " };
    expect(rateIndexRequestOf(e, PLAIN)).toMatchObject({ body: { id: "my-id" } });
  });
  it("a set row that names a derived curve sends its id as spreadCurve (Piece B, step B2)", () => {
    const d = withRow("set", { indexId: "p", label: "P", tenorMonths: 3, valueText: "5", spreadCurve: "ust-sofr" });
    expect(rateIndexRequestOf(d, PLAIN)).toEqual({
      body: { baseId: PUBLIC_ID, ops: [{ op: "set-index", id: "p", label: "P", tenorMonths: 3, basisBp: 5, spreadCurve: "ust-sofr" }] },
    });
  });
  it("a set row with no derived curve, or the None choice, leaves the spreadCurve key out", () => {
    for (const over of [{}, { spreadCurve: undefined }, { spreadCurve: "" }]) {
      const r = rateIndexRequestOf(withRow("set", { indexId: "p", label: "P", valueText: "5", ...over }), PLAIN);
      const op = "body" in r ? r.body.ops[0]! : null;
      expect(op).not.toBeNull();
      expect("spreadCurve" in op!).toBe(false);
    }
  });
  it("a shift row never sends spreadCurve, even if the draft carried one", () => {
    const r = rateIndexRequestOf(withRow("shift", { indexId: "prime-demo", valueText: "25", spreadCurve: "ust-sofr" }, undefined, SEED_ID), SEEDED);
    const op = "body" in r ? r.body.ops[r.body.ops.length - 1]! : null;
    expect(op).toEqual({ op: "add-index-basis", indexId: "prime-demo", value: 25 });
    expect("spreadCurve" in op!).toBe(false);
  });
});

describe("index kinds on a set row (Piece B, step B3a)", () => {
  const opOf = (d: RateIndexDraft) => {
    const r = rateIndexRequestOf(d, SEEDED);
    if (!("body" in r)) throw new Error(r.block);
    return r.body.ops[r.body.ops.length - 1];
  };
  it("a row with no kind sends the pre-B3a op, with no kind key", () => {
    const op = opOf(withRow("set", { indexId: "rfr-6m", label: "Six", tenorMonths: 6, valueText: "0" }, undefined, SEED_ID));
    expect(op).toEqual({ op: "set-index", id: "rfr-6m", label: "Six", tenorMonths: 6, basisBp: 0 });
    expect("kind" in op!).toBe(false);
  });
  it("a swap row sends kind and tenorYears", () => {
    expect(opOf(withRow("set", { ...kindDefaults("constant-maturity-swap"), indexId: "cms-10y", label: "Ten-year swap", valueText: "0" }, undefined, SEED_ID))).toEqual({
      op: "set-index", id: "cms-10y", label: "Ten-year swap", kind: "constant-maturity-swap", tenorYears: 10, basisBp: 0,
    });
  });
  it("a beta row sends parent, beta, startBp and the optional fields typed, leaving the empty ones out", () => {
    const row = { ...kindDefaults("formula"), form: "change" as const, indexId: "admin-rate", label: "Administered rate", parent: "rfr-1m", factorText: "0.4", startText: "433", lagText: "2", floorText: "0", capText: "", valueText: "0" };
    expect(opOf(withRow("set", row, undefined, SEED_ID))).toEqual({
      op: "set-index", id: "admin-rate", label: "Administered rate", kind: "formula", parent: "rfr-1m", beta: 0.4, startBp: 433, lagMonths: 2, floorBp: 0, basisBp: 0,
    });
  });
  it("a level row sends its coefficient and no startBp, even with a start typed before the form changed", () => {
    const row = { ...kindDefaults("formula"), indexId: "prime-f", label: "Prime as a formula", parent: "rfr-1m", factorText: "1.2", startText: "433", valueText: "300" };
    const op = opOf(withRow("set", row, undefined, SEED_ID));
    expect(op).toEqual({ op: "set-index", id: "prime-f", label: "Prime as a formula", kind: "formula", parent: "rfr-1m", coefficient: 1.2, basisBp: 300 });
    // The exact object, key order included.
    expect(JSON.stringify(op)).toBe('{"op":"set-index","id":"prime-f","label":"Prime as a formula","kind":"formula","parent":"rfr-1m","coefficient":1.2,"basisBp":300}');
  });
  it.each([
    [{ parent: "" }, "Pick a parent index"],
    [{ factorText: "" }, "Enter a beta"],
    [{ startText: "" }, "Enter a start value"],
    [{ lagText: "two" }, ENTER_A_NUMBER],
  ])("blocks a beta row with %j", (over, block) => {
    const row = { ...kindDefaults("formula"), form: "change" as const, indexId: "a", label: "A", parent: "rfr-1m", factorText: "0.4", startText: "433", valueText: "0", ...over };
    expect(rateIndexRequestOf(withRow("set", row, undefined, SEED_ID), SEEDED)).toEqual({ block });
  });
  it("a level row with no coefficient asks for one; switching to a formula drops the derived curve", () => {
    const row = { ...kindDefaults("formula"), indexId: "a", label: "A", parent: "rfr-1m", factorText: "", valueText: "0" };
    expect(rateIndexRequestOf(withRow("set", row, undefined, SEED_ID), SEEDED)).toEqual({ block: "Enter a coefficient" });
    expect(kindDefaults("formula")).toEqual({ indexKind: "formula", form: "level", spreadCurve: undefined });
    expect(kindDefaults("constant-maturity-swap")).toEqual({ indexKind: "constant-maturity-swap", tenorYears: 10 });
  });
  it("offers as parents the market's indices and set rows above, never the row itself", () => {
    let d = withRow("set", { ...kindDefaults("constant-maturity-swap"), indexId: "cms-10y", label: "Swap", valueText: "0" }, undefined, SEED_ID);
    d = withRow("set", { ...kindDefaults("formula"), indexId: "prime-demo", label: "Prime as formula" }, d);
    expect(parentChoices(SEEDED, d, d.ops[1]!.key).map((c) => c.id)).toEqual(["rfr-1m", "rfr-3m", "cms-10y"]);
  });
  it("echoes a typed basis-point level as a percent", () => {
    expect(levelEcho("433")).toBe("433 bp is 4.33 percent");
    expect(levelEcho("")).toBeNull();
    expect(levelEcho("x")).toBeNull();
  });
});

describe("derived curves on rate indices (Piece B, step B2)", () => {
  it("indexRows carries an index's spreadCurve, and leaves the key out for one that reads the base curve", () => {
    const src: RateIndexSource = { rateIndices: [
      { id: "sofr-3m-idx", label: "Three-month term", tenorMonths: 3, basis: 0, spreadCurve: "ust-sofr" },
      { id: "rfr-1m", label: "One-month", tenorMonths: 1, basis: 0 },
    ] };
    const rows = indexRows(src);
    expect(rows[0]).toEqual({ id: "sofr-3m-idx", label: "Three-month term", tenorText: "3 months", basisText: "0.0000%", spreadCurve: "ust-sofr" });
    expect("spreadCurve" in rows[1]!).toBe(false);
    expect(spreadCurveText(rows[0]!.spreadCurve)).toBe("ust-sofr");
    expect(spreadCurveText(rows[1]!.spreadCurve)).toBe(NO_SPREAD_CURVE);
    expect(NO_SPREAD_CURVE).toBe("None (base curve)");
  });
  it("offers each listed derived curve by its own id, never the document id, with its label and base", () => {
    const listed: DerivedCurveListRow[] = [
      { id: "dc-0123456789abcdef", curveId: "ust-sofr", label: "Treasury over SOFR", base: "sofr-main", spreads: [{ tenorMonths: 3, spreadBp: 8 }] },
      { id: "dc-fedcba9876543210", curveId: "prime-x", label: "", base: "platform-default", spreads: [{ tenorMonths: 1, spreadBp: 300 }] },
    ];
    expect(spreadCurveChoices(listed)).toEqual([
      { id: "ust-sofr", text: "ust-sofr: Treasury over SOFR (on sofr-main)" },
      { id: "prime-x", text: "prime-x (on platform-default)" },
    ]);
  });
});

describe("shiftChoices", () => {
  it("lists the indices the chosen market carries, then those a set row above adds", () => {
    let d = withRow("set", { indexId: "new-one", label: "New one" }, undefined, SEED_ID);
    d = withRow("shift", {}, d, SEED_ID);
    const key = d.ops[1]!.key;
    expect(shiftChoices(SEEDED, d, key).map((c) => c.id)).toEqual(["prime-demo", "rfr-1m", "rfr-3m", "new-one"]);
  });
  it("a set row below, or a set row with no id, adds nothing", () => {
    let d = withRow("shift", {}, undefined, SEED_ID);
    d = withRow("set", { indexId: "later" }, d, SEED_ID);
    d = withRow("set", { indexId: "  " }, d, SEED_ID);
    expect(shiftChoices(SEEDED, d, d.ops[0]!.key).map((c) => c.id)).toEqual(["prime-demo", "rfr-1m", "rfr-3m"]);
  });
  it("a market with no block and no set row has no choice", () => {
    const d = withRow("shift", {});
    expect(shiftChoices(PLAIN, d, d.ops[0]!.key)).toEqual([]);
  });
  it("a choice reads the id and the label", () => {
    const d = withRow("shift", {}, undefined, SEED_ID);
    expect(shiftChoices(SEEDED, d, 0)[1]).toEqual({ id: "rfr-1m", text: "rfr-1m: One-month benchmark rate (demonstration index)" });
  });
});

describe("rateIndexSaveNoteOf", () => {
  const reply = (outcome: "created" | "unchanged"): DerivedMarketSaveReply => ({
    outcome, id: "derived-mk-0123456789ab", label: "L", snapshot: {} as DerivedMarketSaveReply["snapshot"], changes: [], indexChanges: [], volChanges: [], termFundingQuotesDropped: 0,
  });
  it("a 201 names the id and a 200 says it was already saved", () => {
    expect(rateIndexSaveNoteOf(reply("created"))).toEqual({ kind: "created", text: "Saved as derived-mk-0123456789ab", problems: [], savedId: "derived-mk-0123456789ab" });
    expect(rateIndexSaveNoteOf(reply("unchanged"))).toEqual({
      kind: "unchanged", text: "derived-mk-0123456789ab already saved with this content", problems: [], savedId: "derived-mk-0123456789ab",
    });
  });
  it("a 409 is a conflict with the server's text", () => {
    const e = new ApiError(409, "conflict", 'market "x" already exists with different content (the store is append-only); save it under a new id');
    expect(rateIndexSaveNoteOf(e)).toMatchObject({
      kind: "conflict", text: '409: market "x" already exists with different content (the store is append-only); save it under a new id', savedId: null,
    });
  });
  it("a 422 lists every problem the server sent", () => {
    const e = new ApiError(422, "validation", "derived market refused", {
      problems: [{ at: "ops[3]", message: 'ops[3]: add-index-basis names rate index "nope", which market "m" does not carry at that point in the op list (it carries none)' }],
    });
    expect(rateIndexSaveNoteOf(e)).toEqual({
      kind: "refused", text: "Refused: every problem is listed.",
      problems: ['ops[3]: add-index-basis names rate index "nope", which market "m" does not carry at that point in the op list (it carries none)'], savedId: null,
    });
  });
});

describe("history rows (Piece B, step B3b)", () => {
  const H_ID = "ih-0123456789abcdef";
  it("a history row sends set-index-history after the carried ops; a clear row sends null", () => {
    const d = addHistoryOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "rfr-1m", H_ID);
    const r = rateIndexRequestOf(d, SEEDED);
    expect("body" in r && r.body.ops.at(-1)).toEqual({ op: "set-index-history", indexId: "rfr-1m", historyId: H_ID });
    const c = rateIndexRequestOf(addHistoryOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "rfr-1m", null), SEEDED);
    expect("body" in c && c.body.ops.at(-1)).toEqual({ op: "set-index-history", indexId: "rfr-1m", historyId: null });
  });
  it("blocks a history row with no index", () => {
    expect(rateIndexRequestOf(addHistoryOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "", H_ID), SEEDED)).toEqual({ block: "Pick an index" });
  });
  it("a set row still sends no historyId, so the index keeps its history (R2)", () => {
    const op = rateIndexRequestOf(withRow("set", { indexId: "rfr-1m", label: "One", tenorMonths: 1, valueText: "0" }, undefined, SEED_ID), SEEDED);
    expect("body" in op && "historyId" in op.body.ops.at(-1)!).toBe(false);
  });
  it("the indices table carries the history id when the index has one", () => {
    const src = { ...SEEDED, rateIndices: SEEDED.rateIndices!.map((r) => (r.id === "rfr-1m" ? { ...r, historyId: H_ID } : r)) };
    expect(indexRows(src).find((r) => r.id === "rfr-1m")!.historyId).toBe(H_ID);
    expect("historyId" in indexRows(SEEDED).find((r) => r.id === "rfr-1m")!).toBe(false);
  });
  it("a history row takes the next key and adds no index to the choices of a later row", () => {
    const d = addRateIndexOp(addHistoryOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "brand-new", H_ID), "shift");
    expect(d.ops[0]).toEqual({ key: 0, kind: "history", indexId: "brand-new", label: "", tenorMonths: 1, valueText: "", historyId: H_ID });
    expect(d.nextKey).toBe(2);
    expect(shiftChoices(SEEDED, d, 1).map((c) => c.id)).toEqual(["prime-demo", "rfr-1m", "rfr-3m"]);
  });
  it("a history row whose id was never set blocks rather than sending undefined", () => {
    const d = setRateIndexOpField(addHistoryOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "rfr-1m", H_ID), 0, { historyId: undefined });
    expect(rateIndexRequestOf(d, SEEDED)).toEqual({ block: "Import a history first" });
  });
});

describe("planLinkFor", () => {
  it("links Run setups in the workspace, carrying the page state and not the book", () => {
    expect(planLinkFor("ws-a", {})).toBe("#/ws/ws-a/run/setups");
    expect(planLinkFor("ws-a", { book: "b1", plan: "p1" })).toBe("#/ws/ws-a/run/setups?plan=p1");
  });
});

describe("browser safety", () => {
  const src = readFileSync(new URL("../market/rateIndexModel.ts", import.meta.url), "utf8");
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
