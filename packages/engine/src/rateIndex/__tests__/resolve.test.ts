/**
 * Rate index resolution and the factory guard.
 * Expected texts and values are restated here, not imported from the code under
 * test. The 0.03711187754093537 base rate was measured on unmodified source; B4 moved it to
 * 0.03711187832875318 (the default curve's first node sits at exactly 1/12; deltas Step 1).
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type FloatingLoanTerms, type MarketSnapshot } from "@alm/kernel";
import type { MarketWithIndices } from "../../contracts/rateIndex";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import {
  checkRateIndexRefs,
  RateIndexRefusedError,
  RateIndexUnresolvedError,
  resolveRunRateIndices,
  withoutRateIndex,
} from "../resolve";
import { rateIndexTable } from "../rateIndices";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";

const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];

let plain: MarketSnapshot;
let indexed: MarketSnapshot;
beforeAll(async () => {
  plain = await loadMarketSnapshot(FIXTURE);
  indexed = deriveMarketSnapshot(structuredClone(plain), SEED_OPS, { baseId: BASE_ID }).snapshot;
});

const floater = (id: string, rateIndexId?: unknown): FloatingLoanTerms & { rateIndexId?: unknown } => ({
  id,
  type: "floating-loan",
  notional: 1_000_000,
  maturityMonths: 12,
  originationOffsetMonths: 0,
  amortType: "bullet",
  side: "asset",
  indexTenorMonths: 1,
  margin: 0.0125,
  resetFrequencyMonths: 1,
  ...(rateIndexId !== undefined ? { rateIndexId } : {}),
});
const pos = (id: string, terms: unknown): Position => ({
  id,
  familyId: "floaters",
  coaNodeId: "floaters",
  terms: terms as PositionTerms,
});
const book = (positions: Position[]): PortfolioSpec => ({
  id: "PF-RI",
  label: "rate index book",
  asOf: "2026-01-01",
  coa: { schemaVersion: "1.0.0", nodes: [], families: [] },
  positions,
});

describe("checkRateIndexRefs", () => {
  it("returns no table and no problem for a book that names no index, without reading the block", () => {
    const poisoned = { ...plain, get rateIndices(): never { throw new Error("the block was read"); } } as unknown as MarketSnapshot;
    const r = checkRateIndexRefs(book([pos("F", floater("F"))]), poisoned);
    expect(r.table).toBeUndefined();
    expect(r.problems).toEqual([]);
    expect(r.message).toBeUndefined();
  });

  it("resolves a named index against the market block", () => {
    const r = checkRateIndexRefs(book([pos("F", floater("F", "prime-demo"))]), indexed, BASE_ID);
    expect(r.problems).toEqual([]);
    expect([...r.table!.keys()].sort()).toEqual(["prime-demo", "rfr-1m", "rfr-3m"]);
    expect(r.table!.get("prime-demo")!.basis).toBe(0.03);
    const rfr3m = r.table!.get("rfr-3m")!;
    expect("tenorMonths" in rfr3m ? rfr3m.tenorMonths : undefined).toBe(3);
  });

  it("refuses a name a market with no block does not carry, in the run's market voice", () => {
    const r = checkRateIndexRefs(book([pos("F", floater("F", "prime-demo"))]), plain);
    expect(r.message).toBe(
      'run refused: 1 position(s) name a rate index the run cannot resolve, and a floater never falls back to the one-month benchmark: position "F" names rate index "prime-demo", which the run\'s market does not carry (it carries none)',
    );
    expect(r.first).toEqual({ positionId: "F", rateIndexId: "prime-demo" });
  });

  it("names the market and lists what it carries when it has a block", () => {
    const r = checkRateIndexRefs(book([pos("F", floater("F", "libor-6m"))]), indexed, "rate-indices-demo-v1");
    expect(r.message).toContain(
      'position "F" names rate index "libor-6m", which market "rate-indices-demo-v1" does not carry (it carries prime-demo, rfr-1m, rfr-3m)',
    );
  });

  it("refuses a rateIndexId on a type other than floating-loan", () => {
    const fixed = { ...floater("G"), type: "fixed-loan", rateIndexId: "rfr-1m" };
    const r = checkRateIndexRefs(book([pos("G", fixed)]), indexed);
    expect(r.problems).toEqual([
      'position "G" is a fixed-loan and names rate index "rfr-1m"; only floating-loan positions reset on a rate index',
    ]);
  });

  it("refuses a non-string rateIndexId with the shape text", () => {
    const r = checkRateIndexRefs(book([pos("F", floater("F", 42))]), indexed);
    expect(r.problems).toEqual(['position "F" carries rateIndexId 42; expected an index id string']);
    expect(r.first).toEqual({ positionId: "F", rateIndexId: "42" });
  });

  it("lists five items, then the count of the rest", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((n) => pos(`P${n}`, floater(`P${n}`, "nope")));
    const r = checkRateIndexRefs(book(six), indexed, "M");
    const items = ["a", "b", "c", "d", "e"].map(
      (n) => `position "P${n}" names rate index "nope", which market "M" does not carry (it carries prime-demo, rfr-1m, rfr-3m)`,
    );
    expect(r.message).toBe(
      "run refused: 6 position(s) name a rate index the run cannot resolve, and a floater never falls back to the one-month benchmark: " +
        items.join("; ") +
        "; and 1 more",
    );
  });

  it("refuses a malformed block, only when a floater names an index", () => {
    const bad = { ...plain, rateIndices: [{ id: "x", label: "L", tenorMonths: 2, basis: 0 }] } as unknown as MarketSnapshot;
    expect(checkRateIndexRefs(book([pos("F", floater("F"))]), bad).message).toBeUndefined();
    const r = checkRateIndexRefs(book([pos("F", floater("F", "x"))]), bad, "M");
    expect(r.message).toBe(
      'market "M" carries a rateIndices block the run cannot read: rateIndices[0].tenorMonths: expected 1, 3, 6 or 12 months; got 2',
    );
  });
});

describe("resolveRunRateIndices", () => {
  it("returns undefined for an unindexed book and the table for an indexed one", () => {
    expect(resolveRunRateIndices(book([pos("F", floater("F"))]), plain)).toBeUndefined();
    const t = resolveRunRateIndices(book([pos("F", floater("F", "rfr-3m"))]), indexed)!;
    expect(t.get("rfr-3m")!.basis).toBe(0);
  });

  it("throws RateIndexRefusedError carrying the first offender", () => {
    let caught: unknown;
    try {
      resolveRunRateIndices(book([pos("F", floater("F", "prime-demo"))]), plain);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateIndexRefusedError);
    expect((caught as RateIndexRefusedError).positionId).toBe("F");
    expect((caught as RateIndexRefusedError).rateIndexId).toBe("prime-demo");
  });
});

describe("withoutRateIndex", () => {
  it("drops the key and leaves everything else, and returns an unindexed object as is", () => {
    const t = floater("F", "prime-demo") as unknown as PositionTerms;
    const stripped = withoutRateIndex(t) as unknown as Record<string, unknown>;
    expect("rateIndexId" in stripped).toBe(false);
    expect(stripped.margin).toBe(0.0125);
    const plainTerms = floater("F") as unknown as PositionTerms;
    expect(withoutRateIndex(plainTerms)).toBe(plainTerms);
  });
});

describe("makeInstrument and a named index", () => {
  const terms = floater("F", "prime-demo") as unknown as PositionTerms;

  it("throws RateIndexUnresolvedError when given no options, or a table without the id", () => {
    const msg =
      'makeInstrument: floating-loan "F" names rate index "prime-demo", which this call was not given; a floater never falls back to the one-month benchmark';
    expect(() => makeInstrument(terms)).toThrow(RateIndexUnresolvedError);
    expect(() => makeInstrument(terms)).toThrow(msg);
    expect(() => makeInstrument(terms, { rateIndices: rateIndexTable([]) })).toThrow(msg);
  });

  it("leaves an unindexed floater on the one-month benchmark, with or without a table", () => {
    const path = buildRatePath(shockedCurve(buildBaseCurve(plain), { kind: "base" }), 360);
    const unindexed = floater("F") as unknown as PositionTerms;
    const a = makeInstrument(unindexed).generateCashflows(path);
    const b = makeInstrument(unindexed, { rateIndices: rateIndexTable((indexed as MarketWithIndices).rateIndices) }).generateCashflows(path);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // R(0) on the default curve (was 0.03711187754093537); interpolation, deltas Step 1
    expect(a[0]!.couponRate).toBeCloseTo(0.03711187832875318 + 0.0125, 15);
  });

  it("builds the indexed floater when the table holds the id", () => {
    const path = buildRatePath(shockedCurve(buildBaseCurve(indexed), { kind: "base" }), 360);
    const table = resolveRunRateIndices(book([pos("F", terms)]), indexed)!;
    const cfs = makeInstrument(terms, { rateIndices: table }).generateCashflows(path);
    // month-1 coupon is the base one-month rate, plus the 300 bp basis, plus the margin
    // R(0) on the default curve (was 0.03711187754093537); interpolation, deltas Step 1
    expect(cfs[0]!.couponRate).toBeCloseTo(0.03711187832875318 + 0.03 + 0.0125, 15);
    // R(0) on the default curve (was 0.03711187754093537); interpolation, deltas Step 1
    expect(cfs[0]!.interestPaid).toBeCloseTo((1_000_000 * (0.03711187832875318 + 0.0425)) / 12, 9);
  });
});
