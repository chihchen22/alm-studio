/**
 * deriveMarketSnapshot. Fixture and expected values are
 * restated here; nothing is imported from the code under test beyond the
 * function, its error, its id helpers and the op caps, which are pinned to literals.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTLPCurve, loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { contentHash } from "../../runtime/contentHash";
import { MAX_DERIVATION_OPS } from "../../scenario/deriveAssumptionSet";
import { deriveMarketSnapshot, derivedMarketId, MarketDerivationError, MARKET_DERIVED_ID_PREFIX, MAX_MARKET_DERIVATION_OPS } from "../deriveMarketSnapshot";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";
const BASE_HASH = "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651";
const BASE_TENORS = [0, 0.083333, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];
const BASE_SPREADS = [0, 0.002, 0.002, 0.0025, 0.0025, 0.003, 0.0035, 0.0045, 0.0055, 0.0065, 0.009, 0.01];

let loaded: MarketSnapshot;
beforeAll(async () => {
  loaded = await loadMarketSnapshot(FIXTURE);
});
// A fresh deep copy per call, so no test can leak a mutation into another.
const load = (): MarketSnapshot => structuredClone(loaded);
const opts = { baseId: BASE_ID };
const spreads = (s: MarketSnapshot): number[] => s.tlpNodes.map((n) => n.spread);

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

describe("base fixture", () => {
  it("carries the restated TLP nodes", () => {
    const b = load();
    expect(b.tlpNodes.map((n) => n.tYears)).toEqual(BASE_TENORS);
    expect(spreads(b)).toEqual(BASE_SPREADS);
    expect(contentHash(b)).toBe(BASE_HASH);
  });
});

describe("V1: add 50 on every node", () => {
  let base: MarketSnapshot;
  let r: ReturnType<typeof deriveMarketSnapshot>;
  beforeAll(() => {
    base = load();
    r = deriveMarketSnapshot(base, [{ op: "add", value: 50 }], opts);
  });
  it("moves every node except t = 0", () => {
    expect(spreads(r.snapshot)).toEqual([0, 0.007, 0.007, 0.0075, 0.0075, 0.008, 0.0085, 0.0095, 0.0105, 0.0115, 0.014, 0.015]);
    expect(r.snapshot.tlpNodes.map((n) => n.tYears)).toEqual(BASE_TENORS);
  });
  it("reports 11 change rows of 50 bp", () => {
    expect(r.changes).toHaveLength(11);
    for (const c of r.changes) {
      expect(c.changeBp).toBe(50);
      expect(c.ops).toEqual([0]);
    }
    expect(r.changes[0]).toEqual({ nodeIndex: 1, tYears: 0.083333, from: 0.002, to: 0.007, changeBp: 50, ops: [0] });
  });
  it("drops the term-funding quotes and copies every other block", () => {
    expect(r.termFundingQuotesDropped).toBe(11);
    expect(r.snapshot.termFundingCurveQuotes).toEqual([]);
    for (const k of ["curveQuotes", "capQuotes", "swaptionATMQuotes", "curveConvention", "curveConventionFields", "calibrationDate", "currency", "discountingIndex", "benchmarkNote"] as const) {
      expect(r.snapshot[k]).toEqual(base[k]);
    }
    expect(Object.keys(r.snapshot)).toEqual([...Object.keys(base), "derivedFrom"]);
  });
  it("records its base and normalized ops", () => {
    expect(r.snapshot.derivedFrom).toEqual({ baseId: BASE_ID, baseContentHash: BASE_HASH, ops: [{ op: "add", value: 50 }] });
  });
  it("defaults the id and label", () => {
    expect(r.id).toBe("derived-mk-cc5f69059269");
    expect(r.id).toBe(derivedMarketId(BASE_ID, BASE_HASH, [{ op: "add", value: 50 }]));
    expect(MARKET_DERIVED_ID_PREFIX).toBe("derived-mk-");
    expect(r.label).toBe("Funding spread shock on market-public-2026-03-31 (demonstration values)");
  });
});

describe("V2: a 10Y add of 25", () => {
  it("changes only the 10Y node", () => {
    const r = deriveMarketSnapshot(load(), [{ target: { tYears: 10 }, op: "add", value: 25 }], opts);
    expect(r.changes).toEqual([{ nodeIndex: 9, tYears: 10, from: 0.0065, to: 0.009, changeBp: 25, ops: [0] }]);
    expect(spreads(r.snapshot)).toEqual([0, 0.002, 0.002, 0.0025, 0.0025, 0.003, 0.0035, 0.0045, 0.0055, 0.009, 0.009, 0.01]);
    expect(r.snapshot.derivedFrom!.ops).toEqual([{ target: { tYears: 10 }, op: "add", value: 25 }]);
  });
});

describe("V3: scale 1.5", () => {
  let r: ReturnType<typeof deriveMarketSnapshot>;
  beforeAll(() => {
    r = deriveMarketSnapshot(load(), [{ op: "scale", value: 1.5 }], opts);
  });
  it("scales every node except t = 0", () => {
    expect(spreads(r.snapshot)).toEqual([0, 0.003, 0.003, 0.00375, 0.00375, 0.0045, 0.00525, 0.00675, 0.00825, 0.00975, 0.0135, 0.015]);
  });
  it("reports the 6M change in bp", () => {
    const row = r.changes.find((c) => c.tYears === 0.5)!;
    expect(row.changeBp).toBe(12.5);
  });
});

describe("V4: add then scale at 1M", () => {
  let r: ReturnType<typeof deriveMarketSnapshot>;
  beforeAll(() => {
    r = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }, { target: { tYears: 0.083333 }, op: "scale", value: 2 }], opts);
  });
  it("composes", () => {
    expect(r.snapshot.tlpNodes[1]!.spread).toBe(0.014);
    expect(r.snapshot.tlpNodes[2]!.spread).toBe(0.007);
    const row = r.changes.find((c) => c.tYears === 0.083333)!;
    expect(row.ops).toEqual([0, 1]);
    expect(row.changeBp).toBe(120);
    expect(r.changes.find((c) => c.tYears === 0.25)!.ops).toEqual([0]);
    expect(r.changes).toHaveLength(11);
  });
});

describe("V5: kernel cross-check", () => {
  it("the derived nodes interpolate as the kernel curve does", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }], opts);
    const curve = buildTLPCurve(r.snapshot.tlpNodes);
    expect(curve.tlp(0.0416665)).toBeCloseTo(0.0035, 9);
    expect(curve.tlp(15)).toBeCloseTo(0.01275, 9);
  });
});

describe("V6: op refusals", () => {
  const d = (ops: unknown[]) => () => deriveMarketSnapshot(load(), ops, opts);
  it("refuses a target at t = 0", () => {
    const p = one(d([{ target: { tYears: 0 }, op: "add", value: 10 }]));
    expect(p.at).toBe("ops[0]");
    expect(p.message).toBe("ops[0]: the TLP node at t = 0 is pinned at 0; a funding spread shock cannot move it");
  });
  it("refuses an add that drives a node to zero or below", () => {
    const p20 = one(d([{ target: { tYears: 0.083333 }, op: "add", value: -20 }]));
    expect(p20.at).toBe("tlpNodes[1].spread");
    expect(p20.message).toBe("TLP node at 0.083333 years: the derived spread is 0; a TLP node other than t = 0 must be finite and greater than 0, the rule the workbook import applies");
    const p25 = one(d([{ target: { tYears: 0.083333 }, op: "add", value: -25 }]));
    expect(p25.at).toBe("tlpNodes[1].spread");
    expect(p25.message).toBe("TLP node at 0.083333 years: the derived spread is -0.0005; a TLP node other than t = 0 must be finite and greater than 0, the rule the workbook import applies");
  });
  it("refuses a tenor the base does not store", () => {
    const p = one(d([{ target: { tYears: 4 }, op: "add", value: 10 }]));
    expect(p.message).toBe(
      'ops[0]: market "market-public-2026-03-31" has no TLP node at 4 years; its nodes are at 0, 0.083333, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30 years, and a funding spread shock cannot add a node',
    );
  });
  it("refuses an unknown op kind", () => {
    // Re-expectation: the message names the two rate index op kinds.
    // Re-expectation: the op list now names the two short-rate volatility ops.
    expect(one(d([{ op: "set", value: 1 }])).message).toBe('ops[0]: op must be add, scale, set-index, add-index-basis, scale-short-rate-vol or add-short-rate-vol; got "set"');
  });
  it("refuses a non-finite or non-number value", () => {
    expect(one(d([{ op: "add", value: "50" }])).message).toBe("ops[0]: value must be a finite number");
    expect(one(d([{ op: "add", value: Number.NaN }])).message).toBe("ops[0]: value must be a finite number");
  });
  it("refuses a scale factor of 0 or below", () => {
    expect(one(d([{ op: "scale", value: 0 }])).message).toBe("ops[0]: a scale factor must be greater than 0; got 0");
    expect(one(d([{ op: "scale", value: -1 }])).message).toBe("ops[0]: a scale factor must be greater than 0; got -1");
  });
  it("refuses an empty list and more than 64 ops; assumption sets and balance plans keep 32", () => {
    expect(MAX_MARKET_DERIVATION_OPS).toBe(64);
    expect(MAX_DERIVATION_OPS).toBe(32);
    expect(one(d([]))).toEqual({ at: "ops", message: "a derivation needs at least one op" });
    expect(one(d(Array.from({ length: 65 }, () => ({ op: "add", value: 1 }))))).toEqual({ at: "ops", message: "at most 64 ops; got 65" });
    expect(() => d(Array.from({ length: 64 }, () => ({ op: "add", value: 1 })))()).not.toThrow();
  });
  it("refuses an op that changes nothing", () => {
    expect(one(d([{ op: "add", value: 0 }]))).toEqual({
      at: "ops",
      message: 'the ops change no TLP node; the derived market would carry what market "market-public-2026-03-31" carries',
    });
  });
  it("refuses unknown fields", () => {
    expect(one(d([{ op: "add", value: 5, curveQuotes: [] }])).message).toBe(
      // Re-expectation: the message points at the rate index ops.
      // Re-expectation: the op list now names the two short-rate volatility ops.
      'ops[0]: unknown field "curveQuotes"; an op carries target, op and value and changes the TLP nodes only; a rate index op is set-index or add-index-basis; a short-rate volatility op is scale-short-rate-vol or add-short-rate-vol',
    );
    expect(one(d([{ target: { tYears: 1, term: "1Y" }, op: "add", value: 5 }])).message).toBe('ops[0]: unknown target field "term"; a target carries tYears');
  });
  it("refuses a malformed op and a malformed target tenor", () => {
    expect(one(d(["x"])).message).toBe("ops[0]: an op must be an object carrying op and value, and optionally target");
    expect(one(d([{ target: { tYears: "1" }, op: "add", value: 5 }])).message).toBe("ops[0]: target.tYears must be a finite number naming a TLP node");
  });
  it("collects every problem and throws once", () => {
    const p = problemsOf(d([{ op: "set", value: 1 }, { op: "add", value: Number.NaN }]));
    expect(p).toHaveLength(2);
    expect(p.map((x) => x.at)).toEqual(["ops[0]", "ops[1]"]);
  });
  it("the error message names the count and lists every problem", () => {
    try {
      d([{ op: "set", value: 1 }, { op: "add", value: Number.NaN }])();
    } catch (e) {
      expect((e as Error).message).toBe(
        // Re-expectation: the unknown-kind message names the two rate index op kinds.
        // Re-expectation: the op list now names the two short-rate volatility ops.
        'derived market refused: 2 problem(s); every problem is listed: ops[0]: op must be add, scale, set-index, add-index-basis, scale-short-rate-vol or add-short-rate-vol; got "set"; ops[1]: value must be a finite number',
      );
      return;
    }
    throw new Error("expected a throw");
  });
});

describe("V7: base refusals", () => {
  const ops = [{ op: "add", value: 50 }];
  const withNodes = (nodes: Array<{ tYears: number; spread: number }>): MarketSnapshot => ({ ...load(), tlpNodes: nodes });
  it("refuses empty TLP nodes", () => {
    expect(one(() => deriveMarketSnapshot(withNodes([]), ops, opts))).toEqual({
      at: "base",
      message: 'market "market-public-2026-03-31" carries no TLP nodes; a run on it uses the kernel default TLP curve, which a derivation does not shock',
    });
  });
  it("refuses a base with no node at t = 0", () => {
    const p = one(() => deriveMarketSnapshot(withNodes([{ tYears: 1, spread: 0.002 }, { tYears: 2, spread: 0.003 }]), ops, opts));
    expect(p.message).toBe('market "market-public-2026-03-31" has no TLP node at t = 0 pinned at 0; the derivation keeps that node pinned and cannot start from a base without it');
  });
  it("refuses a t = 0 node that is not 0", () => {
    const p = one(() => deriveMarketSnapshot(withNodes([{ tYears: 0, spread: 0.001 }, { tYears: 1, spread: 0.002 }]), ops, opts));
    expect(p.message).toBe('market "market-public-2026-03-31" has no TLP node at t = 0 pinned at 0; the derivation keeps that node pinned and cannot start from a base without it');
  });
  it("refuses duplicate tenors", () => {
    const p = one(() => deriveMarketSnapshot(withNodes([{ tYears: 0, spread: 0 }, { tYears: 2, spread: 0.002 }, { tYears: 2, spread: 0.003 }]), ops, opts));
    expect(p.message).toBe('market "market-public-2026-03-31" carries two TLP nodes at 2 years; a derivation cannot say which one to change');
  });
  it("refuses a base it cannot read", () => {
    const p = one(() => deriveMarketSnapshot({} as MarketSnapshot, ops, opts));
    expect(p.message).toBe('market "market-public-2026-03-31" is not a market snapshot the derivation can read');
  });
});

describe("V8: purity, ids and labels", () => {
  it("does not mutate the base", () => {
    const base = load();
    const before = JSON.stringify(base);
    deriveMarketSnapshot(base, [{ op: "add", value: 50 }], opts);
    expect(JSON.stringify(base)).toBe(before);
    expect(contentHash(base)).toBe(BASE_HASH);
  });
  it("passes a caller id and label through", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }], { baseId: BASE_ID, id: "tlp-mine", label: "My shock" });
    expect(r.id).toBe("tlp-mine");
    expect(r.label).toBe("My shock (demonstration values)");
    const r2 = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }], { baseId: BASE_ID, label: "Illustrative x" });
    expect(r2.label).toBe("Illustrative x");
  });
});
