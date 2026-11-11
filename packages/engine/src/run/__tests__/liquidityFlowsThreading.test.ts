/**
 * The `liquidityFlows` option reaches the gap metric under one name, from the
 * pipeline context through the stage environment to the contractual pass and the gap stage. The numbers
 * themselves are pinned in gap/__tests__/liquidityInterest.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { LiquidityFlowsOption, RunResult } from "../../contracts/run";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { resolveDefaultContext } from "../engine";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function run(liquidityFlows?: unknown): RunResult {
  const book = twoSidedBook("PF-LF-T1");
  const request = makeRunRequest(market, { portfolioId: book.id });
  return buildRunResult(request, book, {
    ...resolveDefaultContext(),
    ...(liquidityFlows !== undefined ? { liquidityFlows: liquidityFlows as LiquidityFlowsOption } : {}),
  } as RunPipelineContext);
}

describe("liquidityFlows threading (slice 4a, Task 1)", () => {
  it("principal-plus-interest writes withInterest on every liquidity ladder and on no repricing ladder", () => {
    const r = run("principal-plus-interest");
    expect(r.gap.liquidity.length).toBe(5);
    for (const l of r.gap.liquidity) {
      expect(has(l, "withInterest")).toBe(true);
      expect(l.withInterest!.rows).toHaveLength(l.rows.length);
      expect(Object.keys(l).at(-1)).toBe("withInterest");
    }
    for (const l of r.gap.repricing) expect(has(l, "withInterest")).toBe(false);
  });

  it("principal and absent write no withInterest key", () => {
    for (const r of [run(), run("principal")]) {
      for (const l of [...r.gap.liquidity, ...r.gap.repricing]) expect(has(l, "withInterest")).toBe(false);
    }
  });

  it("any other value is refused before the walk, naming the option", () => {
    expect(() => run("interest-only")).toThrow(/context\.liquidityFlows must be "principal" or "principal-plus-interest"/);
  });
});
