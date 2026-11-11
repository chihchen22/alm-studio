/**
 * Pins every MMA two-sleeve illustrative value to spec v2 Section 3.2 (slider
 * table and the non-slider structure list) and Section 2.2 (the bTail and
 * spread-basis branch choices). A failure here means a value moved; the fix is
 * a new spec version, not an edit to the test.
 */
import { describe, expect, it } from "vitest";
import {
  MMA_AGES0,
  MMA_BASE_SPREAD,
  MMA_B_DECLINE_FLOOR,
  MMA_B_EMP,
  MMA_B_LATE_SLOPE,
  MMA_B_PEAK,
  MMA_B_PEAK_MONTH,
  MMA_B_START,
  MMA_B_WINDOW_MONTHS,
  MMA_CONC_BALANCE_USD,
  MMA_CONC_DEFAULT_QUANTILE,
  MMA_CONC_DEPOSIT_RATE,
  MMA_CONC_HAZARD,
  MMA_CORE_BALANCE_USD,
  MMA_CORE_DEPOSIT_RATE,
  MMA_HZ_AGE1,
  MMA_HZ_AGE36,
  MMA_HZ_LENGTH,
  MMA_HZ_RAMP_END_AGE,
  MMA_ILLUSTRATIVE_DATA,
  MMA_ILLUSTRATIVE_PARAMS,
  MMA_ILLUSTRATIVE_SPEC,
  MMA_LATE,
  MMA_LEVELS,
  MMA_PHIBAR,
  MMA_RUNNER_CALIB,
  MMA_SLEEVE_WEIGHTS,
  MMA_STABLE_SHARE,
  MMA_W0,
  MMA_Z_CONC,
  MMA_Z_CORE,
  mmaBalanceFactor,
  mmaHazardAtAge,
} from "../mmaIllustrative";
import { ILLUSTRATIVE_SNAPSHOT } from "../repricingIllustrative";

describe("MMA two-sleeve illustrative parameters (spec v2, Section 3.2)", () => {
  it("names the spec version of record", () => {
    expect(MMA_ILLUSTRATIVE_SPEC).toBe("illustrative-deposit-parameterization v3 (2026-09-08)");
  });

  it("pins the slider table", () => {
    expect(MMA_ILLUSTRATIVE_PARAMS.betaC).toBe(0.3);
    expect(MMA_ILLUSTRATIVE_PARAMS.betaB).toBe(-0.002);
    expect(MMA_ILLUSTRATIVE_PARAMS.tail).toBe(0.02);
    expect(MMA_ILLUSTRATIVE_PARAMS.bTail).toBe("stabilize");
    expect(MMA_STABLE_SHARE).toBe(0.7);
  });

  it("derives the base spread from the surface, about 1.8 percent", () => {
    expect(MMA_BASE_SPREAD).toBeCloseTo(1.8, 1);
    expect(MMA_ILLUSTRATIVE_PARAMS.baseSp).toBe(MMA_BASE_SPREAD);
    expect(MMA_BASE_SPREAD).toBeCloseTo(
      ILLUSTRATIVE_SNAPSHOT.threeMonthPct - MMA_CORE_DEPOSIT_RATE,
      12,
    );
  });

  it("reads the sleeve deposit rates off the surface equilibria", () => {
    expect(MMA_CORE_BALANCE_USD).toBe(100_000);
    expect(MMA_CONC_BALANCE_USD).toBe(5_000_000);
    expect(MMA_CORE_DEPOSIT_RATE).toBeCloseTo(2.2, 1);
    expect(MMA_CONC_DEPOSIT_RATE).toBeCloseTo(2.6, 1);
    // The core sleeve sits at the surface's own reference account, z = 0.
    expect(MMA_Z_CORE).toBeCloseTo(0, 12);
    expect(MMA_Z_CONC).toBeCloseTo(Math.log(50), 12);
  });

  it("pins the age-hazard ramp", () => {
    expect(MMA_HZ_AGE1).toBe(0.03);
    expect(MMA_HZ_AGE36).toBe(0.02);
    expect(MMA_HZ_RAMP_END_AGE).toBe(36);
    expect(mmaHazardAtAge(1)).toBe(0.03);
    expect(mmaHazardAtAge(36)).toBe(0.02);
    expect(mmaHazardAtAge(240)).toBe(0.02);
    expect(mmaHazardAtAge(18.5)).toBeCloseTo(0.025, 12);
    // The tail override and the seasoned ramp level agree, so no separate
    // tail effect is asserted.
    expect(MMA_ILLUSTRATIVE_PARAMS.tail).toBe(MMA_HZ_AGE36);
    // About 21 percent annual attrition, above DDA's 20.
    expect(1 - (1 - MMA_HZ_AGE36) ** 12).toBeCloseTo(0.215, 3);
  });

  it("pins the hazard vector length and indexing", () => {
    expect(MMA_HZ_LENGTH).toBe(480);
    expect(MMA_ILLUSTRATIVE_DATA.hzFull).toHaveLength(480);
    expect(MMA_ILLUSTRATIVE_DATA.hzFull[0]).toBe(mmaHazardAtAge(1));
    expect(MMA_HZ_LENGTH).toBeGreaterThanOrEqual(180 + 240 + 1);
  });

  it("pins the snapshot age mix, the same six cohorts as DDA", () => {
    expect([...MMA_AGES0]).toEqual([6, 18, 36, 72, 120, 180]);
    expect([...MMA_W0]).toEqual([0.1, 0.15, 0.2, 0.25, 0.2, 0.1]);
    expect(MMA_W0.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
  });

  it("pins the surviving-balance factor", () => {
    expect(MMA_B_START).toBe(1);
    expect(MMA_B_PEAK).toBe(1.1);
    expect(MMA_B_PEAK_MONTH).toBe(18);
    expect(MMA_B_LATE_SLOPE).toBe(-0.002);
    expect(MMA_LATE).toBe(-0.002);
    expect(MMA_B_DECLINE_FLOOR).toBe(0.5);
    expect(MMA_B_WINDOW_MONTHS).toBe(42);
    expect(MMA_B_EMP).toHaveLength(43);
    expect(mmaBalanceFactor(0)).toBe(1);
    expect(mmaBalanceFactor(18)).toBeCloseTo(1.1, 12);
    expect(mmaBalanceFactor(42)).toBeCloseTo(1.052, 12);
    // late is (B(42) - B(30)) / 12 by the same construction.
    expect((mmaBalanceFactor(42) - mmaBalanceFactor(30)) / 12).toBeCloseTo(MMA_LATE, 12);
  });

  it("pins the sleeve weights and the concentration curves", () => {
    expect(MMA_SLEEVE_WEIGHTS.granular).toBe(0.7);
    expect(MMA_SLEEVE_WEIGHTS.concentration).toBe(0.3);
    expect(MMA_CONC_HAZARD.mean).toBe(0.02);
    expect(MMA_CONC_HAZARD.P50).toBe(0.025);
    expect(MMA_CONC_HAZARD.P25).toBe(0.04);
    expect(MMA_CONC_HAZARD.P10).toBe(0.06);
    expect(MMA_CONC_HAZARD.P5).toBe(0.08);
    expect(MMA_CONC_DEFAULT_QUANTILE).toBe("P25");
    // A constant 4 percent monthly hazard gives a WAL near 2.0 years.
    const hz = MMA_CONC_HAZARD.P25;
    let wal = 0;
    for (let h = 1; h <= 240; h++) wal += (1 - hz) ** h;
    expect(wal / 12).toBeCloseTo(2.0, 1);
  });

  it("pins the book weight and the runner calibration", () => {
    expect(MMA_PHIBAR).toBe(0.3);
    expect(MMA_PHIBAR).toBe(MMA_SLEEVE_WEIGHTS.concentration);
    expect(MMA_RUNNER_CALIB.granLnb).toBe(Math.log(100_000));
    expect(MMA_RUNNER_CALIB.granD).toBe(MMA_CORE_DEPOSIT_RATE);
    expect(MMA_RUNNER_CALIB.sofr3m).toBe(4);
    expect(MMA_RUNNER_CALIB.surface.lnBRef).toBe(Math.log(100_000));
  });

  it("pins the snapshot levels the sleeve exhibits run on", () => {
    expect(MMA_LEVELS.sofr1d).toBe(4);
    expect(MMA_LEVELS.sofr3m).toBe(4);
    expect(MMA_LEVELS.gran.d).toBe(MMA_CORE_DEPOSIT_RATE);
    expect(MMA_LEVELS.conc.d).toBe(MMA_CONC_DEPOSIT_RATE);
    expect(MMA_LEVELS.gran.lnb).toBe(Math.log(100_000));
    expect(MMA_LEVELS.conc.lnb).toBe(Math.log(5_000_000));
  });
});
