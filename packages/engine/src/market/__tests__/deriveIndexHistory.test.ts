/**
 * deriveMarketSnapshot and the index history id: the
 * set-index-history op, historyId on a set-index op, and a later set-index keeping the id. Fixtures and expected
 * values are restated here; the fixture, load, problemsOf, one, d and block are copied from deriveIndexKinds.test.ts.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import type { MarketWithIndices, RateIndex } from "../../contracts/rateIndex";
import { deriveMarketSnapshot, MarketDerivationError } from "../deriveMarketSnapshot";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";

let loaded: MarketSnapshot;
beforeAll(async () => {
  loaded = await loadMarketSnapshot(FIXTURE);
});
const load = (): MarketSnapshot => structuredClone(loaded);

function problemsOf(fn: () => unknown): Array<{ at: string; message: string }> {
  try {
    fn();
  } catch (e) {
    if (e instanceof MarketDerivationError) return e.problems;
    throw e;
  }
  throw new Error("expected a MarketDerivationError");
}
const one = (fn: () => unknown): { at: string; message: string } => {
  const p = problemsOf(fn);
  expect(p).toHaveLength(1);
  return p[0]!;
};
const d = (ops: unknown[], base: MarketSnapshot = load(), baseId = BASE_ID) => () => deriveMarketSnapshot(base, ops, { baseId });
const block = (r: ReturnType<typeof deriveMarketSnapshot>) => (r.snapshot as MarketWithIndices).rateIndices!;

const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];
const H = "ih-0123456789abcdef";
const H2 = "ih-fedcba9876543210";
const SET_H = { op: "set-index-history", indexId: "rfr-1m", historyId: H };
const indexed = () => deriveMarketSnapshot(load(), SEED_OPS, { baseId: BASE_ID }).snapshot;
const rfr1m = (r: ReturnType<typeof deriveMarketSnapshot>): RateIndex => block(r).find((x) => x.id === "rfr-1m")!;

describe("set-index-history (spec v6 decision 48, ruling R3)", () => {
  it("writes the id last on the index record and records the op as sent", () => {
    const r = deriveMarketSnapshot(indexed(), [SET_H], { baseId: BASE_ID });
    expect(rfr1m(r)).toEqual({ id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basis: 0, historyId: H });
    expect(Object.keys(rfr1m(r))).toEqual(["id", "label", "tenorMonths", "basis", "historyId"]);
    expect(r.snapshot.derivedFrom!.ops).toEqual([SET_H]);
    expect(r.indexChanges).toEqual([{ id: "rfr-1m", from: { id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basis: 0 }, to: rfr1m(r), basisChangeBp: 0, ops: [0] }]);
    expect(r.label).toBe(`Rate indices on ${BASE_ID} (demonstration values)`);
  });
  it("Review Focus 5: a later set-index keeps the id unless it names one; add-index-basis keeps it", () => {
    const renamed = { op: "set-index", id: "rfr-1m", label: "Renamed", tenorMonths: 1, basisBp: 5 };
    const kept = deriveMarketSnapshot(indexed(), [SET_H, renamed], { baseId: BASE_ID });
    expect(rfr1m(kept)).toEqual({ id: "rfr-1m", label: "Renamed", tenorMonths: 1, basis: 0.0005, historyId: H });
    expect("historyId" in kept.snapshot.derivedFrom!.ops[1]!).toBe(false);
    const named = deriveMarketSnapshot(indexed(), [SET_H, { ...renamed, historyId: H2 }], { baseId: BASE_ID });
    expect(rfr1m(named).historyId).toBe(H2);
    const shifted = deriveMarketSnapshot(indexed(), [SET_H, { op: "add-index-basis", indexId: "rfr-1m", value: 10 }], { baseId: BASE_ID });
    expect(rfr1m(shifted)).toEqual({ id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basis: 0.001, historyId: H });
    // On a re-derive from a market that already carries the id, a set-index without one keeps it too.
    const carried = deriveMarketSnapshot(indexed(), [SET_H], { baseId: BASE_ID }).snapshot;
    expect(rfr1m(deriveMarketSnapshot(carried, [renamed], { baseId: BASE_ID })).historyId).toBe(H);
  });
  it("null clears the id; a formula set-index may name one; any kind may carry one", () => {
    const carried = deriveMarketSnapshot(indexed(), [SET_H], { baseId: BASE_ID }).snapshot;
    const cleared = deriveMarketSnapshot(carried, [{ op: "set-index-history", indexId: "rfr-1m", historyId: null }], { baseId: BASE_ID });
    expect("historyId" in rfr1m(cleared)).toBe(false);
    const f = { op: "set-index", id: "admin-rate", label: "Administered (demonstration values)", kind: "formula", parent: "rfr-1m", beta: 0.4, startBp: 433, basisBp: 0, historyId: H2 };
    const withF = deriveMarketSnapshot(indexed(), [f], { baseId: BASE_ID });
    expect(Object.keys(block(withF).find((x) => x.id === "admin-rate")!)).toEqual(["id", "label", "kind", "parent", "beta", "start", "basis", "historyId"]);
  });
  it("a derivation whose history op changes nothing is refused in its own sentence; the existing guard texts are untouched", () => {
    const carried = deriveMarketSnapshot(indexed(), [SET_H], { baseId: BASE_ID }).snapshot;
    const text = `the ops change no TLP node, no rate index or index history, no short-rate volatility, no macro series, no curve setup and no derived curve; the derived market would carry what market "${BASE_ID}" carries`;
    expect(one(d([SET_H], carried))).toEqual({ at: "ops", message: text });
    expect(one(d([{ op: "set-index-history", indexId: "rfr-3m", historyId: null }], carried))).toEqual({ at: "ops", message: text });
    // Without a history op the B3a text stands, byte for byte.
    expect(one(d([SEED_OPS[0]], indexed())).message).toBe(`the ops change no TLP node and no rate index; the derived market would carry what market "${BASE_ID}" carries`);
  });
  it("refuses an unknown index, a bad id and an unknown field, each naming the op", () => {
    expect(one(d([{ ...SET_H, indexId: "nope" }], indexed())).message).toBe(
      `ops[0]: set-index-history names rate index "nope", which market "${BASE_ID}" does not carry at that point in the op list (it carries prime-demo, rfr-1m, rfr-3m)`,
    );
    expect(one(d([{ ...SET_H, historyId: "dc-0123456789abcdef" }], indexed())).message).toBe(
      'ops[0]: historyId must be an index history id (ih- and 16 lowercase hex characters) or null to clear the index\'s history; got "dc-0123456789abcdef"',
    );
    expect(one(d([{ ...SET_H, values: [0.04] }], indexed())).message).toBe('ops[0]: unknown field "values"; a set-index-history op carries op, indexId and historyId');
    expect(one(d([{ ...SEED_OPS[0], historyId: "x" }], indexed())).message).toBe('ops[0]: historyId must be an index history id (ih- and 16 lowercase hex characters); got "x"');
  });
  it("a history-only derivation reads no TLP node, and history ops count toward the cap of 64", () => {
    expect(() => deriveMarketSnapshot({ ...indexed(), tlpNodes: [] }, [SET_H], { baseId: BASE_ID })).not.toThrow();
    const many = Array.from({ length: 65 }, (_, i) => ({ ...SET_H, historyId: i % 2 === 0 ? H : H2 }));
    expect(one(d(many, indexed()))).toEqual({ at: "ops", message: "at most 64 ops; got 65" });
  });
  it("the block validator refuses a malformed historyId", () => {
    const bad = { ...indexed(), rateIndices: [{ id: "rfr-1m", label: "x", tenorMonths: 1, basis: 0, historyId: "x" }] };
    expect(one(d([SEED_OPS[1]], bad as never)).message).toContain('rateIndices[0].historyId: expected an index history id, ih- and 16 lowercase hex characters; got "x"');
  });
});
