/**
 * Studio piece D slice three, Task 2 (spec decisions 107 to 110, 114): the gap ladders' top-level rows on the
 * run's own bucket setting, `GapLadder.userBuckets`, beside the nine standard bands, which never change.
 *
 * The conservation wording is decision 114's, exactly:
 *  - monthly: re-banding the monthly top-level `assets` and `liabilities` equals the nine-band rows bit for bit
 *    on books with one root per column (both demo books), and within 1e-6 relative on books with two roots in a
 *    column (a swap book re-associates the sum);
 *  - custom: column totals over all buckets equal the nine-band column totals within 1e-6 relative; re-banding
 *    is tested only on an edge list that refines the nine band edges.
 *
 * A second, seeded book is held to the monthly wording in the companion
 * pack's own test, which needs a seeded store.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { buildDemoPortfolio, buildDemoRequest } from "../../../../../data/src/demo/request";
import type { GapBucketRow, GapLadder } from "../../contracts/results";
import type { GapBucketsOption, RunResult } from "../../contracts/run";
import type { PortfolioSpec, Position } from "../../contracts/position";
import { buildRunResult, type RunPipelineContext } from "../../run/orchestrate";
import { resolveDefaultContext } from "../../run/engine";
import { SHARD_CHUNK } from "../../run/shard/chunk";
import {
  AS_OF,
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  nmdBetaPosition,
  nmdPosition,
  twoSidedBook,
} from "../../run/__tests__/fixtures";
import { hedgedBook, swapPosition, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";
import { buildBands, buildUserBands } from "../bands";

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

type Buckets = { gapBuckets?: GapBucketsOption; liquidityBuckets?: GapBucketsOption };

/** Each demo run costs tens of seconds, so the three this file needs are built once each and shared. */
const demoRuns = new Map<string, RunResult>();
function runDemo(buckets: Buckets): RunResult {
  const key = JSON.stringify(buckets);
  const hit = demoRuns.get(key);
  if (hit) return hit;
  const result = runDemoUncached(buckets);
  demoRuns.set(key, result);
  return result;
}
const DEMO_MONTHLY: Buckets = { gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" } };
/** Refines the nine band edges [1, 3, 6, 12, 24, 36, 60, 120]. */
const REFINES = [1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 60, 120, 240];
/** Refining edges on the repricing ladder, non-refining ones on the liquidity ladder. */
const DEMO_CUSTOM: Buckets = {
  gapBuckets: { kind: "custom", edgesMonths: REFINES },
  liquidityBuckets: { kind: "custom", edgesMonths: [5, 13, 100] },
};

function runDemoUncached(buckets: Buckets): RunResult {
  const portfolio = buildDemoPortfolio();
  const request = buildDemoRequest(portfolio, market, {
    startedAt: "2026-07-16T00:00:00.000Z",
    finishedAt: "2026-07-16T00:00:01.000Z",
  });
  return buildRunResult(request, portfolio, { ...resolveDefaultContext(), ...buckets } as RunPipelineContext);
}

function runBookWith(book: PortfolioSpec, buckets: Buckets, shards?: number): RunResult {
  const request = makeRunRequest(market, { portfolioId: book.id });
  return buildRunResult(request, book, {
    ...resolveDefaultContext(),
    ...buckets,
    ...(shards !== undefined ? { shards } : {}),
  } as RunPipelineContext);
}

/**
 * Re-band a user ladder's rows into the nine standard bands: each user row's `assets` and `liabilities` are added,
 * in row order from zero, into the standard band holding its first month. Only meaningful for a user bucket list
 * that refines the nine band edges (every user row sits inside one band), which the test asserts.
 */
function reband(userRows: readonly GapBucketRow[], horizon: number): Array<{ assets: number; liabilities: number }> {
  const bands = buildBands(horizon);
  const out = bands.map(() => ({ assets: 0, liabilities: 0 }));
  for (const r of userRows) {
    const b = bands.findIndex((x) => r.band.startMonth >= x.startMonth && r.band.startMonth < x.endMonth);
    expect(b, `user row ${r.band.label} falls in no band`).toBeGreaterThanOrEqual(0);
    expect(r.band.endMonth, `user row ${r.band.label} straddles band ${bands[b]!.label}`).toBeLessThanOrEqual(bands[b]!.endMonth);
    out[b]!.assets += r.assets;
    out[b]!.liabilities += r.liabilities;
  }
  return out;
}

const relClose = (a: number, b: number, rel = 1e-6): boolean => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

function ladders(result: RunResult): GapLadder[] {
  return [...result.gap.repricing, ...result.gap.liquidity];
}

function expectMonthlyShape(ladder: GapLadder, horizon: number): void {
  const ub = ladder.userBuckets!;
  expect(ub.kind).toBe("monthly");
  expect(has(ub, "edgesMonths")).toBe(false);
  expect(Object.keys(ub)).toEqual(["kind", "rows"]);
  expect(ub.rows).toHaveLength(horizon);
  ub.rows.forEach((r, k) => {
    expect(r.band).toEqual({ label: `M${k + 1}`, startMonth: k, endMonth: k + 1 });
    expect(r.gap).toBe(r.assets - r.liabilities);
  });
  let cumulative = 0;
  for (const r of ub.rows) {
    cumulative += r.gap;
    expect(r.cumulativeGap).toBe(cumulative);
  }
}

describe("monthly user buckets conserve the nine bands (decision 114)", () => {
  it("demo book: re-banding the monthly top-level assets and liabilities equals the nine-band rows bit for bit", () => {
    const result = runDemo(DEMO_MONTHLY);
    const horizon = result.cashflows.grid.horizonMonths;
    expect(horizon).toBe(360);
    for (const ladder of ladders(result)) {
      expectMonthlyShape(ladder, horizon);
      const re = reband(ladder.userBuckets!.rows, horizon);
      ladder.rows.forEach((row, b) => {
        expect(re[b]!.assets, `${ladder.kind} ${ladder.scenarioId} ${row.band.label} assets`).toBe(row.assets);
        expect(re[b]!.liabilities, `${ladder.kind} ${ladder.scenarioId} ${row.band.label} liabilities`).toBe(row.liabilities);
      });
    }
  });

  it("two-sided fixture book (one root per column): bit for bit", () => {
    const book = twoSidedBook("PF-UB-2S");
    const result = runBookWith(book, { gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" } });
    for (const ladder of ladders(result)) {
      const re = reband(ladder.userBuckets!.rows, 360);
      ladder.rows.forEach((row, b) => {
        expect(re[b]!.assets).toBe(row.assets);
        expect(re[b]!.liabilities).toBe(row.liabilities);
      });
    }
  });

  it("swap book (two roots in the assets column): within 1e-6 relative", () => {
    const book = hedgedBook("PF-UB-SW", [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: 60 })]);
    expect(book.coa.nodes.filter((n) => n.parentId === null).length).toBeGreaterThan(2);
    const result = runBookWith(book, { gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" } });
    for (const ladder of ladders(result)) {
      const re = reband(ladder.userBuckets!.rows, 360);
      ladder.rows.forEach((row, b) => {
        expect(relClose(re[b]!.assets, row.assets), `${ladder.kind} ${row.band.label}: ${re[b]!.assets} vs ${row.assets}`).toBe(true);
        expect(relClose(re[b]!.liabilities, row.liabilities)).toBe(true);
      });
    }
  });
});

describe("custom user buckets (decisions 110 and 114)", () => {
  it("column totals over all buckets equal the nine-band column totals within 1e-6 relative", () => {
    // One demo run carries two edge lists (refining on repricing, not refining on liquidity); the fixture book
    // carries a third whose last edge is the grid.
    const demo = runDemo(DEMO_CUSTOM);
    const fixture = runBookWith(twoSidedBook("PF-UB-TOT"), {
      gapBuckets: { kind: "custom", edgesMonths: [12, 360] },
      liquidityBuckets: { kind: "custom", edgesMonths: [12, 360] },
    });
    for (const result of [demo, fixture]) {
      for (const ladder of ladders(result)) {
        const edges = ladder.userBuckets!.edgesMonths!;
        const ub = ladder.userBuckets!;
        const sum = (rows: readonly GapBucketRow[], k: "assets" | "liabilities") => rows.reduce((s, r) => s + r[k], 0);
        for (const k of ["assets", "liabilities"] as const) {
          const user = sum(ub.rows, k);
          const nine = sum(ladder.rows, k);
          expect(relClose(user, nine), `${edges.join(",")} ${ladder.kind} ${k}: ${user} vs ${nine}`).toBe(true);
        }
      }
    }
  });

  it("re-banding an edge list that refines the nine band edges gives the nine-band rows within 1e-6 relative", () => {
    const result = runDemo(DEMO_CUSTOM);
    expect(result.gap.repricing[0]!.userBuckets!.edgesMonths).toEqual(REFINES);
    for (const ladder of result.gap.repricing) {
      const re = reband(ladder.userBuckets!.rows, 360);
      ladder.rows.forEach((row, b) => {
        expect(relClose(re[b]!.assets, row.assets), `${ladder.kind} ${row.band.label}`).toBe(true);
        expect(relClose(re[b]!.liabilities, row.liabilities), `${ladder.kind} ${row.band.label}`).toBe(true);
      });
    }
  });

  it("first bucket is [0, e1), a last edge short of the grid runs a trailing bucket to the horizon, labels name the months", () => {
    const result = runBookWith(twoSidedBook("PF-UB-C1"), { gapBuckets: { kind: "custom", edgesMonths: [1, 3, 120] } });
    const ub = result.gap.repricing[0]!.userBuckets!;
    expect(Object.keys(ub)).toEqual(["kind", "edgesMonths", "rows"]);
    expect(ub.kind).toBe("custom");
    expect(ub.edgesMonths).toEqual([1, 3, 120]);
    expect(ub.rows.map((r) => r.band)).toEqual([
      { label: "M1", startMonth: 0, endMonth: 1 },
      { label: "M2-M3", startMonth: 1, endMonth: 3 },
      { label: "M4-M120", startMonth: 3, endMonth: 120 },
      { label: "M121-M360", startMonth: 120, endMonth: 360 },
    ]);
  });

  it("a last edge equal to the grid leaves no empty trailing bucket", () => {
    const result = runBookWith(twoSidedBook("PF-UB-C2"), { gapBuckets: { kind: "custom", edgesMonths: [12, 360] } });
    const ub = result.gap.repricing[0]!.userBuckets!;
    expect(ub.rows.map((r) => r.band)).toEqual([
      { label: "M1-M12", startMonth: 0, endMonth: 12 },
      { label: "M13-M360", startMonth: 12, endMonth: 360 },
    ]);
  });

  it("the stored edge list is a copy, not the caller's array", () => {
    const edges = [6, 24];
    const result = runBookWith(twoSidedBook("PF-UB-C3"), { gapBuckets: { kind: "custom", edgesMonths: edges } });
    edges.push(48);
    expect(result.gap.repricing[0]!.userBuckets!.edgesMonths).toEqual([6, 24]);
  });
});

describe("absence and independence (decisions 102, 107, 108)", () => {
  it("nothing asked: neither ladder carries the key", () => {
    const result = runBookWith(twoSidedBook("PF-UB-A0"), {});
    for (const ladder of ladders(result)) expect(has(ladder, "userBuckets")).toBe(false);
  });

  it("repricing asked, liquidity not: only the repricing ladder carries the key", () => {
    const result = runBookWith(twoSidedBook("PF-UB-A1"), { gapBuckets: { kind: "monthly" } });
    for (const ladder of result.gap.repricing) expect(has(ladder, "userBuckets")).toBe(true);
    for (const ladder of result.gap.liquidity) expect(has(ladder, "userBuckets")).toBe(false);
  });

  it("liquidity asked, repricing not: only the liquidity ladder carries the key", () => {
    const result = runBookWith(twoSidedBook("PF-UB-A2"), { liquidityBuckets: { kind: "monthly" } });
    for (const ladder of result.gap.repricing) expect(has(ladder, "userBuckets")).toBe(false);
    for (const ladder of result.gap.liquidity) expect(has(ladder, "userBuckets")).toBe(true);
  });

  it("the liquidity ladder follows liquidityBuckets and the repricing ladder follows gapBuckets, each on its own series", () => {
    const result = runBookWith(twoSidedBook("PF-UB-IND"), {
      gapBuckets: { kind: "monthly" },
      liquidityBuckets: { kind: "custom", edgesMonths: [1, 3, 6, 12, 24, 36, 60, 120] },
    });
    for (const ladder of result.gap.repricing) {
      expect(ladder.userBuckets!.kind).toBe("monthly");
      const re = reband(ladder.userBuckets!.rows, 360);
      ladder.rows.forEach((row, b) => expect(re[b]!.assets).toBe(row.assets));
    }
    for (const ladder of result.gap.liquidity) {
      expect(ladder.userBuckets!.kind).toBe("custom");
      expect(ladder.userBuckets!.edgesMonths).toEqual([1, 3, 6, 12, 24, 36, 60, 120]);
      // These edges are the nine band edges, so each user row is one standard band.
      expect(ladder.userBuckets!.rows.map((r) => r.band.startMonth)).toEqual(ladder.rows.map((r) => r.band.startMonth));
      ladder.userBuckets!.rows.forEach((r, b) => {
        expect(r.assets).toBe(ladder.rows[b]!.assets);
        expect(r.liabilities).toBe(ladder.rows[b]!.liabilities);
      });
    }
    // The two ladders differ on this book (the floaters and the beta deposits reprice ahead of their runoff), so
    // a ladder banded from the other's series would fail the checks above.
    expect(result.gap.repricing[0]!.rows).not.toEqual(result.gap.liquidity[0]!.rows);
  });

  it("asking for user buckets leaves every existing field byte-identical", () => {
    const plain = runDemo({});
    const strip = (r: RunResult): string =>
      JSON.stringify({
        ...r,
        gap: {
          repricing: r.gap.repricing.map(({ userBuckets: _u, ...rest }) => rest),
          liquidity: r.gap.liquidity.map(({ userBuckets: _u, ...rest }) => rest),
        },
      });
    for (const asked of [runDemo(DEMO_MONTHLY), runDemo(DEMO_CUSTOM)]) {
      expect(strip(asked)).toBe(JSON.stringify(plain));
      // userBuckets is the last key of each ladder (key order is part of the bytes).
      for (const ladder of ladders(asked)) expect(Object.keys(ladder).at(-1)).toBe("userBuckets");
    }
  });
});

describe("buildUserBands", () => {
  it("partitions [0, horizon) for monthly and custom settings", () => {
    const monthly = buildUserBands({ kind: "monthly" }, 6);
    expect(monthly.map((b) => b.label)).toEqual(["M1", "M2", "M3", "M4", "M5", "M6"]);
    for (const bands of [monthly, buildUserBands({ kind: "custom", edgesMonths: [2, 5] }, 6)]) {
      expect(bands[0]!.startMonth).toBe(0);
      expect(bands.at(-1)!.endMonth).toBe(6);
      for (let i = 1; i < bands.length; i++) expect(bands[i]!.startMonth).toBe(bands[i - 1]!.endMonth);
    }
  });

  it("throws on an edge past the horizon or out of order rather than truncating", () => {
    expect(() => buildUserBands({ kind: "custom", edgesMonths: [3, 7] }, 6)).toThrow(RangeError);
    expect(() => buildUserBands({ kind: "custom", edgesMonths: [3, 3] }, 6)).toThrow(RangeError);
    expect(() => buildUserBands({ kind: "custom", edgesMonths: [0, 3] }, 6)).toThrow(RangeError);
  });
});

describe("shard invariance", () => {
  it(
    "4 shards equal 1 shard on the user buckets of a multi-chunk book",
    () => {
      const positions: Position[] = [];
      const n = Math.ceil((2 * SHARD_CHUNK + 200) / 3);
      for (let i = 0; i < n; i++) {
        const jitter = 1 + (i % 97) / 1000;
        positions.push(fixedPosition(`F${i}`, { notional: 250_000 * jitter, coupon: 0.05, maturityMonths: 12 + (i % 120) }));
        positions.push(nmdPosition(`D${i}`, { notional: 150_000 * jitter }));
        positions.push(nmdBetaPosition(`B${i}`, { notional: 100_000 * jitter }));
      }
      const book: PortfolioSpec = { id: "PF-UB-SHARD", label: "user bucket shard book", asOf: AS_OF, coa: makeCoa(), positions };
      expect(book.positions.length).toBeGreaterThan(2 * SHARD_CHUNK);
      const buckets: Buckets = { gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "custom", edgesMonths: [2, 7, 30, 90] } };
      const single = runBookWith(book, buckets);
      const sharded = runBookWith(book, buckets, 4);
      const ub = (r: RunResult) => JSON.stringify(ladders(r).map((l) => l.userBuckets));
      expect(ladders(single).every((l) => l.userBuckets !== undefined)).toBe(true);
      expect(ub(sharded)).toBe(ub(single));
      expect(JSON.stringify(sharded)).toBe(JSON.stringify(single));
    },
    300_000,
  );
});
