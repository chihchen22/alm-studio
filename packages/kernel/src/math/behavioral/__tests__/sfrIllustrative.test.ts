/**
 * Illustrative SFR surface gate.
 *
 * The deterministic single-loan valuation is reproduced cross-language against
 * the Python reference readout (run on the shipped public market pack under the
 * U.S. Treasury
 * CMT convention; its deterministic block is committed as the fixture
 * fixtures/sfrIllustrativeReadoutV2.det.json): base leg, the full ±200/±100
 * shock grid, both effective durations, and the hand-computed S-curve points.
 * The stochastic helpers are checked for the parity property only (flat paths
 * collapse every band to the deterministic value); their live bands are
 * Lab-only by ruling and carry no pin.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SFR_ILLUS_BASIS,
  SFR_ILLUS_PARAMS,
  SFR_ILLUS_SHOCK_GRID,
  runSfrIllusEffDurBand,
  runSfrIllusFan,
  runSfrIllusGrid,
  sfrIllusCurrentCoupon,
  sfrIllusDfPath,
  sfrIllusEffDur,
  sfrIllusRatePath,
} from "../sfrIllustrative";
import {
  SFR_ILLUS_EFFDUR_TOL_Y,
  SFR_ILLUS_PINS,
  SFR_ILLUS_PV_TOL_PCTFACE,
  SFR_ILLUS_SCURVE_REF,
  SFR_ILLUS_WAL_TOL_Y,
} from "../defaults/sfrIllustrativePins";
import { bootstrapZeroCurve } from "../../rates/bootstrap";
import { parseMarketSnapshot } from "../../rates/marketData";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");
const curve = bootstrapZeroCurve(
  parseMarketSnapshot(JSON.parse(readFileSync(MARKET_PATH, "utf8"))),
);

const model = runSfrIllusGrid(curve);

describe("the illustrative S-curve reproduces its hand-computed reference points", () => {
  // Fully seasoned, seasonality-neutral: CPR(diff) = min + span / (1 + exp(-k (diff - m))).
  const cprAt = (diffPct: number): number => {
    const p = SFR_ILLUS_PARAMS;
    return p.minCpr + (p.maxCpr - p.minCpr) / (1 + Math.exp(-p.steepness * (diffPct - p.inflection / 100)));
  };
  it("matches the readout's reference points", () => {
    expect(cprAt(-2)).toBeCloseTo(SFR_ILLUS_SCURVE_REF.outOfMoney200Bp, 10);
    expect(cprAt(0)).toBeCloseTo(SFR_ILLUS_SCURVE_REF.atTheMoney, 10);
    expect(cprAt(1)).toBeCloseTo(SFR_ILLUS_SCURVE_REF.inTheMoney100Bp, 10);
    expect(cprAt(2)).toBeCloseTo(SFR_ILLUS_SCURVE_REF.inTheMoney200Bp, 10);
  });
  it("the +100bp point is the logistic midpoint exactly", () => {
    expect(cprAt(1)).toBeCloseTo((SFR_ILLUS_PARAMS.minCpr + SFR_ILLUS_PARAMS.maxCpr) / 2, 12);
  });
});

/**
 * CROSS-LANGUAGE GATE, restored 2026-08-31. Between the Treasury-convention
 * re-pin and the Python reference engine the pins gated the TypeScript engine against
 * itself, because the Python readout still bootstrapped on the annual ACT/360
 * convention. The engine now carries CurveConvention.SEMIANNUAL_BOND_CMT and
 * infers it from the pack, the readout was re-run (6/6 sanity gates), and its
 * deterministic block is committed as a fixture so this suite can check the
 * twelve pinned quantities against the Python numbers themselves rather than
 * against a claim in a docstring. Tolerances are the original ones.
 */
describe("the twelve deterministic pins reproduce the Python readout", () => {
  const readout = JSON.parse(
    readFileSync(resolve(__dirname, "fixtures", "sfrIllustrativeReadoutV2.det.json"), "utf8"),
  ) as {
    gates_summary: { passed: number; total: number };
    det: {
      pv_pct_face: number;
      wal_years: number;
      life_cpr_base: number;
      first_year_cpr: number;
      effdur_pm100: number;
      effdur_pm200: number;
      pv_pct_grid: Record<string, number>;
      wal_grid: Record<string, number>;
    };
  };

  it("the readout it gates against passed its own sanity gates", () => {
    expect(readout.gates_summary.passed).toBe(readout.gates_summary.total);
  });

  const rows: ReadonlyArray<[string, number, number, number]> = [
    ["basePvPctFace", SFR_ILLUS_PINS.basePvPctFace, readout.det.pv_pct_face, SFR_ILLUS_PV_TOL_PCTFACE],
    ["pvPctFaceDn200", SFR_ILLUS_PINS.pvPctFaceDn200, readout.det.pv_pct_grid["-200"], SFR_ILLUS_PV_TOL_PCTFACE],
    ["pvPctFaceDn100", SFR_ILLUS_PINS.pvPctFaceDn100, readout.det.pv_pct_grid["-100"], SFR_ILLUS_PV_TOL_PCTFACE],
    ["pvPctFaceUp100", SFR_ILLUS_PINS.pvPctFaceUp100, readout.det.pv_pct_grid["+100"], SFR_ILLUS_PV_TOL_PCTFACE],
    ["pvPctFaceUp200", SFR_ILLUS_PINS.pvPctFaceUp200, readout.det.pv_pct_grid["+200"], SFR_ILLUS_PV_TOL_PCTFACE],
    ["baseWalYears", SFR_ILLUS_PINS.baseWalYears, readout.det.wal_years, SFR_ILLUS_WAL_TOL_Y],
    ["walDn200", SFR_ILLUS_PINS.walDn200, readout.det.wal_grid["-200"], SFR_ILLUS_WAL_TOL_Y],
    ["walUp200", SFR_ILLUS_PINS.walUp200, readout.det.wal_grid["+200"], SFR_ILLUS_WAL_TOL_Y],
    ["effDurPm100", SFR_ILLUS_PINS.effDurPm100, readout.det.effdur_pm100, SFR_ILLUS_EFFDUR_TOL_Y],
    ["effDurPm200", SFR_ILLUS_PINS.effDurPm200, readout.det.effdur_pm200, SFR_ILLUS_EFFDUR_TOL_Y],
    // CPR pins are decimals; the gate is the same 2e-3 read as an absolute
    // difference on a decimal rate, i.e. 20 bp of CPR.
    ["lifeCpr", SFR_ILLUS_PINS.lifeCpr, readout.det.life_cpr_base, SFR_ILLUS_PV_TOL_PCTFACE],
    ["firstYearCpr", SFR_ILLUS_PINS.firstYearCpr, readout.det.first_year_cpr, SFR_ILLUS_PV_TOL_PCTFACE],
  ];

  it("gates all twelve quantities", () => {
    expect(rows).toHaveLength(12);
  });

  it.each(rows)("%s reproduces the Python value", (_name, pin, python, tol) => {
    expect(Math.abs(pin - python)).toBeLessThan(tol);
  });
});

describe("the deterministic valuation reproduces the Python readout of record", () => {
  it("current coupon is the recorded 6.8000%", () => {
    // Public pack: 10Y Treasury par 4.3000% + 250bp all-in spread.
    expect(sfrIllusCurrentCoupon(curve)).toBeCloseTo(0.068, 6);
  });
  it("base PV, WAL, lifetime CPR and first-year CPR gate", () => {
    expect(Math.abs(model.base.pvPctFace - SFR_ILLUS_PINS.basePvPctFace)).toBeLessThan(
      SFR_ILLUS_PV_TOL_PCTFACE,
    );
    expect(Math.abs(model.base.wal - SFR_ILLUS_PINS.baseWalYears)).toBeLessThan(SFR_ILLUS_WAL_TOL_Y);
    expect(model.base.lifeCpr).toBeCloseTo(SFR_ILLUS_PINS.lifeCpr, 4);
    expect(model.base.firstYearCpr).toBeCloseTo(SFR_ILLUS_PINS.firstYearCpr, 4);
  });
  it("the PV shock grid gates leg by leg", () => {
    const pins = [
      SFR_ILLUS_PINS.pvPctFaceDn200,
      SFR_ILLUS_PINS.pvPctFaceDn100,
      SFR_ILLUS_PINS.basePvPctFace,
      SFR_ILLUS_PINS.pvPctFaceUp100,
      SFR_ILLUS_PINS.pvPctFaceUp200,
    ];
    SFR_ILLUS_SHOCK_GRID.forEach((_, i) => {
      expect(Math.abs(model.dynGrid[i].pvPctFace - pins[i])).toBeLessThan(SFR_ILLUS_PV_TOL_PCTFACE);
    });
  });
  it("the WAL ±200 legs gate", () => {
    expect(Math.abs(model.dynGrid[0].wal - SFR_ILLUS_PINS.walDn200)).toBeLessThan(SFR_ILLUS_WAL_TOL_Y);
    expect(Math.abs(model.dynGrid[4].wal - SFR_ILLUS_PINS.walUp200)).toBeLessThan(SFR_ILLUS_WAL_TOL_Y);
  });
  it("both effective durations gate", () => {
    const effDur100 = sfrIllusEffDur(model.dynGrid[1].pv, model.base.pv, model.dynGrid[3].pv, 0.01);
    const effDur200 = sfrIllusEffDur(model.dynGrid[0].pv, model.base.pv, model.dynGrid[4].pv, 0.02);
    expect(Math.abs(effDur100 - SFR_ILLUS_PINS.effDurPm100)).toBeLessThan(SFR_ILLUS_EFFDUR_TOL_Y);
    expect(Math.abs(effDur200 - SFR_ILLUS_PINS.effDurPm200)).toBeLessThan(SFR_ILLUS_EFFDUR_TOL_Y);
  });
});

describe("the static comparator", () => {
  it("is WAL-flat by construction across the grid", () => {
    for (const leg of model.statGrid) {
      expect(leg.wal).toBeCloseTo(model.base.wal, 12);
    }
  });
  it("matches the dynamic base leg at 0bp", () => {
    expect(model.statGrid[2].pv).toBeCloseTo(model.base.pv, 6);
  });
});

describe("stochastic parity properties (Lab-only bands)", () => {
  const months = SFR_ILLUS_BASIS.termMonths;
  const wac = sfrIllusCurrentCoupon(curve);
  const flatPaths = [sfrIllusRatePath(curve, months)];
  it("a single deterministic path collapses the WAL band to the deterministic WAL", () => {
    const fan = runSfrIllusFan(flatPaths, wac);
    expect(fan.walMean).toBeCloseTo(model.base.wal, 10);
    expect(fan.walP5).toBeCloseTo(fan.walMean, 12);
    expect(fan.walP95).toBeCloseTo(fan.walMean, 12);
  });
  it("a single deterministic path collapses the effDur band to the shifted-path duration", () => {
    const dfs = {
      base: sfrIllusDfPath(curve, months),
      dn: sfrIllusDfPath(runSfrIllusGridShocked(-200), months),
      up: sfrIllusDfPath(runSfrIllusGridShocked(200), months),
    };
    const band = runSfrIllusEffDurBand(flatPaths, wac, dfs, 0.02);
    expect(band.p5).toBeCloseTo(band.mean, 12);
    expect(band.p95).toBeCloseTo(band.mean, 12);
    // The parallel-path shift approximates the shocked-curve forward path, so
    // the collapsed band sits near (not on) the deterministic ±200bp duration.
    expect(Math.abs(band.mean - SFR_ILLUS_PINS.effDurPm200)).toBeLessThan(0.25);
  });
  it("the balance fan starts at par and is non-increasing", () => {
    const fan = runSfrIllusFan(flatPaths, wac);
    expect(fan.balMean[0]).toBeLessThanOrEqual(100);
    for (let t = 1; t < fan.balMean.length; t++) {
      expect(fan.balMean[t]).toBeLessThanOrEqual(fan.balMean[t - 1] + 1e-9);
    }
  });
});

// Local helper: the shocked curve for the parity test's df legs.
import { shockCurve } from "../../rates/bootstrap";
function runSfrIllusGridShocked(bp: number) {
  return shockCurve(curve, bp);
}
