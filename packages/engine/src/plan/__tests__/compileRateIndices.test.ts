/**
 * Piece 7a, sub-part S2d: compilePlan refuses a floater that names a
 * rate index the plan's market does not carry, and logs it under the
 * plan/rate-indices layer. An unindexed book never reads the market's block.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { Position, PositionTerms } from "../../contracts/position";
import type { RunLogEntry } from "../../contracts/runLog";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { RateIndexRefusedError } from "../../rateIndex/resolve";
import { baseAssumptions, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { compilePlan } from "../compile";
import { fixturePlan, loadPolicy } from "./fixtures";

const SEED_OPS = [
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];

let plain: MarketSnapshot;
let indexed: MarketSnapshot;
beforeAll(async () => {
  plain = await loadMarket();
  indexed = deriveMarketSnapshot(structuredClone(plain), SEED_OPS, { baseId: "market-public-2026-03-31" }).snapshot;
});

const open: Array<{ dispose(): void }> = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.dispose();
});

const STAMPS = {
  runId: "RUN-1",
  seed: "42",
  timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" },
};

/** The fixture book plus one floater F; compile does not check the family's instrument type. */
function bookWithFloater(rateIndexId?: unknown, type: "floating-loan" | "fixed-loan" = "floating-loan") {
  const book = twoSidedBook();
  const terms = {
    id: "F",
    type,
    notional: 1_000_000,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    ...(type === "floating-loan" ? { indexTenorMonths: 1, margin: 0.0125, resetFrequencyMonths: 1 } : { coupon: 0.05 }),
    ...(rateIndexId !== undefined ? { rateIndexId } : {}),
  } as unknown as PositionTerms;
  const pos: Position = { id: "F", familyId: "FIXED", coaNodeId: "fixed-loans", terms };
  return { ...book, positions: [...book.positions, pos] };
}

const resolvedFor = (portfolio: ReturnType<typeof bookWithFloater>, market: MarketSnapshot) => ({
  portfolio,
  marketSnapshot: market,
  assumptionSets: [baseAssumptions()],
  policy: loadPolicy(),
  libraries: SHIPPED_LIBRARIES,
});

function compileCatching(portfolio: ReturnType<typeof bookWithFloater>, market: MarketSnapshot) {
  try {
    const c = compilePlan(fixturePlan(), resolvedFor(portfolio, market), STAMPS);
    open.push(c.harness);
    return { compiled: c, error: undefined as unknown };
  } catch (e) {
    return { compiled: undefined, error: e };
  }
}

describe("compilePlan on a named rate index (c)", () => {
  it("refuses a missing index with the run's text naming the plan's market, and logs plan/rate-indices", () => {
    const { error } = compileCatching(bookWithFloater("prime-demo"), plain);
    expect(error).toBeInstanceOf(RateIndexRefusedError);
    expect((error as Error).message).toBe(
      'run refused: 1 position(s) name a rate index the run cannot resolve, and a floater never falls back to the one-month benchmark: position "F" names rate index "prime-demo", which market "market-public-2026-03-31" does not carry (it carries none)',
    );
    const log = (error as { runLog?: RunLogEntry[] }).runLog ?? [];
    const refuse = log.find((e) => e.t === "refuse" && e.ids.layer === "plan/rate-indices");
    expect(refuse).toBeDefined();
    expect(refuse!.t === "refuse" && refuse!.ids).toEqual({
      layer: "plan/rate-indices",
      planId: "PLAN-FIXTURE-1",
      positionId: "F",
      rateIndexId: "prime-demo",
    });
  });

  it("compiles when the plan's market carries the index", () => {
    const { compiled, error } = compileCatching(bookWithFloater("prime-demo"), indexed);
    expect(error).toBeUndefined();
    expect(compiled!.request.portfolioId).toBe("PF-RUN");
  });

  it("refuses a fixed-loan that carries rateIndexId with the type text", () => {
    const { error } = compileCatching(bookWithFloater("prime-demo", "fixed-loan"), indexed);
    expect(error).toBeInstanceOf(RateIndexRefusedError);
    expect((error as Error).message).toBe(
      'run refused: 1 position(s) name a rate index the run cannot resolve, and a floater never falls back to the one-month benchmark: position "F" is a fixed-loan and names rate index "prime-demo"; only floating-loan positions reset on a rate index',
    );
  });

  it("refuses a non-string rateIndexId with the shape text", () => {
    const { error } = compileCatching(bookWithFloater(42), indexed);
    expect(error).toBeInstanceOf(RateIndexRefusedError);
    expect((error as Error).message).toContain('position "F" carries rateIndexId 42; expected an index id string');
  });

  it("lists five items then '; and 1 more' for six missing positions", () => {
    const book = twoSidedBook();
    const six: Position[] = [1, 2, 3, 4, 5, 6].map((i) => ({
      id: `G${i}`,
      familyId: "FIXED",
      coaNodeId: "fixed-loans",
      terms: {
        id: `G${i}`,
        type: "floating-loan",
        notional: 1_000_000,
        maturityMonths: 12,
        originationOffsetMonths: 0,
        amortType: "bullet",
        indexTenorMonths: 1,
        margin: 0.01,
        resetFrequencyMonths: 1,
        rateIndexId: "nope",
      } as unknown as PositionTerms,
    }));
    const { error } = compileCatching({ ...book, positions: [...book.positions, ...six] }, plain);
    const msg = (error as Error).message;
    expect(msg.startsWith("run refused: 6 position(s) name a rate index the run cannot resolve")).toBe(true);
    expect(msg.endsWith("; and 1 more")).toBe(true);
    expect(msg.split("; position ").length).toBe(5);
  });

  it("an unindexed book compiles on a market whose block is malformed, never reading it", () => {
    const bad = { ...plain, rateIndices: "not a list" } as unknown as MarketSnapshot;
    const { compiled, error } = compileCatching(twoSidedBook() as ReturnType<typeof bookWithFloater>, bad);
    expect(error).toBeUndefined();
    expect(compiled).toBeDefined();
  });
});
