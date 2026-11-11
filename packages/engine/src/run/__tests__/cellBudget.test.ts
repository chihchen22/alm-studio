/**
 * The cell budget: the guard the measured cardinality cost earned.
 *
 * The limitations page records, and cardinality.test.ts measures, that the
 * cell-grain sink's peak is `5 * cells * horizon * 8` bytes per buffer times
 * the scenario count times the chunk count plus one. Left ungated, a
 * high-cardinality view on a large book dies as an out-of-memory that takes the
 * process with it. These cases pin a refusal computed BEFORE any allocation.
 *
 * The budget is tested with a tiny budget on a small book, never with a big
 * book: the arithmetic is the thing under test, and a case that had to allocate
 * gigabytes to prove a refusal would be both slow and self-defeating.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { buildCellPlan } from "../../portfolio/cells";
import { buildScenarioRatePath } from "../../projection/static";
import { buildBaseCurve } from "../../scenario";
import { CellBudgetError } from "../executorErrors";
import { CHUNK_METRICS, SHARD_CHUNK } from "../shard/chunk";
import {
  DEFAULT_CELL_BUDGET_BYTES,
  predictedPassBytes,
  runStaticPass,
  type StaticPassGroup,
} from "../shard/staticPass";
import {
  BY_SEGMENT_VIEW,
  HORIZON,
  loadMarket,
  regulatoryScenarios,
  viewSegmentedBook,
} from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

/** One ChunkSink's bytes, stated here from first principles, not from the code. */
const sinkBytes = (cells: number) => CHUNK_METRICS * cells * HORIZON * 8;

function passGroup(): { group: StaticPassGroup; cells: number; positions: number } {
  const book = viewSegmentedBook();
  const plan = buildCellPlan(book, [BY_SEGMENT_VIEW]);
  const base = buildBaseCurve(market);
  const group: StaticPassGroup = {
    positions: book.positions,
    scenarios: regulatoryScenarios().map((s) => ({
      scenarioId: s.id,
      rateSpec: s.rateSpec,
      path: buildScenarioRatePath(base, s, HORIZON),
    })),
  };
  return { group, cells: plan.cells.length, positions: book.positions.length };
}

function planFor() {
  const book = viewSegmentedBook();
  return buildCellPlan(book, [BY_SEGMENT_VIEW]);
}

describe("predictedPassBytes", () => {
  it("counts one master sink per scenario plus one reused scratch on the inline path", () => {
    // The inline path holds `scenarios` masters and ONE scratch, whatever the
    // chunk count: the scratch is reused across chunks.
    expect(predictedPassBytes(1_000, HORIZON, 40_000, 5, 1)).toBe(6 * sinkBytes(1_000));
  });

  it("counts every retained chunk buffer on the sharded path", () => {
    // 40,000 positions is 10 chunks of SHARD_CHUNK. The sharded path retains one
    // buffer per (scenario, chunk) until it posts, on top of the masters.
    const chunks = Math.ceil(40_000 / SHARD_CHUNK);
    expect(chunks).toBe(10);
    expect(predictedPassBytes(1_000, HORIZON, 40_000, 5, 4)).toBe(
      5 * sinkBytes(1_000) + chunks * 5 * sinkBytes(1_000),
    );
  });

  it("defaults the budget to 4 GiB", () => {
    expect(DEFAULT_CELL_BUDGET_BYTES).toBe(4 * 1024 ** 3);
  });
});

describe("runStaticPass cell budget", () => {
  it("refuses a pass whose predicted peak exceeds the budget, before allocating", () => {
    const { group } = passGroup();
    const plan = planFor();
    let err: unknown;
    try {
      runStaticPass([group], plan, HORIZON, undefined, market, 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CellBudgetError);
    const e = err as CellBudgetError;
    // The refusal must name what a caller has to change: which view, how many
    // cells it made, and the two byte figures it sat between.
    expect(e.viewIds).toEqual([BY_SEGMENT_VIEW.id]);
    expect(e.cellCount).toBe(plan.cells.length);
    expect(e.budgetBytes).toBe(1);
    expect(e.predictedBytes).toBe(
      predictedPassBytes(plan.cells.length, HORIZON, group.positions.length, 5, 1),
    );
    expect(e.message).toContain(BY_SEGMENT_VIEW.id);
    expect(e.message).toContain(String(plan.cells.length));
  });

  it("runs a pass that sits inside the budget", () => {
    const { group } = passGroup();
    const plan = planFor();
    const sinks = runStaticPass([group], plan, HORIZON, undefined, market, DEFAULT_CELL_BUDGET_BYTES);
    expect(sinks.size).toBe(5);
  });
});
