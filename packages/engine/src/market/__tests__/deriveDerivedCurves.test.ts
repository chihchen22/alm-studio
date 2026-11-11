/**
 * deriveMarketSnapshot: the spreadCurve key on set-index and the
 * set-derived-curve op. The base
 * fixture, base hash and TLP-only byte-identity hash are copied from
 * deriveRateIndices.test.ts (measured there on unmodified source);
 * they are never re-pinned here.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { contentHash } from "../../runtime/contentHash";
import { deriveMarketSnapshot, derivedMarketId, MarketDerivationError } from "../deriveMarketSnapshot";
import type { MarketWithIndices } from "../../contracts/rateIndex";
import type { MarketWithDerivedCurves } from "../../contracts/derivedCurve";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";
const BASE_HASH = "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651";
const TLP_ONLY_HASH = "b405d1983b39e2fc4941129b15175d4b17399403c8b67a359a62f8b49f8a0e5d";
const TLP_LABEL = "TLP +50 bp on every node of the public market pack (demonstration values)";

const CURVE = { id: "ust-sofr", label: "UST over SOFR", base: "platform-default", spreads: [{ tenorMonths: 3, spreadBp: 12 }, { tenorMonths: 120, spreadBp: 30 }] };

let base: MarketSnapshot;
beforeAll(async () => {
  base = await loadMarketSnapshot(FIXTURE);
});

function problemsOf(fn: () => unknown): Array<{ at: string; message: string }> {
  try {
    fn();
  } catch (e) {
    if (e instanceof MarketDerivationError) return e.problems;
    throw e;
  }
  throw new Error("expected a MarketDerivationError");
}

describe("spreadCurve on set-index", () => {
  it("set-index with spreadCurve stores it, and without it leaves the key out", () => {
    const d = deriveMarketSnapshot(base, [
      { op: "set-index", id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basisBp: 0, spreadCurve: "ust-sofr" },
      { op: "set-index", id: "sofr-1m", label: "SOFR 1M", tenorMonths: 1, basisBp: 0 },
    ], { baseId: "mk" });
    const rows = (d.snapshot as MarketWithIndices).rateIndices!;
    expect(rows.find((r) => r.id === "sofr-3m")).toEqual({ id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basis: 0, spreadCurve: "ust-sofr" });
    expect("spreadCurve" in rows.find((r) => r.id === "sofr-1m")!).toBe(false);
    // The normalized op carries spreadCurve last, and only when it was sent.
    expect(d.snapshot.derivedFrom!.ops).toEqual([
      { op: "set-index", id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basisBp: 0, spreadCurve: "ust-sofr" },
      { op: "set-index", id: "sofr-1m", label: "SOFR 1M", tenorMonths: 1, basisBp: 0 },
    ]);
    expect(Object.keys(d.snapshot.derivedFrom!.ops[1]!)).toEqual(["op", "id", "label", "tenorMonths", "basisBp"]);
  });

  it("add-index-basis keeps an index's spreadCurve", () => {
    const d = deriveMarketSnapshot(base, [
      { op: "set-index", id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basisBp: 0, spreadCurve: "ust-sofr" },
      { op: "add-index-basis", indexId: "sofr-3m", value: 25 },
    ], { baseId: "mk" });
    expect((d.snapshot as MarketWithIndices).rateIndices![0]).toMatchObject({ basis: 0.0025, spreadCurve: "ust-sofr" });
  });

  it("add-index-basis on an index without spreadCurve leaves the key out", () => {
    const seeded = deriveMarketSnapshot(base, [{ op: "set-index", id: "sofr-1m", label: "SOFR 1M", tenorMonths: 1, basisBp: 0 }], { baseId: "mk" }).snapshot;
    const d = deriveMarketSnapshot(seeded as MarketSnapshot, [{ op: "add-index-basis", indexId: "sofr-1m", value: 5 }], { baseId: "seeded" });
    const row = (d.snapshot as MarketWithIndices).rateIndices![0]!;
    expect(Object.keys(row)).toEqual(["id", "label", "tenorMonths", "basis"]);
    expect("spreadCurve" in d.indexChanges[0]!.from!).toBe(false);
  });

  it("a later set-index without spreadCurve clears it (the op replaces the index)", () => {
    const d = deriveMarketSnapshot(base, [
      { op: "set-index", id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basisBp: 0, spreadCurve: "ust-sofr" },
      { op: "set-index", id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basisBp: 5 },
    ], { baseId: "mk" });
    expect("spreadCurve" in (d.snapshot as MarketWithIndices).rateIndices![0]!).toBe(false);
  });

  it("refuses a spreadCurve that is not a string, or not a derived curve id", () => {
    const sendIt = (spreadCurve: unknown) => () =>
      deriveMarketSnapshot(base, [{ op: "set-index", id: "sofr-3m", label: "SOFR 3M", tenorMonths: 3, basisBp: 0, spreadCurve }], { baseId: "mk" });
    expect(problemsOf(sendIt(7)).map((p) => p.message)).toEqual(["ops[0]: spreadCurve must be a string"]);
    expect(problemsOf(sendIt("bad id")).map((p) => p.message)).toEqual([
      'rateIndices[0].spreadCurve: expected a derived curve id of 1 to 70 characters from A-Z a-z 0-9 . _ -; got "bad id"',
    ]);
  });
});

describe("set-derived-curve derive op", () => {
  it("set-derived-curve writes the derivedCurves block, sorted, replacing by id", () => {
    const a = { id: "b-curve", label: "B", base: "platform-default", spreads: [{ tenorMonths: 3, spreadBp: 1 }] };
    const b = { id: "a-curve", label: "A", base: "platform-default", spreads: [{ tenorMonths: 3, spreadBp: 2 }] };
    const a2 = { ...a, spreads: [{ tenorMonths: 3, spreadBp: 9 }] };
    const d = deriveMarketSnapshot(base, [{ op: "set-derived-curve", curve: a }, { op: "set-derived-curve", curve: b }, { op: "set-derived-curve", curve: a2 }], { baseId: "mk" });
    expect((d.snapshot as MarketWithDerivedCurves).derivedCurves).toEqual([b, a2]);
  });

  it("a derive with no set-derived-curve op leaves the key out and the snapshot hash unchanged", () => {
    const d = deriveMarketSnapshot(base, [{ op: "add", value: 50 }], { baseId: BASE_ID, id: "tlp-shock-demo-v1", label: TLP_LABEL });
    expect(contentHash(d.snapshot)).toBe(TLP_ONLY_HASH);
    expect("derivedCurves" in d.snapshot).toBe(false);
    const byDefault = deriveMarketSnapshot(base, [{ op: "add", value: 50 }], { baseId: BASE_ID });
    expect(byDefault.id).toBe(derivedMarketId(BASE_ID, BASE_HASH, [{ op: "add", value: 50 }]));
  });

  it("refuses an invalid curve with the validator sentence and the op position", () => {
    expect(() => deriveMarketSnapshot(base, [{ op: "set-derived-curve", curve: { id: "x", label: "", base: "platform-default", spreads: [] } }], { baseId: "mk" })).toThrow(/ops\[0\].*label/);
    expect(problemsOf(() => deriveMarketSnapshot(base, [{ op: "set-derived-curve", curve: { id: "x", label: "", base: "platform-default", spreads: [] } }], { baseId: "mk" }))).toEqual([
      { at: "ops[0]", message: `ops[0]: the derived curve's "label" must be 1 to 80 characters` },
      { at: "ops[0]", message: "ops[0]: a derived curve needs 1 to 60 spread rows" },
    ]);
  });

  it("refuses an unknown field on the op", () => {
    expect(problemsOf(() => deriveMarketSnapshot(base, [{ op: "set-derived-curve", curve: CURVE, extra: 1 }], { baseId: "mk" }))).toEqual([
      { at: "ops[0]", message: 'ops[0]: unknown field "extra"; a set-derived-curve op carries op and curve' },
    ]);
  });

  it("records the normalized op, names the derivation and keeps derivedFrom last", () => {
    const d = deriveMarketSnapshot(base, [{ op: "set-derived-curve", curve: structuredClone(CURVE) }], { baseId: BASE_ID });
    expect(d.snapshot.derivedFrom).toEqual({ baseId: BASE_ID, baseContentHash: BASE_HASH, ops: [{ op: "set-derived-curve", curve: CURVE }] });
    expect(Object.keys(d.snapshot).pop()).toBe("derivedFrom");
    expect(d.label).toBe("Derived curves on market-public-2026-03-31 (demonstration values)");
    expect(d.snapshot.tlpNodes).toEqual(base.tlpNodes);
    expect("rateIndices" in d.snapshot).toBe(false);
    expect(contentHash(base)).toBe(BASE_HASH);
  });

  it("carries a base derivedCurves block unchanged when no op touches it", () => {
    const withCurves = deriveMarketSnapshot(base, [{ op: "set-derived-curve", curve: CURVE }], { baseId: BASE_ID }).snapshot as MarketSnapshot;
    const d = deriveMarketSnapshot(withCurves, [{ op: "add", value: 50 }], { baseId: "with-curves" });
    expect((d.snapshot as MarketWithDerivedCurves).derivedCurves).toEqual([CURVE]);
  });

  it("refuses a base whose derivedCurves block it cannot read", () => {
    const bad = { ...structuredClone(base), derivedCurves: [{ ...CURVE, label: "" }] } as MarketSnapshot;
    expect(problemsOf(() => deriveMarketSnapshot(bad, [{ op: "add", value: 50 }], { baseId: "bad" }))).toEqual([
      {
        at: "base",
        message: `market "bad" carries a derivedCurves block the derivation cannot read: derived curve "ust-sofr": the derived curve's "label" must be 1 to 80 characters`,
      },
    ]);
  });

  it("refuses a derived block of more than 12 curves", () => {
    const ops = Array.from({ length: 13 }, (_, i) => ({ op: "set-derived-curve", curve: { ...CURVE, id: `c-${String(i).padStart(2, "0")}` } }));
    expect(problemsOf(() => deriveMarketSnapshot(base, ops, { baseId: "mk" }))).toEqual([
      { at: "derivedCurves", message: "derivedCurves: a market carries at most 12 derived curves; got 13" },
    ]);
    expect(() => deriveMarketSnapshot(base, ops.slice(0, 12), { baseId: "mk" })).not.toThrow();
  });

  it("refuses an op that writes the curve the base already carries", () => {
    const withCurves = deriveMarketSnapshot(base, [{ op: "set-derived-curve", curve: CURVE }], { baseId: BASE_ID }).snapshot as MarketSnapshot;
    expect(problemsOf(() => deriveMarketSnapshot(withCurves, [{ op: "set-derived-curve", curve: CURVE }], { baseId: "with-curves" }))).toEqual([
      {
        at: "ops",
        message:
          'the ops change no TLP node, no rate index, no short-rate volatility, no macro series, no curve setup and no derived curve; the derived market would carry what market "with-curves" carries',
      },
    ]);
  });
});
