import { describe, expect, it } from "vitest";
import {
  blendSizeCurve,
  percentileBands,
  shiftDecimalPaths,
  walFromRetention,
} from "../championFan";
import { overnightCurve } from "../prudentialSurface";

describe("walFromRetention", () => {
  it("matches (1/12) * sum(R[1..H]) for a simple ramp", () => {
    const R = Float64Array.from([1, 0.9, 0.8, 0.7]);
    // sum(R[1..3]) = 0.9+0.8+0.7 = 2.4; /12 = 0.2
    expect(walFromRetention(R)).toBeCloseTo(2.4 / 12, 12);
  });

  it("is 0 for the pure overnight curve", () => {
    expect(walFromRetention(overnightCurve(240))).toBe(0);
  });
});

describe("blendSizeCurve", () => {
  it("phiB=0 returns the core curve exactly", () => {
    const core = Float64Array.from([1, 0.95, 0.9, 0.85]);
    const overnight = overnightCurve(3);
    const blended = blendSizeCurve(core, overnight, 0);
    for (let h = 0; h < core.length; h++) expect(blended[h]).toBeCloseTo(core[h], 12);
  });

  it("phiB=1 returns the overnight curve exactly (WAL 0)", () => {
    const core = Float64Array.from([1, 0.95, 0.9, 0.85]);
    const overnight = overnightCurve(3);
    const blended = blendSizeCurve(core, overnight, 1);
    expect(blended[0]).toBeCloseTo(1, 12);
    for (let h = 1; h < blended.length; h++) expect(blended[h]).toBeCloseTo(0, 12);
  });

  it("WAL is linear in phiB between core and overnight", () => {
    const core = Float64Array.from([1, 0.9, 0.8, 0.7, 0.6]);
    const overnight = overnightCurve(4);
    const walCore = walFromRetention(core);
    const phiB = 0.37;
    const walBlend = walFromRetention(blendSizeCurve(core, overnight, phiB));
    expect(walBlend).toBeCloseTo((1 - phiB) * walCore, 9);
  });
});

describe("shiftDecimalPaths", () => {
  it("adds shockBp/1e4 to every step of every path", () => {
    const paths = [Float64Array.from([0.03, 0.031, 0.032]), Float64Array.from([0.04, 0.041, 0.042])];
    const shifted = shiftDecimalPaths(paths, 100);
    for (let p = 0; p < 2; p++) {
      for (let h = 0; h < 3; h++) expect(shifted[p][h]).toBeCloseTo(paths[p][h] + 0.01, 12);
    }
  });

  it("a negative shockBp subtracts", () => {
    const paths = [Float64Array.from([0.03])];
    expect(shiftDecimalPaths(paths, -50)[0][0]).toBeCloseTo(0.025, 12);
  });
});

describe("percentileBands", () => {
  it("collapses to mean=p5=p95 for a single path", () => {
    const one = [Float64Array.from([1, 0.9, 0.8])];
    const { mean, p5, p95 } = percentileBands(one);
    for (let h = 0; h < 3; h++) {
      expect(mean[h]).toBeCloseTo(one[0][h], 12);
      expect(p5[h]).toBeCloseTo(one[0][h], 12);
      expect(p95[h]).toBeCloseTo(one[0][h], 12);
    }
  });

  it("p5 <= mean <= p95 at every step across a spread of paths", () => {
    const paths = [
      Float64Array.from([1, 0.8, 0.6]),
      Float64Array.from([1, 0.9, 0.85]),
      Float64Array.from([1, 0.95, 0.9]),
      Float64Array.from([1, 0.7, 0.5]),
      Float64Array.from([1, 0.99, 0.97]),
    ];
    const { mean, p5, p95 } = percentileBands(paths);
    for (let h = 0; h < 3; h++) {
      expect(p5[h]).toBeLessThanOrEqual(mean[h] + 1e-9);
      expect(mean[h]).toBeLessThanOrEqual(p95[h] + 1e-9);
    }
  });

  it("throws on an empty path set", () => {
    expect(() => percentileBands([])).toThrow();
  });
});
