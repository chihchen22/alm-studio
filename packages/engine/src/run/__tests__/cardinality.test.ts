/**
 * Accumulation cardinality: the measurement the close-out owed.
 *
 * The limitations page records that the per-chunk sink is now dense over CELLS
 * rather than over the four to twenty COA families, so a view whose cardinality
 * tracks the book makes retained chunk-buffer memory quadratic in the position
 * count on the sharded path, and the per-chunk zeroing quadratic in it on the
 * inline path. Nothing in the standard suite can fail if that worsens: the only
 * high-position-count run declaring a view (shard.test.ts, 10,000 positions)
 * declares FIVE cells, which is the size the pre-2b family sink already was,
 * and the 100k perf book declares no view at all.
 *
 * These cases close that hole by MEASURING, not by asserting a budget. Each
 * builds a book whose cell count equals its position count, drives
 * runStaticPass directly, and reports wall clock and arrayBuffers beside the
 * closed-form prediction. Skipped by default; run them explicitly:
 *
 *   RUN_PERF=1 npx vitest run src/run/__tests__/cardinality.test.ts
 *
 * Why runStaticPass and not engine.run: a full run at one cell per position
 * also builds a per-cell envelope carrying a bucketed series per scenario plus
 * a monthly NII vector, which grows with the same cell count and would exhaust
 * memory first, hiding the cost under measurement. The last case runs the whole
 * engine at a modest cardinality to confirm the end-to-end path still finishes.
 *
 * MEM_BUDGET_BYTES is a guard, not a target: a ramp step whose PREDICTED peak
 * exceeds it is skipped with its prediction printed, so this file cannot take
 * the host down. Raise it deliberately, on a machine with the headroom.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { DimensionTaxonomy } from "../../contracts/dimensions";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { ViewDef } from "../../contracts/views";
import { buildCellPlan } from "../../portfolio/cells";
import { clearPortfolios } from "../../portfolio/registry";
import { buildScenarioRatePath } from "../../projection/static";
import { buildBaseCurve } from "../../scenario";
import { createEngine, resolveDefaultContext } from "../index";
import { CHUNK_METRICS, SHARD_CHUNK } from "../shard/chunk";
import { resolveShardCount, runStaticPass, type StaticPassGroup } from "../shard/staticPass";
import {
  AS_OF,
  HORIZON,
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  regulatoryScenarios,
} from "./fixtures";

const RUN_PERF = !!process.env.RUN_PERF;

/** The guard. A step predicted above this is skipped, not attempted. */
const MEM_BUDGET_BYTES = 3 * 1024 ** 3;

/** One, two and three chunks. Quadratic growth is visible over three points. */
const RAMP = [SHARD_CHUNK, 2 * SHARD_CHUNK, 3 * SHARD_CHUNK];

const MB = (b: number) => (b / 1024 / 1024).toFixed(0);
const GB = (b: number) => (b / 1024 ** 3).toFixed(2);

let market: MarketSnapshot;
beforeAll(async () => {
  if (RUN_PERF) market = await loadMarket();
});

const ACCOUNT_VIEW: ViewDef = { id: "by-account", label: "By account", groupBy: ["account"] };

/**
 * A taxonomy declaring one value per position. The whole list is declared
 * rather than a short one: rule D3 (a tag value must sit in the declared set)
 * runs at book intake and never on the run path, so a short list would pass
 * today too, and declaring the real one keeps this measurement about memory
 * instead of about some future refusal.
 */
function perAccountTaxonomy(n: number): DimensionTaxonomy {
  const values: string[] = new Array(n);
  for (let i = 0; i < n; i++) values[i] = `A${i}`;
  return {
    schemaVersion: "1.0.0",
    id: "TAX-ACCOUNT",
    label: "One tag per account",
    dimensions: [{ id: "account", label: "Account", values }],
  };
}

/**
 * n fixed loans in ONE family, each carrying its own account tag, so the view
 * yields exactly n cells inside a single family range. That is the worst case
 * for the fold as well as for the sink: one family holding every cell takes the
 * ADDITION branch over the full width rather than the aliasing branch.
 */
function perAccountBook(n: number, cells: number = n): PortfolioSpec {
  const positions: Position[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const jitter = 1 + (i % 100) / 1000; // deterministic spread, no RNG
    positions[i] = {
      ...fixedPosition(`F${i}`, { notional: 250_000 * jitter, coupon: 0.05, maturityMonths: 60 }),
      // Tags cycle modulo the wanted cell count, so cardinality can be varied
      // INDEPENDENTLY of the position count. That separation is what makes the
      // quadratic claim testable: the cost formula carries chunk count and cell
      // count as two factors, and a ramp that moves both at once cannot tell
      // which one it is measuring.
      dimensions: { account: `A${i % cells}` },
    };
  }
  return {
    id: `PF-CARD-${n}-${cells}`,
    label: `${n}-position book in ${cells} cells`,
    asOf: AS_OF,
    coa: makeCoa(),
    taxonomy: perAccountTaxonomy(cells),
    positions,
  };
}

/**
 * The worker count runStaticPass will actually use, mirroring its own clamp:
 * `min(resolveShardCount(shards), max(1, ceil(maxPositions / SHARD_CHUNK)))`.
 * This is recomputed rather than observed, which is exact because the clamp is
 * a pure function of its inputs, and it exists because a book with fewer chunks
 * than shards runs the INLINE path with no outward sign. A sharded case that
 * resolves to one worker is measuring the wrong path, so each asserts this.
 */
function effectiveWorkers(positions: number, shards: number | undefined): number {
  return Math.min(resolveShardCount(shards), Math.max(1, Math.ceil(positions / SHARD_CHUNK)));
}

/**
 * The sharded path's retained chunk bytes, summed over every (group, scenario,
 * chunk) triple, which is the formula the limitations page states. The shard count does
 * not appear: one worker's peak is this figure over the shard count, while the
 * main thread receives and holds the whole union either way, so this is the
 * figure the MAIN process is measurable against.
 */
function predictedChunkBytes(cells: number, positions: number, scenarios: number): number {
  const chunks = Math.ceil(positions / SHARD_CHUNK);
  return chunks * scenarios * CHUNK_METRICS * cells * HORIZON * 8;
}

/**
 * One ChunkSink's own bytes, linear in the cell count.
 *
 * READ THIS BEFORE TRUSTING THE LIMITATIONS BULLET'S INLINE CLAIM. There is one
 * MASTER sink per scenario, not one per run: runStaticPass returns a Map keyed
 * by scenario id and allocMasterSink is called once per entry. So both paths
 * hold `scenarios` master sinks of this size, and the inline path holds one
 * reused scratch buffer of the same size on top. Linear in the cell count, yes,
 * but with a multiplier of `scenarios + 1` rather than the one the bullet's
 * "one scratch buffer is reused across chunks" wording suggests.
 */
function sinkBytes(cells: number): number {
  return CHUNK_METRICS * cells * HORIZON * 8;
}

/** Resident master sinks, one per scenario, on BOTH paths. */
function predictedMasterBytes(cells: number, scenarios: number): number {
  return scenarios * sinkBytes(cells);
}

/** maxRSS is the process high-water mark. Node reports it in kilobytes. */
function peakRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

/** The inline path's per-chunk zeroing, in Float64 writes. Quadratic in n. */
function predictedZeroWrites(cells: number, positions: number, scenarios: number): number {
  return Math.ceil(positions / SHARD_CHUNK) * scenarios * CHUNK_METRICS * cells * HORIZON;
}

function measure(n: number, shards: number | undefined, cells: number = n): void {
  clearPortfolios();
  const workers = effectiveWorkers(n, shards);
  // A sharded measurement that resolves to one worker measured the inline path.
  // Fail rather than report it under a sharded label.
  if (shards !== undefined) expect(workers).toBeGreaterThan(1);

  const book = perAccountBook(n, cells);
  const plan = buildCellPlan(book, [ACCOUNT_VIEW]);
  // The whole measurement is void if the cardinality is not what it claims.
  expect(plan.cells.length).toBe(cells);

  const base = buildBaseCurve(market);
  const scenarios = regulatoryScenarios();
  const group: StaticPassGroup = {
    positions: book.positions,
    scenarios: scenarios.map((s) => ({
      scenarioId: s.id,
      rateSpec: s.rateSpec,
      path: buildScenarioRatePath(base, s, HORIZON),
    })),
  };

  const chunks = Math.ceil(n / SHARD_CHUNK);
  const predictedRetained = predictedChunkBytes(cells, n, scenarios.length);
  const predictedZeroing = predictedZeroWrites(cells, n, scenarios.length);

  const master = predictedMasterBytes(cells, scenarios.length);
  // The inline path's peak adds ONE reused scratch buffer; the sharded path's
  // adds every retained chunk buffer, which is the quadratic term.
  const predictedPeak =
    shards === undefined ? master + sinkBytes(cells) : master + predictedRetained;

  const peak0 = peakRssBytes();
  const before = process.memoryUsage();
  const t0 = performance.now();
  // The cell budget is passed as infinite ON PURPOSE. This file is the evidence
  // the default 4 GiB budget rests on, so it must measure the cost rather than
  // be refused by the guard justified by its own numbers. MEM_BUDGET_BYTES above
  // is the guard that keeps this file safe, and it is checked before the run.
  //
  // The prediction helpers here also stay INDEPENDENT of the production
  // predictedPassBytes. Importing it would make this file agree with the code by
  // construction and check nothing; the closed form is restated from the buffer
  // layout so a drift in either shows up as a mismatch.
  const sinks = runStaticPass([group], plan, HORIZON, shards, market, Number.POSITIVE_INFINITY);
  const elapsedS = (performance.now() - t0) / 1000;
  const after = process.memoryUsage();
  const peak1 = peakRssBytes();

  expect(sinks.size).toBe(scenarios.length);

  const label = shards === undefined ? "inline" : `shards=${shards}->${workers} workers`;
  const predictedLine =
    shards === undefined
      ? `predicted peak ${MB(predictedPeak)}MB = ${scenarios.length} master sinks ` +
        `${MB(master)}MB + 1 scratch ${MB(sinkBytes(cells))}MB (LINEAR in cells); ` +
        `zeroing ${(predictedZeroing / 1e6).toFixed(0)}M writes (QUADRATIC)`
      : `predicted peak ${GB(predictedPeak)}GB = masters ${MB(master)}MB + retained chunks ` +
        `${GB(predictedRetained)}GB (QUADRATIC); one worker of ${shards} holds ` +
        `${GB(predictedRetained / shards)}GB of that`;

  // eslint-disable-next-line no-console
  console.log(
    `\n[CARD ${label}] n=${n} cells=${cells} chunks=${chunks} scen=${scenarios.length} ` +
      `horizon=${HORIZON}: ${elapsedS.toFixed(2)}s; ${predictedLine}; ` +
      `MEASURED peak rss high-water ${MB(peak0)} -> ${MB(peak1)}MB ` +
      `(monotonic per process, so run one step per process to read it cleanly); ` +
      `arrayBuffers ${MB(before.arrayBuffers)} -> ${MB(after.arrayBuffers)}MB, ` +
      `rss now ${MB(after.rss)}MB, heapTotal ${MB(after.heapTotal)}MB`,
  );
}

describe("accumulation cardinality: one cell per position (piece 2b close-out)", () => {
  for (const n of RAMP) {
    const predicted = predictedChunkBytes(n, n, 5) + predictedMasterBytes(n, 5);
    const overBudget = predicted > MEM_BUDGET_BYTES;
    // A book of fewer chunks than shards runs inline whatever is asked for.
    const canShard = effectiveWorkers(n, 2) > 1;

    it.skipIf(!RUN_PERF)(
      `inline path at n=${n}, one cell per position`,
      () => measure(n, undefined),
      900_000,
    );

    it.skipIf(!RUN_PERF || overBudget || !canShard)(
      `sharded path at n=${n}, one cell per position (predicted peak ${GB(predicted)}GB)`,
      () => measure(n, 2),
      900_000,
    );
  }

  /**
   * The second genuine sharded point, and the one that separates the formula's
   * two factors. Three chunks over 4,096 cells costs LESS than two chunks over
   * 8,192 cells even though the book is larger, which is what a cost driven by
   * (chunks x cells) predicts and a cost driven by the position count alone
   * does not.
   */
  it.skipIf(!RUN_PERF)(
    "sharded path at n=12288 held to 4096 cells: cardinality varied against the book",
    () => measure(3 * SHARD_CHUNK, 2, SHARD_CHUNK),
    900_000,
  );
});

describe("a view-declaring run still completes end to end at modest cardinality", () => {
  it.skipIf(!RUN_PERF)(
    "engine.run over 256 positions in 256 cells",
    () => {
      clearPortfolios();
      const book = perAccountBook(256);
      const engine = createEngine(resolveDefaultContext());
      engine.loadPortfolio(book);
      const t0 = performance.now();
      const result = engine.run(
        makeRunRequest(market, {
          runId: "CARD-E2E",
          portfolioId: book.id,
          views: [ACCOUNT_VIEW],
        }),
      );
      const elapsedS = (performance.now() - t0) / 1000;
      const mem = process.memoryUsage();
      const bytes = JSON.stringify(result).length;
      // eslint-disable-next-line no-console
      console.log(
        `\n[CARD e2e] 256 positions in 256 cells: ${elapsedS.toFixed(2)}s; ` +
          `envelope ${MB(bytes)}MB of JSON; rss ${MB(mem.rss)}MB`,
      );
      expect(result.notImplemented).toEqual([]);
      expect(result.cashflows.cells).toHaveLength(256);
    },
    900_000,
  );
});
