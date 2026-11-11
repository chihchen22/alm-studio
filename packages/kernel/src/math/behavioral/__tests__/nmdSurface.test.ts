import { describe, expect, it } from "vitest";
import {
  balanceSensitivity,
  nmdIncentiveAt,
  nmdSurfaceRidge,
  surface3DData,
  NMD_DEFAULTS,
} from "../nmdModel";

const P = NMD_DEFAULTS;

describe("nmdIncentiveAt", () => {
  it("equals the average of growth/decay at spread = logisticMidpoint", () => {
    const v = nmdIncentiveAt(P, P.logisticMidpoint);
    expect(v).toBeCloseTo((P.maxRateGrowth + P.maxRateDecay) / 2, 12);
  });

  it("is strictly increasing in spread", () => {
    let prev = -Infinity;
    for (let s = -5; s <= 5; s += 0.25) {
      const v = nmdIncentiveAt(P, s);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("approaches maxRateGrowth / maxRateDecay at the tails", () => {
    expect(nmdIncentiveAt(P, -50)).toBeCloseTo(P.maxRateGrowth, 6);
    expect(nmdIncentiveAt(P, 50)).toBeCloseTo(P.maxRateDecay, 6);
  });

  it("reproduces the baseAt factor embedded in surface3DData", () => {
    // surface z[i][j] = g(balance[j]) * baseAt(spread[i]); the new primitive
    // must BE that baseAt, so the overlay ridge lands exactly on the mesh.
    const surf = surface3DData(P);
    for (let i = 0; i < surf.spread.length; i += 7) {
      for (let j = 0; j < surf.balance.length; j += 7) {
        const g = balanceSensitivity(surf.balance[j], P.sens);
        expect(surf.z[i][j]).toBeCloseTo(g * nmdIncentiveAt(P, surf.spread[i]), 9);
      }
    }
  });
});

describe("nmdSurfaceRidge", () => {
  it("returns the same spread grid as surface3DData's default (41 points, -4..4)", () => {
    const ridge = nmdSurfaceRidge(P, 1_000_000);
    expect(ridge.spread).toHaveLength(41);
    expect(ridge.spread[0]).toBeCloseTo(-4, 12);
    expect(ridge.spread[ridge.spread.length - 1]).toBeCloseTo(4, 12);
    expect(ridge.z).toHaveLength(ridge.spread.length);
  });

  it("lies exactly on the surface mesh at a balance grid node", () => {
    const surf = surface3DData(P);
    const k = 25; // an arbitrary balance column
    const balance = surf.balance[k];
    const ridge = nmdSurfaceRidge(P, balance);
    expect(ridge.spread).toHaveLength(surf.spread.length);
    for (let i = 0; i < surf.spread.length; i++) {
      expect(ridge.spread[i]).toBeCloseTo(surf.spread[i], 12);
      expect(ridge.z[i]).toBeCloseTo(surf.z[i][k], 9);
    }
  });

  it("scales by g(balance): a larger account sits higher where decay is positive", () => {
    const small = nmdSurfaceRidge(P, 100_000);
    const large = nmdSurfaceRidge(P, 10_000_000);
    const iPos = small.spread.findIndex((s) => s >= 2);
    expect(large.z[iPos]).toBeGreaterThan(small.z[iPos]);
  });
});
