/**
 * Spec Section 8.3. The kernel costs a handful of map lookups per run and
 * nothing per position, so the harness path must not read slower than the
 * import path by more than the margin. Median of three on each side; the
 * failure names both medians, because "it was slow once" is not a finding.
 *
 * The guard is opt-IN: it runs only under ALM_TIMING=1 and is skipped
 * otherwise. A wall-clock comparison is worth nothing on a box whose load is
 * unknown, and the case is expensive (see the timeout below), so the default
 * suite does not pay for it; the operator who wants the measurement asks for it
 * on a quiet machine.
 *
 * The timeout is 600s, not the 60s first planned: one demo-book run costs
 * about 30 seconds on this machine, and the case takes eight of them (one warm
 * run plus three samples on each path), so a 60s budget could not have held
 * the measurement it asks for.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { buildDemoPortfolio, buildDemoRequest } from "../../../../../data/src/demo/request";
import { defaultHarness } from "../../plugins/defaultHarness";
import { resolveDefaultContext } from "../engine";
import { buildRunResult } from "../orchestrate";
import { loadMarket } from "./fixtures";

const MARGIN = 0.15;
const RUN_TIMING = process.env.ALM_TIMING === "1";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function median3(run: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[1];
}

describe("timing guard", () => {
  it.skipIf(!RUN_TIMING)(
    "runs the demo book through the harness within 15 percent of the import path",
    () => {
      const portfolio = buildDemoPortfolio();
      const request = buildDemoRequest(portfolio, market, {
        startedAt: "2026-07-16T00:00:00.000Z",
        finishedAt: "2026-07-16T00:00:01.000Z",
      });
      const base = resolveDefaultContext();
      const harness = defaultHarness();
      // One warm run on each path first, so neither median pays for JIT warmup.
      buildRunResult(request, portfolio, base);
      buildRunResult(request, portfolio, { ...base, harness });
      const importMedian = median3(() => {
        buildRunResult(request, portfolio, base);
      });
      const harnessMedian = median3(() => {
        buildRunResult(request, portfolio, { ...base, harness });
      });
      const ratio = harnessMedian / importMedian;
      expect(
        ratio,
        `harness median ${harnessMedian.toFixed(1)} ms vs import median ${importMedian.toFixed(1)} ms ` +
          `(ratio ${ratio.toFixed(3)}, margin ${1 + MARGIN})`,
      ).toBeLessThanOrEqual(1 + MARGIN);
    },
    600_000,
  );
});
