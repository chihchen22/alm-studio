/**
 * The deterministic 1M reset is an ACCRUAL rate. It must be the simple forward
 * the discount factors imply, (P(t)/P(t+dt) - 1)/dt, under every curve
 * convention, so a monthly floating leg telescopes to par on its own curve.
 * Before 2026-09-24 rateAt returned forwardSwapRate over one month, which under
 * "semiannual_bond" is the bond-equivalent quote, about 3 bp too high at 1M.
 * Under "annual_act360" the two are the same expression, so nothing moves there.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { loadMarketSnapshot } from "../marketData";
import { bootstrapZeroCurve } from "../bootstrap";
import { DeterministicRatePath } from "../ratePath";

const PUBLIC_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");
const CONSTRUCTED_PATH = resolve(__dirname, "fixtures", "market_constructed.json");
const DT = 1 / 12;

describe("DeterministicRatePath: the 1M reset accrues on the simple forward", () => {
  it("rateAt is the money-market forward on the Treasury CMT pack", async () => {
    const curve = bootstrapZeroCurve(await loadMarketSnapshot(PUBLIC_PATH));
    expect(curve.convention).toBe("semiannual_bond");
    const path = new DeterministicRatePath(curve, 360);
    for (const k of [0, 1, 12, 60, 359]) {
      const t = k * DT;
      expect(path.rateAt(k)).toBe(curve.forwardRate(t, t + DT));
      // Not the bond-equivalent quote: that sits more than 1 bp higher at 1M.
      expect(curve.forwardSwapRate(t, t + DT) - path.rateAt(k)).toBeGreaterThan(1e-4);
    }
  });

  it("a zero-margin monthly floater prices at par on the same curve", async () => {
    const curve = bootstrapZeroCurve(await loadMarketSnapshot(PUBLIC_PATH));
    const n = 120;
    const path = new DeterministicRatePath(curve, n);
    let pv = curve.discountFactor(n * DT);
    for (let k = 0; k < n; k++) pv += path.rateAt(k) * DT * curve.discountFactor((k + 1) * DT);
    expect(Math.abs(pv - curve.discountFactor(0))).toBeLessThan(1e-9);
  });

  it("is unchanged under annual_act360 (the swap-rate branch is the same expression)", async () => {
    const curve = bootstrapZeroCurve(await loadMarketSnapshot(CONSTRUCTED_PATH));
    expect(curve.convention).toBe("annual_act360");
    const path = new DeterministicRatePath(curve, 360);
    for (const k of [0, 1, 12, 60, 359]) {
      const t = k * DT;
      expect(path.rateAt(k)).toBe(curve.forwardSwapRate(t, t + DT));
    }
  });
});
