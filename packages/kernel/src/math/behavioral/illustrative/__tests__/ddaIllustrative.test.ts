/**
 * Pins every DDA illustrative value to spec v3 Section 3.1 (slider table and
 * the non-slider structure list), Section 2.1 (the rs0 branch choice) and
 * Section 8 (theta 0.20 to 0.05 on the duration-sign check).
 * A failure here means a value moved; the fix is a new spec version, not an
 * edit to the test.
 */
import { describe, expect, it } from "vitest";
import {
  DDA_BOOK_BUCKETS,
  DDA_CONCENTRATION,
  DDA_DRIFT_CLIP,
  DDA_F_STABLE,
  DDA_HZ_AGE1,
  DDA_HZ_AGE36,
  DDA_HZ_FULL,
  DDA_HZ_LENGTH,
  DDA_HZ_MAX,
  DDA_HZ_RAMP_END_AGE,
  DDA_ILLUSTRATIVE_PARAMS,
  DDA_ILLUSTRATIVE_SPEC,
  DDA_MEAN_PHI,
  DDA_P_MAX_COLLAPSE,
  DDA_W0_AGES,
  DDA_W0_WEIGHTS,
  ddaHazardAtAge,
  ddaOvernightFraction,
} from "../ddaIllustrative";

describe("DDA illustrative parameters (spec v3, Section 3.1)", () => {
  it("names the spec version of record", () => {
    expect(DDA_ILLUSTRATIVE_SPEC).toBe(
      "illustrative-deposit-parameterization v3 (2026-09-08)",
    );
  });

  it("pins the slider table", () => {
    expect(DDA_ILLUSTRATIVE_PARAMS.theta).toBe(0.05);
    expect(DDA_ILLUSTRATIVE_PARAMS.drift.a).toBe(0.002);
    expect(DDA_ILLUSTRATIVE_PARAMS.drift.b).toBe(-0.0002);
    expect(DDA_ILLUSTRATIVE_PARAMS.collapse.gamma).toBe(0.005);
    expect(DDA_ILLUSTRATIVE_PARAMS.collapse.mu).toBe(0.02);
    expect(DDA_ILLUSTRATIVE_PARAMS.collapse.rJump).toBe(0.2);
    expect(DDA_ILLUSTRATIVE_PARAMS.rs0).toBe(0);
    expect(DDA_ILLUSTRATIVE_PARAMS.C0).toBe(10);
    expect(DDA_F_STABLE).toBe(0.9);
  });

  it("keeps C0 equal to the drift threshold a over |b|", () => {
    const { a, b } = DDA_ILLUSTRATIVE_PARAMS.drift;
    expect(a / Math.abs(b)).toBeCloseTo(DDA_ILLUSTRATIVE_PARAMS.C0, 10);
  });

  it("pins the age-hazard ramp endpoints and shape", () => {
    expect(DDA_HZ_AGE1).toBe(0.03);
    expect(DDA_HZ_AGE36).toBe(0.018);
    expect(DDA_HZ_RAMP_END_AGE).toBe(36);
    expect(DDA_HZ_MAX).toBe(0.1);
    expect(ddaHazardAtAge(1)).toBe(0.03);
    expect(ddaHazardAtAge(36)).toBe(0.018);
    expect(ddaHazardAtAge(360)).toBe(0.018);
    // Linear between the endpoints: the midpoint of the ramp is the midpoint
    // of the two hazards.
    expect(ddaHazardAtAge(18.5)).toBeCloseTo((0.03 + 0.018) / 2, 12);
  });

  it("indexes the hazard vector by the month that ages an account", () => {
    expect(DDA_HZ_FULL).toHaveLength(DDA_HZ_LENGTH);
    expect(DDA_HZ_LENGTH).toBe(480);
    expect(DDA_HZ_FULL[0]).toBe(ddaHazardAtAge(1));
    expect(DDA_HZ_FULL[35]).toBe(ddaHazardAtAge(36));
    // Long enough for the oldest cohort plus the 240-month horizon.
    expect(DDA_HZ_LENGTH).toBeGreaterThanOrEqual(180 + 240 + 1);
  });

  it("pins the seasoned hazard to about 20 percent annual attrition", () => {
    expect(1 - (1 - DDA_HZ_AGE36) ** 12).toBeCloseTo(0.196, 3);
  });

  it("pins the snapshot age mix", () => {
    expect([...DDA_W0_AGES]).toEqual([6, 18, 36, 72, 120, 180]);
    expect([...DDA_W0_WEIGHTS]).toEqual([0.1, 0.15, 0.2, 0.25, 0.2, 0.1]);
    expect(DDA_W0_WEIGHTS.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
  });

  it("pins the clips", () => {
    expect(DDA_DRIFT_CLIP.lo).toBe(-0.02);
    expect(DDA_DRIFT_CLIP.hi).toBe(0);
    expect(DDA_P_MAX_COLLAPSE).toBe(0.05);
  });

  it("pins the concentration ramp and the book bucket table", () => {
    expect(DDA_CONCENTRATION.b0).toBe(2_000_000);
    expect(DDA_CONCENTRATION.kappa).toBe(1);
    expect(DDA_CONCENTRATION.phiMax).toBe(0.5);
    expect(DDA_CONCENTRATION.bFloor).toBe(20_000_000);
    expect([...DDA_BOOK_BUCKETS.balances]).toEqual([50_000, 500_000, 5_000_000]);
    expect([...DDA_BOOK_BUCKETS.shares]).toEqual([0.3, 0.4, 0.3]);
    expect(DDA_BOOK_BUCKETS.shares.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
  });

  it("reproduces the Section 3.1 overnight-fraction readings", () => {
    // A two-million-dollar account books roughly a quarter overnight, a
    // twenty-million-dollar account half, and the ceiling clamps above it.
    expect(ddaOvernightFraction(2_000_000)).toBeCloseTo(0.275, 3);
    expect(ddaOvernightFraction(20_000_000)).toBeCloseTo(0.5, 12);
    expect(ddaOvernightFraction(200_000_000)).toBe(0.5);
    // Implied mean phi over the bucket table is about 0.17.
    expect(DDA_MEAN_PHI).toBeCloseTo(0.17, 2);
  });
});
