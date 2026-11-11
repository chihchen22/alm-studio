/**
 * A derived curve spread through the run.
 *
 * Markets, all on the public pack with the seeded indices:
 *   indexed: rfr-1m, rfr-3m (basis 0) and prime-demo; no derivedCurves block.
 *   derived: indexed plus a flat 25 bp derived curve "flat-25" on the platform
 *            curve, and rfr-3m re-set with a 10 bp basis and spreadCurve "flat-25".
 *   twin:    derived with the block and the key removed and rfr-3m's basis set to
 *            basis + 0.0025, the same floating-point sum the fold computes.
 *
 * Review Focus 1 (no double application): the derived run must equal the twin
 * to the last bit, inline, sharded and on stochastic paths. A second fold
 * anywhere would add another 25 bp and break the equality.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { MarketWithIndices } from "../../contracts/rateIndex";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { resolveDefaultContext } from "../index";
import { runStochastic } from "../stochastic";
import { SHARD_CHUNK } from "../shard/chunk";
import { compilePlan } from "../../plan/compile";
import { fixturePlan, loadPolicy } from "../../plan/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { AS_OF, baseAssumptions, loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

const BASE_ID = "market-public-2026-03-31";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];
const FLAT_25 = { id: "flat-25", label: "Flat 25 bp", base: "platform-default", spreads: [{ tenorMonths: 1, spreadBp: 25 }] };
const DERIVE_OPS = [
  { op: "set-derived-curve", curve: FLAT_25 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 10, spreadCurve: "flat-25" },
];

let indexed: MarketSnapshot;
let derived: MarketSnapshot;
let twin: MarketSnapshot;
let unused: MarketSnapshot;
beforeAll(async () => {
  const plain = await loadMarket();
  indexed = deriveMarketSnapshot(structuredClone(plain), SEED_OPS, { baseId: BASE_ID }).snapshot;
  derived = deriveMarketSnapshot(structuredClone(indexed), DERIVE_OPS, { baseId: BASE_ID }).snapshot;
  // The twin: the derived market with the spread written into the basis by hand.
  const t = structuredClone(derived) as MarketWithIndices & { derivedCurves?: unknown };
  delete t.derivedCurves;
  t.rateIndices = t.rateIndices!.map((r) => {
    if (r.id !== "rfr-3m") return r;
    const { spreadCurve: _drop, ...rest } = r;
    void _drop;
    return { ...rest, basis: r.basis + 0.0025 };
  });
  twin = t;
  // A curve saved on the market that no index names.
  unused = deriveMarketSnapshot(structuredClone(indexed), [{ op: "set-derived-curve", curve: FLAT_25 }], { baseId: BASE_ID }).snapshot;
});

function floaterPosition(id: string, rateIndexId?: string, notional = 1_000_000): Position {
  const terms = {
    id,
    type: "floating-loan",
    notional,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    ...(rateIndexId !== undefined ? { rateIndexId } : {}),
  } as unknown as PositionTerms;
  return { id, familyId: "floaters", coaNodeId: "floaters", terms };
}

function handBook(id: string, positions: Position[]): PortfolioSpec {
  return {
    id,
    label: "hand book H",
    asOf: AS_OF,
    coa: {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
        { id: "floaters", label: "Floaters", parentId: "assets", side: "asset", isLeaf: true, familyId: "floaters", order: 0 },
      ],
      families: [{ id: "floaters", label: "Floaters", side: "asset", instrumentType: "floating-loan", coaNodeId: "floaters" }],
    },
    positions,
  };
}

function runBook(book: PortfolioSpec, market: MarketSnapshot, extra?: Partial<RunPipelineContext>, runId = "DC-E2E") {
  return buildRunResult(
    makeRunRequest(market, {
      runId,
      portfolioId: book.id,
      assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
    }),
    book,
    { ...resolveDefaultContext(), ...extra },
  );
}
type E2eResult = ReturnType<typeof runBook>;
/** The provenance hashes the market, which differs between the markets compared; every number is outside it. */
const numbers = (r: E2eResult): string => {
  const { provenance: _p, ...rest } = r;
  void _p;
  return JSON.stringify(rest);
};
const interestOf = (r: E2eResult) =>
  r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((f) => f.familyId === "floaters")!.series.interest;

/** A mixed book spanning two chunks: half the floaters read the derived index. */
function manyFloaters(n: number): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < n; i++) out.push(floaterPosition(`F${i}`, i % 2 === 0 ? "rfr-3m" : "rfr-1m", 100_000 + (i % 7) * 1_000));
  return out;
}

describe("byte identity when no derived curve is read (1)", () => {
  it("a market with no spreadCurve and no derivedCurves runs the old path, never touching the block", () => {
    const book = handBook("PF-DC-PLAIN", [floaterPosition("F", "rfr-3m")]);
    const before = runBook(book, indexed);
    // The same market with a derivedCurves property that throws when read and is invisible to hashing:
    // the key-absent path must not read it, and every byte of the result is unchanged.
    const guarded = structuredClone(indexed);
    Object.defineProperty(guarded, "derivedCurves", {
      enumerable: false,
      get(): never {
        throw new Error("the derivedCurves block was read");
      },
    });
    const after = runBook(book, guarded);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("a saved derived curve that no index names changes no number", () => {
    const book = handBook("PF-DC-UNUSED", [floaterPosition("F", "rfr-3m")]);
    expect(numbers(runBook(book, unused))).toBe(numbers(runBook(book, indexed)));
  });
});

describe("the spread is applied once (2, 3, 4)", () => {
  it("(2) a flat 25 bp derived curve equals basis + 0.0025 to the last bit, and moves interest by 25 bp", () => {
    const book = handBook("PF-DC-EQ", [floaterPosition("F", "rfr-3m")]);
    const d = runBook(book, derived);
    const t = runBook(book, twin);
    expect(numbers(d)).toBe(numbers(t));
    // The spread really reached the reset: 35 bp over the indexed (basis 0) run, 1e6 * 0.0035 / 12 per month.
    const base = runBook(book, indexed);
    for (let k = 0; k < 12; k++) expect(interestOf(d)[k]! - interestOf(base)[k]!).toBeCloseTo(1e6 * 0.0035 / 12, 6);
  });

  it(
    "(3) the derived run sharded equals the inline run byte for byte, and both equal the twin",
    () => {
      const positions = manyFloaters(SHARD_CHUNK + 900);
      expect(positions.length).toBeGreaterThan(SHARD_CHUNK);
      const book = handBook("PF-DC-SHARD", positions);
      const inline = runBook(book, derived, { shards: 1 }, "DC-SHARD");
      const sharded = runBook(book, derived, { shards: 2 }, "DC-SHARD");
      expect(JSON.stringify(sharded)).toBe(JSON.stringify(inline));
      expect(numbers(sharded)).toBe(numbers(runBook(book, twin, { shards: 2 }, "DC-SHARD")));
    },
    300_000,
  );

  it("(4) a short Hull-White run on the derived curve equals the basis + 0.0025 run exactly", () => {
    const book = handBook("PF-DC-STO", [floaterPosition("F", "rfr-3m"), floaterPosition("G", "prime-demo")]);
    const request = (market: MarketSnapshot) =>
      makeRunRequest(market, {
        runId: "DC-STO",
        portfolioId: book.id,
        scenarios: [
          { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "static", rules: [] } },
        ],
        assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
        grid: { horizonMonths: 360, asOf: AS_OF },
      });
    const d = runStochastic(request(derived), book, { nPaths: 20 });
    const t = runStochastic(request(twin), book, { nPaths: 20 });
    expect(JSON.stringify(d)).toBe(JSON.stringify(t));
    const i = runStochastic(request(indexed), book, { nPaths: 20 });
    expect(d.nii12mDistribution.mean).toBeGreaterThan(i.nii12mDistribution.mean);
  });
});

describe("the compile note (5)", () => {
  const open: Array<{ dispose(): void }> = [];
  afterEach(() => {
    while (open.length > 0) open.pop()!.dispose();
  });
  const STAMPS = {
    runId: "RUN-1",
    seed: "42",
    timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" },
  };
  function compileOn(market: MarketSnapshot, rateIndexId: string) {
    const b = twoSidedBook();
    const terms = {
      id: "F",
      type: "floating-loan",
      notional: 1_000_000,
      maturityMonths: 12,
      originationOffsetMonths: 0,
      amortType: "bullet",
      indexTenorMonths: 1,
      margin: 0.0125,
      resetFrequencyMonths: 1,
      rateIndexId,
    } as unknown as PositionTerms;
    const portfolio = { ...b, positions: [...b.positions, { id: "F", familyId: "FIXED", coaNodeId: "fixed-loans", terms }] };
    const c = compilePlan(
      fixturePlan(),
      { portfolio, marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES },
      STAMPS,
    );
    open.push(c.harness);
    return c;
  }

  it("names the curve, its index and what still reads the base curve when a derived curve is read", () => {
    const c = compileOn(derived, "rfr-3m");
    const notes = c.notImplemented.filter((n) => n.layer === "plan.derived-curve.index-only");
    expect(notes.length).toBe(1);
    expect(notes[0]!.reason).toBe(
      "derived curve Flat 25 bp (flat-25) adds a constant spread to index resets only (rfr-3m); mortgages, client rates, new business and discounting read the base curve",
    );
  });

  it("joins several curves sorted by id, each with its comma-joined indices, and states the base readers once (R4)", () => {
    const more = deriveMarketSnapshot(
      structuredClone(derived),
      [
        { op: "set-derived-curve", curve: { id: "a-curve", label: "A curve", base: "platform-default", spreads: [{ tenorMonths: 1, spreadBp: 5 }] } },
        { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0, spreadCurve: "flat-25" },
        { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300, spreadCurve: "a-curve" },
      ],
      { baseId: BASE_ID },
    ).snapshot;
    const b = twoSidedBook();
    const fl = (id: string, rateIndexId: string): Position => ({
      id,
      familyId: "FIXED",
      coaNodeId: "fixed-loans",
      terms: {
        id,
        type: "floating-loan",
        notional: 1_000_000,
        maturityMonths: 12,
        originationOffsetMonths: 0,
        amortType: "bullet",
        indexTenorMonths: 1,
        margin: 0.0125,
        resetFrequencyMonths: 1,
        rateIndexId,
      } as unknown as PositionTerms,
    });
    const portfolio = { ...b, positions: [...b.positions, fl("F", "rfr-3m"), fl("G", "rfr-1m"), fl("H", "prime-demo")] };
    const c = compilePlan(
      fixturePlan(),
      { portfolio, marketSnapshot: more, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES },
      STAMPS,
    );
    open.push(c.harness);
    const notes = c.notImplemented.filter((n) => n.layer === "plan.derived-curve.index-only");
    expect(notes.length).toBe(1);
    expect(notes[0]!.reason).toBe(
      "derived curve A curve (a-curve) adds a constant spread to index resets only (prime-demo); " +
        "derived curve Flat 25 bp (flat-25) adds a constant spread to index resets only (rfr-1m, rfr-3m); " +
        "mortgages, client rates, new business and discounting read the base curve",
    );
  });

  it("is absent when no derived curve is read", () => {
    expect(compileOn(indexed, "rfr-3m").notImplemented.some((n) => n.layer === "plan.derived-curve.index-only")).toBe(false);
    // A saved curve no index names is not read either.
    expect(compileOn(unused, "rfr-3m").notImplemented.some((n) => n.layer === "plan.derived-curve.index-only")).toBe(false);
    // An index that names the curve but no position carries: not read.
    expect(compileOn(derived, "rfr-1m").notImplemented.some((n) => n.layer === "plan.derived-curve.index-only")).toBe(false);
  });
});
