/**
 * Pins every MMA repricing-surface illustrative value to spec v2 Section 3.4
 * (surface table and book-aggregation rule), Section 2.4 (initialisation
 * branch choice) and the Section 3 preamble (snapshot levels). A failure here
 * means a value moved; the fix is a new spec version, not an edit to the test.
 */
import { describe, expect, it } from "vitest";
import { beta, dTarget, lambda } from "../../repricingSurface";
import {
  ILLUSTRATIVE_SNAPSHOT,
  REPRICING_BETA_STATIC,
  REPRICING_BIN_BALANCES,
  REPRICING_BIN_SHARES,
  REPRICING_ILLUSTRATIVE_BINS,
  REPRICING_ILLUSTRATIVE_PARAMS as P,
  REPRICING_ILLUSTRATIVE_SPEC,
  REPRICING_LN_B_REF,
  illustrativeEquilibriumRate,
} from "../repricingIllustrative";

describe("MMA repricing surface illustrative parameters (spec v2, Section 3.4)", () => {
  it("names the spec version of record", () => {
    expect(REPRICING_ILLUSTRATIVE_SPEC).toBe(
      "illustrative-deposit-parameterization v3 (2026-09-08)",
    );
  });

  it("pins the snapshot levels", () => {
    expect(ILLUSTRATIVE_SNAPSHOT.overnightPct).toBe(4);
    expect(ILLUSTRATIVE_SNAPSHOT.threeMonthPct).toBe(4);
  });

  it("pins the surface table", () => {
    expect(P.alpha).toBe(0.1);
    expect(P.c0).toBe(0.2);
    expect(P.c1).toBe(0.1);
    expect(P.s).toBe(0.05);
    expect(P.k).toBe(1.5);
    expect(P.m).toBe(2);
    expect(P.l0).toBe(-1.4);
    expect(P.l1).toBe(0.3);
    expect(P.lnBRef).toBe(Math.log(100_000));
    expect(REPRICING_LN_B_REF).toBe(Math.log(100_000));
  });

  it("pins the static comparator beta", () => {
    expect(REPRICING_BETA_STATIC).toBe(0.4);
  });

  it("reproduces the Section 3.4 anchor readings at the reference account", () => {
    // Ceiling 0.55 at the 100,000 dollar reference; 0.49 at 10,000 and 0.64 at
    // 5,000,000 (the c1 anchor row).
    const bmax = (usd: number) =>
      1 / (1 + Math.exp(-(P.c0 + P.c1 * (Math.log(usd) - P.lnBRef))));
    expect(bmax(100_000)).toBeCloseTo(0.55, 2);
    expect(bmax(10_000)).toBeCloseTo(0.49, 2);
    expect(bmax(5_000_000)).toBeCloseTo(0.64, 2);
    // Floor 0.03 at the reference account (the s anchor row).
    expect(P.s * bmax(100_000)).toBeCloseTo(0.03, 2);
  });

  it("reproduces the Section 4 point beta and equilibria", () => {
    const zRef = 0;
    expect(beta(4, zRef, P)).toBeCloseTo(0.53, 2);
    expect(illustrativeEquilibriumRate(100_000)).toBeCloseTo(2.2, 1);
    expect(illustrativeEquilibriumRate(5_000_000)).toBeCloseTo(2.6, 1);
  });

  it("reproduces the Section 3.4 speed anchors", () => {
    // 0.20 per month at the reference, 0.11 at 10,000, 0.44 at 5,000,000.
    expect(lambda(0, P)).toBeCloseTo(0.2, 2);
    expect(lambda(Math.log(10_000) - P.lnBRef, P)).toBeCloseTo(0.11, 2);
    expect(lambda(Math.log(5_000_000) - P.lnBRef, P)).toBeCloseTo(0.44, 2);
  });

  it("holds the large-balance long-run effective beta below one", () => {
    // The stated ceiling on the slope pick: 0.79 at five million, under one.
    const z = Math.log(5_000_000) - P.lnBRef;
    const r = ILLUSTRATIVE_SNAPSHOT.threeMonthPct;
    const eps = 0.01;
    const longRun = (dTarget(r + eps, z, P) - dTarget(r - eps, z, P)) / (2 * eps);
    expect(longRun).toBeGreaterThan(0.7);
    expect(longRun).toBeLessThan(1);
  });

  it("pins the book aggregation bins", () => {
    expect([...REPRICING_BIN_BALANCES]).toEqual([50_000, 500_000, 5_000_000]);
    expect([...REPRICING_BIN_SHARES]).toEqual([0.3, 0.4, 0.3]);
    expect([...REPRICING_ILLUSTRATIVE_BINS.lnbLast]).toEqual(
      [50_000, 500_000, 5_000_000].map((b) => Math.log(b)),
    );
    expect([...REPRICING_ILLUSTRATIVE_BINS.weightsLast]).toEqual([0.3, 0.4, 0.3]);
  });

  it("anchors every bin at its own equilibrium at the snapshot rate", () => {
    REPRICING_ILLUSTRATIVE_BINS.lnbLast.forEach((lnb, i) => {
      expect(REPRICING_ILLUSTRATIVE_BINS.anchorsLast[i]).toBeCloseTo(
        dTarget(ILLUSTRATIVE_SNAPSHOT.threeMonthPct, lnb - P.lnBRef, P),
        12,
      );
    });
  });
});
