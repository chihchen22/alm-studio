import { describe, expect, it } from "vitest";
import { DeterministicRatePath, rehydrateCurve, type ZeroCurve } from "@alm/kernel";
import { IndexRatePath } from "../../rateIndex/indexRatePath";
import { IndexSeries } from "../../rateIndex/indexSeries";
import type { RateIndex } from "../../contracts/rateIndex";
import { SWAP_FILL_ABOVE_MONTHS, estimateSpreads, fillTenorProblems, indexRateAt0, swapRateAt0 } from "../estimate";

const NODES_T = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];
const flatCurve = (z: number): ZeroCurve =>
  rehydrateCurve({ t: NODES_T, z: NODES_T.map(() => z), convention: "semiannual_bond" });
const flatAct360 = (z: number): ZeroCurve =>
  rehydrateCurve({ t: NODES_T, z: NODES_T.map(() => z), convention: "annual_act360" });

describe("estimateSpreads", () => {
  it("is zero for the same curve and equals the flat-curve gap for two flat curves", () => {
    const a = flatCurve(0.04);
    const b = flatCurve(0.0425);
    expect(estimateSpreads(a, a, [1, 3, 12]).map((s) => s.spreadBp)).toEqual([0, 0, 0]);
    const s = estimateSpreads(b, a, [3]);
    expect(s[0]!.tenorMonths).toBe(3);
    expect(s[0]!.spreadBp).toBeCloseTo((indexRateAt0(b, 3) - indexRateAt0(a, 3)) * 10000, 6);
    expect(s[0]!.spreadBp).toBeGreaterThan(24);
    expect(s[0]!.spreadBp).toBeLessThan(26);
  });
  it("matches IndexRatePath at step 0", () => {
    const c = flatCurve(0.05);
    const path = new IndexRatePath(new DeterministicRatePath(c, 12, 1 / 12), { tenorMonths: 6, basis: 0 });
    expect(indexRateAt0(c, 6)).toBe(path.rateAt(0));
  });
});

describe("estimateSpreads above 12 months (spec v5 decision 46)", () => {
  // Flat continuously compounded zero curves: every discount factor is e^(-z t).
  // Semi-annual bond par rate: (1 - e^(-zT)) / sum_k 0.5 e^(-zk/2) = 2 (e^(z/2) - 1) at every whole-year T.
  const semiGapBp = 2 * (Math.exp(0.05 / 2) - Math.exp(0.04 / 2)) * 10000; // about 102.28 bp
  // Annual ACT/360 par rate: (1 - e^(-zT)) / sum_k (365/360) e^(-zk) = (e^z - 1) x 360/365.
  const annualGapBp = (Math.exp(0.05) - Math.exp(0.04)) * (360 / 365) * 10000; // about 103.17 bp
  // The 12-month simple index rate telescopes to e^z - 1.
  const simple12Bp = (Math.exp(0.05) - Math.exp(0.04)) * 10000; // about 104.60 bp

  it("pins the boundary at 12 months", () => {
    expect(SWAP_FILL_ABOVE_MONTHS).toBe(12);
  });
  it("keeps the simple index-rate gap at 12 months and below", () => {
    const [r12] = estimateSpreads(flatCurve(0.05), flatCurve(0.04), [12]);
    expect(r12!.spreadBp).toBeCloseTo(simple12Bp, 5);
  });
  it("fills whole-year rows above 12 months with the par swap rate gap on the semi-annual bond basis", () => {
    const rows = estimateSpreads(flatCurve(0.05), flatCurve(0.04), [24, 120, 360]);
    for (const r of rows) expect(r.spreadBp).toBeCloseTo(semiGapBp, 5);
  });
  it("fills on the annual ACT/360 basis for an annual_act360 curve", () => {
    const rows = estimateSpreads(flatAct360(0.05), flatAct360(0.04), [24, 120]);
    for (const r of rows) expect(r.spreadBp).toBeCloseTo(annualGapBp, 5);
  });
  it("reads a row above 12 months exactly as a swap index reads at step 0", () => {
    const c = flatCurve(0.05);
    // A 10-year constant-maturity-swap index with no basis, evaluated by the run's own evaluator at step 0.
    const table = new Map<string, RateIndex>([["cms-10y", { id: "cms-10y", label: "x", kind: "constant-maturity-swap", tenorYears: 10, basis: 0 }]]);
    const swapIndexAt0 = new IndexSeries(table, new DeterministicRatePath(c, 12)).valueAt("cms-10y", 0);
    expect(swapRateAt0(c, 120)).toBe(swapIndexAt0);
  });
  it("names each row above 12 months that is not a whole number of years", () => {
    expect(fillTenorProblems([1, 12, 18, 24, 30])).toEqual([
      "row 3: a fill above 12 months reads the par swap rate, which needs whole years (24, 36 and so on up to 360 months); got 18 months",
      "row 5: a fill above 12 months reads the par swap rate, which needs whole years (24, 36 and so on up to 360 months); got 30 months",
    ]);
    expect(fillTenorProblems([1, 3, 6, 12, 24, 360])).toEqual([]);
  });
  it("throws rather than fill a row the check refuses", () => {
    expect(() => estimateSpreads(flatCurve(0.05), flatCurve(0.04), [18])).toThrow("18 months");
  });
});
