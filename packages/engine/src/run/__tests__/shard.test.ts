/**
 * Shard byte-identity: a sharded run must serialize byte-for-byte
 * identically to the single-thread run — determinism across shard counts is a
 * construction guarantee (fixed chunk grid, fixed-order fold), not a tolerance.
 *
 * Two books are exercised: a mid-size multi-chunk book (spanning several
 * SHARD_CHUNK boundaries, so the fold order actually matters) and a small
 * single-chunk book (exercising the worker loader on the degenerate one-chunk
 * plan). The 100k version lives in perf.test.ts behind RUN_PERF.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec, Position } from "../../contracts/position";
import { clearPortfolios } from "../../portfolio/registry";
import { createEngine, resolveDefaultContext } from "../index";
import { SHARD_CHUNK } from "../shard/chunk";
import {
  AS_OF,
  BY_SEGMENT_VIEW,
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  mortgagePosition,
  nmdBetaPosition,
  nmdPosition,
  twoSidedBook,
  VIEW_SEGMENT_TAXONOMY,
} from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

/** A deterministic mid-size book spanning several chunks (no RNG). */
function midBook(nTotal: number): PortfolioSpec {
  const perFamily = nTotal / 4;
  const positions: Position[] = [];
  for (let i = 0; i < perFamily; i++) {
    const jitter = 1 + (i % 100) / 1000;
    positions.push(fixedPosition(`F${i}`, { notional: 250_000 * jitter, coupon: 0.05, maturityMonths: 60 }));
    positions.push(mortgagePosition(`M${i}`, { notional: 200_000 * jitter, originalBalance: 200_000 * jitter }));
    positions.push(nmdPosition(`D${i}`, { notional: 150_000 * jitter }));
    positions.push(nmdBetaPosition(`B${i}`, { notional: 100_000 * jitter }));
  }
  return { id: "PF-SHARD", label: "shard identity book", asOf: AS_OF, coa: makeCoa(), positions };
}

function runWith(shards: number | "auto" | undefined, book: PortfolioSpec) {
  clearPortfolios();
  const engine = createEngine({ ...resolveDefaultContext(), shards });
  engine.loadPortfolio(book);
  return engine.run(makeRunRequest(market, { runId: "SHARD", portfolioId: book.id }));
}

describe("run — shard byte-identity", () => {
  it(
    "shards=4 equals shards=1 byte-for-byte on a multi-chunk 10k book",
    () => {
      const book = midBook(10_000);
      expect(book.positions.length).toBeGreaterThan(2 * SHARD_CHUNK); // fold order must matter
      const single = runWith(undefined, book);
      const sharded = runWith(4, book);
      expect(JSON.stringify(sharded)).toEqual(JSON.stringify(single));
    },
    300_000,
  );

  it(
    "shards=4 equals shards=1 on a small single-chunk book",
    () => {
      const book = twoSidedBook("PF-SHARD-SMALL");
      const single = runWith(undefined, book);
      const sharded = runWith(4, book);
      expect(JSON.stringify(sharded)).toEqual(JSON.stringify(single));
    },
    120_000,
  );
});

/**
 * Studio blank path D4: a throw inside a shard worker reaches the caller as the
 * error's name and message, not the worker's stack. The stack carries this
 * machine's absolute paths and node_modules frames, and the run's failure line
 * is read by an operator who needs the reason, not the frames. The bad
 * position (a forward-start offset, which the engine refuses) sits in the
 * SECOND chunk, so the pass really shards (two workers) and the refusal is
 * raised on a worker thread rather than inline.
 */
describe("run - a shard worker failure is reported as name and message", () => {
  it(
    "carries the class and the reason, with no stack frame, node_modules or absolute path",
    () => {
      const positions: Position[] = [];
      for (let i = 0; i < SHARD_CHUNK + 4; i++) {
        positions.push(fixedPosition(`F${i}`, { notional: 250_000, coupon: 0.05, maturityMonths: 60 }));
      }
      positions.push(fixedPosition("F-FORWARD", { notional: 250_000, coupon: 0.05, maturityMonths: 60, originationOffsetMonths: 3 }));
      const book: PortfolioSpec = { id: "PF-SHARD-FAIL", label: "shard failure book", asOf: AS_OF, coa: makeCoa(), positions };
      let thrown: unknown;
      try {
        runWith(2, book);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("shard worker failed: SeasoningError: ");
      expect(message).toContain('"F-FORWARD"');
      expect(message).not.toMatch(/\n\s+at /);
      expect(message).not.toContain("node_modules");
      expect(message).not.toContain("/Users/");
      expect(message).not.toContain(process.cwd());
    },
    120_000,
  );
});

/**
 * The mid-size book tagged so that EXACTLY ONE family splits into two cells.
 *
 * READ THIS BEFORE SIMPLIFYING THE TAGGING RULE. `midBook` pushes F, M, D, B
 * once per iteration, so a position's family is fully determined by its flat
 * index modulo 4: FIXED and DDA always land on EVEN indices, MORTGAGE and MMA
 * always on odd. Any rule keyed on flat-index parity therefore gives every
 * family a single constant tag and the whole book collapses to four cells, one
 * per family. That is the failure mode this comment exists to prevent, and it
 * is worse than a wrong count: with one cell per family, foldCellsToFamilies
 * takes its ALIASING branch everywhere and the case silently stops exercising
 * the multi-cell addition path, which is the only reason a shard case with a
 * view declared exists at all.
 *
 * So the tag is keyed on the position ID, not on the index: the NMD positions
 * split rate-shopper / relationship and the other three families are all
 * whole-book. The result is FIVE cells over four families, and it exercises
 * BOTH branches of the fold under sharding in one run: three single-cell
 * families on the alias branch, one two-cell family on the addition branch.
 */
function taggedMidBook(nTotal: number): PortfolioSpec {
  const book = midBook(nTotal);
  return {
    ...book,
    id: "PF-SHARD-VIEW",
    // The three-value widening, so every tag is inside the declared set.
    // SEGMENT_TAXONOMY declares only rate-shopper and relationship.
    taxonomy: VIEW_SEGMENT_TAXONOMY,
    // READ THIS BEFORE CHANGING THE 3. The D split runs on `% 3`, not `% 2`,
    // and the 3 is what makes this test able to see a book-absolute worker
    // index. midBook emits families in a fixed F,M,D,B four-cycle, so a
    // position's family is `i % 4`. Every worker's `lo` is a multiple of
    // SHARD_CHUNK, which is 4096, a power of two. If the cell-index sequence
    // has a period that DIVIDES 4096, then cellIndex.slice(lo, hi)[j] equals
    // cellIndex[j] for every j, and handing a worker the whole book-absolute
    // array instead of its slice produces byte-identical output. It does not
    // even crash: a longer array read only over the slice's length stays in
    // bounds. A `% 2` split gives period 8 in i, and 8 divides 4096, so the
    // bug stays invisible. `% 3` gives period 12, and 12 does not divide
    // 4096, so a book-absolute index shifts the tags and the run diverges.
    positions: book.positions.map((p, i) => ({
      ...p,
      dimensions: {
        segment:
          p.familyId === "DDA"
            ? Math.floor(i / 4) % 3 === 0
              ? "rate-shopper"
              : "relationship"
            : "whole-book",
      },
    })),
  };
}

function runWithView(shards: number | "auto" | undefined, book: PortfolioSpec) {
  clearPortfolios();
  const engine = createEngine({ ...resolveDefaultContext(), shards });
  engine.loadPortfolio(book);
  return engine.run(
    makeRunRequest(market, { runId: "SHARD-VIEW", portfolioId: book.id, views: [BY_SEGMENT_VIEW] }),
  );
}

describe("run: shard byte-identity with a view declared", () => {
  it(
    "shards=4 equals shards=1 byte-for-byte on a multi-chunk 10k book carrying cells",
    () => {
      const book = taggedMidBook(10_000);
      expect(book.positions.length).toBeGreaterThan(2 * SHARD_CHUNK);
      const single = runWithView(undefined, book);
      const sharded = runWithView(4, book);
      // FIVE cells, not eight: three single-cell families plus the two-cell DDA.
      // If this reads four, the tagging rule collapsed onto flat-index parity
      // and the multi-cell fold is no longer under test. See taggedMidBook.
      // This case is ALSO the only place in the repository that can catch a
      // worker handed a book-absolute cell index instead of its own slice,
      // and it can do that only because taggedMidBook's period does not
      // divide SHARD_CHUNK. The identity-plan shard case cannot: under
      // the identity plan the cell index IS the family index, so the sequence
      // is p % 4 and every worker's lo is a multiple of 4096.
      expect(single.cashflows.cells!.map((c) => c.id)).toEqual([
        'FIXED|{"segment":"whole-book"}',
        'MORTGAGE|{"segment":"whole-book"}',
        'DDA|{"segment":"rate-shopper"}',
        'DDA|{"segment":"relationship"}',
        'MMA|{"segment":"whole-book"}',
      ]);
      const dda = single.cashflows.cells!.filter((c) => c.familyId === "DDA");
      // 2500 DDA positions, split on `Math.floor(i / 4) % 3 === 0`: 834 land on
      // rate-shopper (indices 0, 3, 6, ... of 0..2499) and 1666 on relationship.
      // The UNEVEN split is the point. An even split would come from a period
      // that divides SHARD_CHUNK, which is what makes a book-absolute worker
      // index invisible. See the note on taggedMidBook.
      expect(dda.map((c) => c.positionCount)).toEqual([834, 1666]);
      expect(dda[0]!.positionCount + dda[1]!.positionCount).toBe(2500);
      expect(JSON.stringify(sharded)).toEqual(JSON.stringify(single));
    },
    900_000,
  );
});
