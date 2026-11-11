/**
 * deriveMarketSnapshot rate index ops. Fixtures and
 * expected values are restated here; the TLP-only byte-identity hash was
 * measured on the unmodified code and is never re-pinned.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { contentHash } from "../../runtime/contentHash";
import { deriveMarketSnapshot, derivedMarketId, MarketDerivationError } from "../deriveMarketSnapshot";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";
const BASE_HASH = "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651";
const SEED_ID = "rate-indices-demo-v1";
const TLP_ONLY_HASH = "b405d1983b39e2fc4941129b15175d4b17399403c8b67a359a62f8b49f8a0e5d";
const TLP_LABEL = "TLP +50 bp on every node of the public market pack (demonstration values)";

const L1 = "One-month benchmark rate (demonstration index)";
const L3 = "Three-month benchmark term rate (demonstration index)";
const LP = "Prime-style rate, benchmark plus 300 bp (demonstration values)";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: L1, tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: L3, tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: LP, tenorMonths: 1, basisBp: 300 },
];
const SEED_BLOCK = [
  { id: "prime-demo", label: LP, tenorMonths: 1, basis: 0.03 },
  { id: "rfr-1m", label: L1, tenorMonths: 1, basis: 0 },
  { id: "rfr-3m", label: L3, tenorMonths: 3, basis: 0 },
];

let loaded: MarketSnapshot;
beforeAll(async () => {
  loaded = await loadMarketSnapshot(FIXTURE);
});
const load = (): MarketSnapshot => structuredClone(loaded);
const seedMarket = () => deriveMarketSnapshot(load(), SEED_OPS, { baseId: BASE_ID, id: SEED_ID }).snapshot;

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

describe("seed ops on the public market", () => {
  let r: ReturnType<typeof deriveMarketSnapshot>;
  beforeAll(() => {
    r = deriveMarketSnapshot(load(), SEED_OPS, { baseId: BASE_ID });
  });
  it("writes the block sorted by id in key order id, label, tenorMonths, basis", () => {
    expect(r.snapshot.rateIndices).toEqual(SEED_BLOCK);
    expect(r.snapshot.rateIndices!.map((x) => Object.keys(x).join(","))).toEqual(Array(3).fill("id,label,tenorMonths,basis"));
  });
  it("keeps the term-funding quotes and the TLP nodes, and reports none dropped", () => {
    expect(loaded.termFundingCurveQuotes).toHaveLength(11);
    expect(r.snapshot.termFundingCurveQuotes).toEqual(loaded.termFundingCurveQuotes);
    expect(r.snapshot.tlpNodes).toEqual(loaded.tlpNodes);
    expect(r.termFundingQuotesDropped).toBe(0);
    expect(r.changes).toEqual([]);
  });
  it("reports one index change per index, in first-touch order, from null", () => {
    expect(r.indexChanges).toEqual([
      { id: "rfr-1m", from: null, to: SEED_BLOCK[1], basisChangeBp: null, ops: [0] },
      { id: "rfr-3m", from: null, to: SEED_BLOCK[2], basisChangeBp: null, ops: [1] },
      { id: "prime-demo", from: null, to: SEED_BLOCK[0], basisChangeBp: null, ops: [2] },
    ]);
  });
  it("labels an index-only derivation and records the normalized ops last", () => {
    expect(r.label).toBe("Rate indices on market-public-2026-03-31 (demonstration values)");
    expect(r.snapshot.derivedFrom).toEqual({ baseId: BASE_ID, baseContentHash: BASE_HASH, ops: SEED_OPS });
    expect(Object.keys(r.snapshot).pop()).toBe("derivedFrom");
    expect(r.id).toBe("derived-mk-" + contentHash({ baseId: BASE_ID, baseContentHash: BASE_HASH, ops: SEED_OPS }).slice(0, 12));
    expect(r.id).toBe(derivedMarketId(BASE_ID, BASE_HASH, SEED_OPS as never));
  });
  it("does not mutate the base", () => {
    expect(contentHash(loaded)).toBe(BASE_HASH);
  });
});

describe("TLP-only derivation stays byte-identical", () => {
  it("hashes to the measured value and carries no rate index key", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }], { baseId: BASE_ID, id: "tlp-shock-demo-v1", label: TLP_LABEL });
    expect(contentHash(r.snapshot)).toBe(TLP_ONLY_HASH);
    expect("rateIndices" in r.snapshot).toBe(false);
    expect(r.indexChanges).toEqual([]);
    expect(r.termFundingQuotesDropped).toBe(11);
    expect(r.snapshot.termFundingCurveQuotes).toEqual([]);
    expect(r.label).toBe(TLP_LABEL);
  });
  it("keeps the TLP-only default label", () => {
    expect(deriveMarketSnapshot(load(), [{ op: "add", value: 50 }], { baseId: BASE_ID }).label).toBe("Funding spread shock on market-public-2026-03-31 (demonstration values)");
  });
});

describe("shifting a basis", () => {
  it("seed ops plus add-index-basis on the public market: 0.0325 and 25 bp", () => {
    const r = deriveMarketSnapshot(load(), [...SEED_OPS, { op: "add-index-basis", indexId: "prime-demo", value: 25 }], { baseId: BASE_ID });
    expect(r.snapshot.rateIndices!.find((x) => x.id === "prime-demo")!.basis).toBe(0.0325);
    const row = r.indexChanges.find((c) => c.id === "prime-demo")!;
    expect(row.to.basis).toBe(0.0325);
    expect(row.basisChangeBp).toBe(25);
    expect(row.from).toBeNull();
    expect(row.ops).toEqual([2, 3]);
    expect(r.indexChanges.find((c) => c.id === "rfr-1m")!.basisChangeBp).toBeNull();
  });
  it("add-index-basis on the seeded market: from 0.03 to 0.0325, 25 bp", () => {
    const r = deriveMarketSnapshot(seedMarket(), [{ op: "add-index-basis", indexId: "prime-demo", value: 25 }], { baseId: SEED_ID });
    expect(r.indexChanges).toEqual([
      { id: "prime-demo", from: SEED_BLOCK[0], to: { ...SEED_BLOCK[0], basis: 0.0325 }, basisChangeBp: 25, ops: [0] },
    ]);
    expect(r.snapshot.rateIndices).toEqual([{ ...SEED_BLOCK[0], basis: 0.0325 }, SEED_BLOCK[1], SEED_BLOCK[2]]);
  });
  it("set-index replaces an entry by id and reports the move", () => {
    const r = deriveMarketSnapshot(seedMarket(), [{ op: "set-index", id: "prime-demo", label: "  Prime, 250 bp  ", tenorMonths: 3, basisBp: 250 }], { baseId: SEED_ID });
    expect(r.snapshot.rateIndices).toEqual([
      { id: "prime-demo", label: "Prime, 250 bp", tenorMonths: 3, basis: 0.025 },
      SEED_BLOCK[1],
      SEED_BLOCK[2],
    ]);
    expect(r.indexChanges[0]!.basisChangeBp).toBe(-50);
    expect(r.snapshot.derivedFrom!.ops).toEqual([{ op: "set-index", id: "prime-demo", label: "Prime, 250 bp", tenorMonths: 3, basisBp: 250 }]);
  });
  it("rounds the stored basis to 12 significant digits", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "set-index", id: "x", label: "X", tenorMonths: 1, basisBp: 12.345 }], { baseId: BASE_ID });
    expect(r.snapshot.rateIndices![0]!.basis).toBe(0.0012345);
  });
  it("stores a negative-zero basis as zero", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "set-index", id: "x", label: "X", tenorMonths: 1, basisBp: -0 }], { baseId: BASE_ID });
    expect(Object.is(r.snapshot.rateIndices![0]!.basis, 0)).toBe(true);
  });
});

describe("mixed TLP and index ops", () => {
  it("drops the quotes, moves the TLP and adds the block", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }, SEED_OPS[0]!], { baseId: BASE_ID });
    expect(r.termFundingQuotesDropped).toBe(11);
    expect(r.snapshot.termFundingCurveQuotes).toEqual([]);
    expect(r.snapshot.tlpNodes[1]!.spread).toBe(0.007);
    expect(r.snapshot.rateIndices).toEqual([SEED_BLOCK[1]]);
    expect(r.changes.length).toBe(11);
    expect(r.indexChanges).toHaveLength(1);
    expect(r.label).toBe("Funding spread shock and rate indices on market-public-2026-03-31 (demonstration values)");
  });
  it("accepts a TLP op that changes nothing when an index op changes the block", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add", value: 0 }, SEED_OPS[0]!], { baseId: BASE_ID });
    expect(r.snapshot.rateIndices).toEqual([SEED_BLOCK[1]]);
    expect(r.termFundingQuotesDropped).toBe(11);
  });
});

describe("a base with no TLP nodes", () => {
  it("accepts an index-only derivation", () => {
    const base = { ...load(), tlpNodes: [] } as MarketSnapshot;
    const r = deriveMarketSnapshot(base, [SEED_OPS[2]!], { baseId: "no-tlp" });
    expect(r.snapshot.tlpNodes).toEqual([]);
    expect(r.snapshot.rateIndices).toEqual([SEED_BLOCK[0]]);
    expect(r.termFundingQuotesDropped).toBe(0);
  });
  it("still refuses a TLP op", () => {
    const base = { ...load(), tlpNodes: [] } as MarketSnapshot;
    expect(one(() => deriveMarketSnapshot(base, [{ op: "add", value: 5 }], { baseId: "no-tlp" })).at).toBe("base");
  });
});

describe("refusals", () => {
  const d = (ops: unknown[], base: MarketSnapshot = load(), baseId = BASE_ID) => () => deriveMarketSnapshot(base, ops, { baseId });
  it("refuses add-index-basis on an index the market does not carry", () => {
    const p = one(d([{ op: "add-index-basis", indexId: "nope", value: 5 }]));
    expect(p.at).toBe("ops[0]");
    expect(p.message).toBe('ops[0]: add-index-basis names rate index "nope", which market "market-public-2026-03-31" does not carry at that point in the op list (it carries none)');
  });
  it("lists the indices the market does carry", () => {
    const p = one(d([{ op: "add-index-basis", indexId: "nope", value: 5 }], seedMarket() as MarketSnapshot, SEED_ID));
    expect(p.message).toBe('ops[0]: add-index-basis names rate index "nope", which market "rate-indices-demo-v1" does not carry at that point in the op list (it carries prime-demo, rfr-1m, rfr-3m)');
  });
  it("refuses add-index-basis before the set-index that creates the index", () => {
    const p = problemsOf(d([{ op: "add-index-basis", indexId: "rfr-1m", value: 5 }, SEED_OPS[0]]));
    expect(p).toHaveLength(1);
    expect(p[0]!.at).toBe("ops[0]");
  });
  it("refuses an unknown field on an index op", () => {
    expect(one(d([{ ...SEED_OPS[0], curve: "x" }])).message).toBe('ops[0]: unknown field "curve"; a set-index op carries op, id, label, tenorMonths, basisBp and optionally spreadCurve and historyId');
    expect(one(d([{ op: "add-index-basis", indexId: "a", value: 1, extra: 1 }])).message).toBe('ops[0]: unknown field "extra"; an add-index-basis op carries op, indexId and value');
  });
  it("refuses a field of the wrong type", () => {
    expect(one(d([{ ...SEED_OPS[0], basisBp: "300" }])).message).toBe("ops[0]: basisBp must be a finite number of basis points");
    expect(one(d([{ ...SEED_OPS[0], id: 3 }])).message).toBe("ops[0]: id must be a string");
    expect(one(d([{ ...SEED_OPS[0], label: 3 }])).message).toBe("ops[0]: label must be a string");
    expect(one(d([{ ...SEED_OPS[0], tenorMonths: "3" }])).message).toBe("ops[0]: tenorMonths must be a number");
    expect(one(d([{ op: "add-index-basis", indexId: 1, value: 1 }])).message).toBe("ops[0]: indexId must be a string");
    expect(one(d([{ op: "add-index-basis", indexId: "a", value: Number.NaN }], seedMarket() as MarketSnapshot)).message).toBe("ops[0]: value must be a finite number of basis points");
  });
  it("refuses a basis beyond 1000 bp after the ops apply", () => {
    const p = one(d([{ ...SEED_OPS[0], basisBp: 1100 }]));
    expect(p.at).toBe("rateIndices[0].basis");
    expect(p.message).toBe("rateIndices[0].basis: expected a finite decimal between -0.1 and 0.1 (1000 bp either way); got 0.11");
  });
  it("refuses a bad id, tenor and a fifty-first index after apply", () => {
    expect(one(d([{ ...SEED_OPS[0], id: "Prime" }])).message).toBe(
      'rateIndices[0].id: expected a lowercase id of letters, digits and single hyphens, starting with a letter, at most 40 characters; got "Prime"',
    );
    expect(one(d([{ ...SEED_OPS[0], tenorMonths: 2 }])).message).toBe("rateIndices[0].tenorMonths: expected 1, 3, 6 or 12 months; got 2");
    const ops = Array.from({ length: 51 }, (_, i) => ({ op: "set-index", id: `idx-${i}`, label: "I", tenorMonths: 1, basisBp: 1 }));
    expect(one(d(ops)).message).toBe("rateIndices: at most 50 indices; got 51");
  });
  it("refuses a malformed base block", () => {
    const bad = { ...load(), rateIndices: [{ id: "A", label: "x", tenorMonths: 1, basis: 0 }] } as MarketSnapshot;
    const p = one(d([SEED_OPS[0]], bad));
    expect(p.at).toBe("base");
    expect(p.message).toContain('market "market-public-2026-03-31" carries a rateIndices block the derivation cannot read: rateIndices[0].id: expected a lowercase id');
  });
  it("refuses a TLP-only no-op with the 6c text, unchanged", () => {
    expect(one(d([{ op: "add", value: 0 }]))).toEqual({
      at: "ops",
      message: 'the ops change no TLP node; the derived market would carry what market "market-public-2026-03-31" carries',
    });
  });
  it("refuses an index no-op with its own text", () => {
    const expected = {
      at: "ops",
      message: 'the ops change no TLP node and no rate index; the derived market would carry what market "rate-indices-demo-v1" carries',
    };
    expect(one(d([{ op: "set-index", id: "rfr-1m", label: L1, tenorMonths: 1, basisBp: 0 }], seedMarket() as MarketSnapshot, SEED_ID))).toEqual(expected);
    expect(one(d([{ op: "add-index-basis", indexId: "prime-demo", value: 0 }], seedMarket() as MarketSnapshot, SEED_ID))).toEqual(expected);
  });
  it("refuses a mixed no-op with the index text", () => {
    expect(one(d([{ op: "add", value: 0 }, { op: "add-index-basis", indexId: "prime-demo", value: 0 }], seedMarket() as MarketSnapshot, SEED_ID)).message).toBe(
      'the ops change no TLP node and no rate index; the derived market would carry what market "rate-indices-demo-v1" carries',
    );
  });
  it("names the new op kinds in the unknown-kind message", () => {
    // Re-expectation: the op list now names the two short-rate volatility ops.
    expect(one(d([{ op: "set", value: 1 }])).message).toBe('ops[0]: op must be add, scale, set-index, add-index-basis, scale-short-rate-vol or add-short-rate-vol; got "set"');
  });
  it("collects problems across TLP and index ops", () => {
    const p = problemsOf(d([{ op: "set", value: 1 }, { op: "add-index-basis", indexId: "nope", value: 1 }]));
    expect(p.map((x) => x.at)).toEqual(["ops[0]", "ops[1]"]);
  });
});
