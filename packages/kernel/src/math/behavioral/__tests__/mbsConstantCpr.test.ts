/**
 * ConstantCPR through the runMBSOnPaths seam (wave 3): the classroom static
 * benchmark made runnable. Load-bearing properties: adding the seam changed
 * nothing (default == explicit FourFactorCPR bit-for-bit), and ConstantCPR is
 * rate-path-invariant by construction.
 */
import { describe, expect, it } from "vitest";

import { MBS_DEFAULTS, runMBSOnPaths } from "../mbsModel";
import { ConstantCPR, FourFactorCPR } from "../prepay";

const N = 120;

function flatPath(rate: number): Float64Array {
  return new Float64Array(N).fill(rate);
}

function risingPath(start: number): Float64Array {
  const p = new Float64Array(N);
  for (let t = 0; t < N; t++) p[t] = start + 0.0001 * t;
  return p;
}

describe("runMBSOnPaths model seam", () => {
  it("the default model reproduces an explicit FourFactorCPR bit-for-bit (seam regression)", () => {
    const paths = [flatPath(0.04), risingPath(0.035)];
    const viaDefault = runMBSOnPaths(paths, MBS_DEFAULTS);
    const viaExplicit = runMBSOnPaths(paths, MBS_DEFAULTS, new FourFactorCPR(MBS_DEFAULTS));
    expect(viaExplicit.wal).toBe(viaDefault.wal);
    expect(viaExplicit.lifeCpr).toBe(viaDefault.lifeCpr);
    expect(Array.from(viaExplicit.cprMean)).toEqual(Array.from(viaDefault.cprMean));
    expect(Array.from(viaExplicit.balMean)).toEqual(Array.from(viaDefault.balMean));
  });

  it("ConstantCPR reports one flat speed and is rate-path-invariant", () => {
    const cpr = 0.08;
    const low = runMBSOnPaths([flatPath(0.02)], MBS_DEFAULTS, new ConstantCPR(cpr));
    const high = runMBSOnPaths([flatPath(0.09)], MBS_DEFAULTS, new ConstantCPR(cpr));
    for (let t = 0; t < N; t++) {
      expect(low.cprMean[t]).toBeCloseTo(cpr * 100, 12);
    }
    // No rate response: a 700bp move in the driver changes nothing.
    expect(high.wal).toBe(low.wal);
    expect(Array.from(high.balMean)).toEqual(Array.from(low.balMean));
    expect(Array.from(high.cprMean)).toEqual(Array.from(low.cprMean));
  });

  it("a faster constant speed shortens WAL (amortization loop is live)", () => {
    const slow = runMBSOnPaths([flatPath(0.04)], MBS_DEFAULTS, new ConstantCPR(0.04));
    const fast = runMBSOnPaths([flatPath(0.04)], MBS_DEFAULTS, new ConstantCPR(0.2));
    expect(fast.wal).toBeLessThan(slow.wal);
  });
});
