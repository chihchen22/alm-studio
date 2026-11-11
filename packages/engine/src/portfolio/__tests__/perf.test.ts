import { describe, it, expect } from "vitest";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { aggregateScenario } from "../aggregate";
import type { BucketGrid } from "../../contracts/results";
import type { Position } from "../../contracts/position";
import { AS_OF, fixedLoanTerms, makeCoa } from "./fixtures";

const HORIZON = 360;
const grid: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };
const path = new ConstantRatePath(0.04, HORIZON);

/**
 * Hot-loop measurement: 100k synthetic fixed-loan positions x 360 months. Times
 * one scenario reduction and asserts the result footprint is O(families x
 * horizon), independent of position count, which is the observable signature of
 * "no per-position result array retained".
 */
describe("hot-loop scale", () => {
  it("aggregates 100k positions x 360 months and retains no per-position array", () => {
    const N = 100_000;
    const positions: Position[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const maturity = 12 + (i % 348); // 12..359, all within horizon
      positions[i] = {
        id: `p${i}`,
        familyId: "FIXED",
        coaNodeId: "fixed-loans",
        terms: fixedLoanTerms(`p${i}`, { notional: 100_000 + (i % 1000), maturityMonths: maturity, coupon: 0.05 }),
      };
    }
    const pf = { id: "PERF", label: "Perf book", asOf: AS_OF, coa: makeCoa(), positions };

    const t0 = performance.now();
    const res = aggregateScenario(pf, { scenarioId: "base", path }, grid);
    const elapsedMs = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[perf] aggregateScenario 100k x 360: ${elapsedMs.toFixed(1)} ms`);

    // Result footprint is independent of N: two families, each series length HORIZON.
    expect(res.byFamily).toHaveLength(2);
    for (const fam of res.byFamily) {
      expect(fam.series.principal).toHaveLength(HORIZON);
      expect(fam.series.balance).toHaveLength(HORIZON);
      expect(fam.series.interest).toHaveLength(HORIZON);
    }
    expect(elapsedMs).toBeLessThan(60_000);
  });
});
