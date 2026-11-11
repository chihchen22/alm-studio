/**
 * Performance measurement: the full 100k x 360 x 5-scenario deterministic run.
 * Skipped by default so the standard suite
 * stays fast; run each measurement explicitly with RUN_PERF=1, filtering by name
 * so one Bash call stays under its wall-clock cap:
 *
 *   RUN_PERF=1 npx vitest run src/run/__tests__/perf.test.ts -t "per-scenario"
 *   RUN_PERF=1 npx vitest run src/run/__tests__/perf.test.ts -t "base-only"
 *   RUN_PERF=1 npx vitest run src/run/__tests__/perf.test.ts -t "single projection"
 *
 * Each measures its target directly and reports against the 60 s budget; none
 * asserts the budget, so a miss is recorded honestly rather than redefining the
 * target. Heap is reported as heapTotal after the run (the high-water the V8 heap
 * grew to; the run is synchronous so this is a faithful peak proxy) plus the
 * heapUsed delta over a gc-cleaned baseline where --expose-gc is available.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec, Position } from "../../contracts/position";
import { clearPortfolios } from "../../portfolio/registry";
import { aggregateScenario, type ScenarioRatePath } from "../../portfolio";
import { buildBaseCurve } from "../../scenario";
import { buildScenarioRatePath } from "../../projection/static";
import { createEngine, resolveDefaultContext } from "../index";
import {
  AS_OF,
  HORIZON,
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  mortgagePosition,
  nmdBetaPosition,
  nmdPosition,
  regulatoryScenarios,
} from "./fixtures";

const RUN_PERF = !!process.env.RUN_PERF;
const N_TOTAL = 100_000;
const MB = (b: number) => (b / 1024 / 1024).toFixed(0);

let market: MarketSnapshot;
beforeAll(async () => {
  if (RUN_PERF) market = await loadMarket();
});

/** A deterministic 100k-position book, evenly split across the four families. */
function bigBook(): PortfolioSpec {
  const perFamily = N_TOTAL / 4;
  const positions: Position[] = [];
  for (let i = 0; i < perFamily; i++) {
    const jitter = 1 + (i % 100) / 1000; // deterministic notional spread, no RNG
    positions.push(fixedPosition(`F${i}`, { notional: 250_000 * jitter, coupon: 0.05, maturityMonths: 60 }));
    positions.push(mortgagePosition(`M${i}`, { notional: 200_000 * jitter, originalBalance: 200_000 * jitter }));
    positions.push(nmdPosition(`D${i}`, { notional: 150_000 * jitter }));
    positions.push(nmdBetaPosition(`B${i}`, { notional: 100_000 * jitter }));
  }
  return { id: "PF-100K", label: "100k perf book", asOf: AS_OF, coa: makeCoa(), positions };
}

function baselineHeap(): number {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed;
}

function measureFullRun(
  durationMode: "per-scenario" | "base-only",
  shards?: number | "auto",
): void {
  clearPortfolios();
  const engine = createEngine({ ...resolveDefaultContext(), durationMode, shards });
  const book = bigBook();
  engine.loadPortfolio(book);
  const req = makeRunRequest(market, { runId: "PERF", portfolioId: book.id });

  const h0 = baselineHeap();
  const t0 = performance.now();
  const result = engine.run(req);
  const elapsedS = (performance.now() - t0) / 1000;
  const mem = process.memoryUsage();

  const label = shards === undefined ? durationMode : `${durationMode} shards=${shards}`;
  // eslint-disable-next-line no-console
  console.log(
    `\n[PERF ${label}] 100k x ${HORIZON}m x ${req.scenarios.length} scenarios: ` +
      `${elapsedS.toFixed(2)}s (target 60s) — ${elapsedS <= 60 ? "WITHIN" : "OVER"} budget; ` +
      `heapTotal ${MB(mem.heapTotal)}MB, heapUsed delta ${MB(mem.heapUsed - h0)}MB, rss ${MB(mem.rss)}MB`,
  );

  expect(result.notImplemented).toEqual([]);
  expect(result.cashflows.byScenario).toHaveLength(req.scenarios.length);
}

describe("run — 100k x 360 x 5-scenario performance", () => {
  it.skipIf(!RUN_PERF)(
    "measures the full run wall-clock with per-scenario durations",
    () => measureFullRun("per-scenario"),
    600_000,
  );

  it.skipIf(!RUN_PERF)(
    "measures the full run wall-clock with base-only durations",
    () => measureFullRun("base-only"),
    600_000,
  );

  it.skipIf(!RUN_PERF)(
    "measures the full run wall-clock with base-only durations, sharded (auto)",
    () => measureFullRun("base-only", "auto"),
    600_000,
  );

  it.skipIf(!RUN_PERF)(
    "sharded 100k run is byte-identical to the single-thread run",
    () => {
      clearPortfolios();
      const book = bigBook();
      const run = (shards?: number | "auto") => {
        clearPortfolios();
        const engine = createEngine({ ...resolveDefaultContext(), shards });
        engine.loadPortfolio(book);
        return engine.run(makeRunRequest(market, { runId: "PERF-ID", portfolioId: book.id }));
      };
      expect(JSON.stringify(run("auto"))).toEqual(JSON.stringify(run(undefined)));
    },
    600_000,
  );

  it.skipIf(!RUN_PERF)(
    "measures a single 100k x 360 projection (one scenario, no EVE grid)",
    () => {
      const book = bigBook();
      const baseCurve = buildBaseCurve(market);
      const baseScenario = regulatoryScenarios().find((s) => s.rateSpec.kind === "base")!;
      const path = buildScenarioRatePath(baseCurve, baseScenario, HORIZON);
      const sp: ScenarioRatePath = { scenarioId: baseScenario.id, path };
      const grid = { horizonMonths: HORIZON, asOf: AS_OF };

      const h0 = baselineHeap();
      const t0 = performance.now();
      const cf = aggregateScenario(book, sp, grid);
      const elapsedS = (performance.now() - t0) / 1000;
      const mem = process.memoryUsage();

      // eslint-disable-next-line no-console
      console.log(
        `\n[PERF projection] single 100k x ${HORIZON}m projection: ` +
          `${elapsedS.toFixed(2)}s (target 60s) — ${elapsedS <= 60 ? "WITHIN" : "OVER"} budget; ` +
          `heapTotal ${MB(mem.heapTotal)}MB, heapUsed delta ${MB(mem.heapUsed - h0)}MB`,
      );

      expect(cf.byFamily.length).toBeGreaterThan(0);
    },
    600_000,
  );
});
