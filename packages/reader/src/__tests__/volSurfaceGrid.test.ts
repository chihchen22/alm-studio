/**
 * Vol surface grids for the Data page heatmaps. Every expected
 * basis-point value below is restated from the fixture literal (decimal times
 * 10000), never read back from the helper under test.
 */
import { describe, expect, it } from "vitest";
import { RAMP_STEPS, VOL_TO_BP, capGrid, rampIndex, swaptionGrid, volBpText } from "../volSurfaceGrid";

// Two expiries (given out of order) by three strikes (given out of order),
// plus one ATM quote per expiry. The ATM quote at expiry 5 is the maximum.
const CAP = [
  { expiryYears: 5, strike: 0.01, isAtm: false, normalVol: 0.0090 },
  { expiryYears: 1, strike: 0.03, isAtm: false, normalVol: 0.0071 },
  { expiryYears: 5, strike: null, isAtm: true, normalVol: 0.0120 },
  { expiryYears: 1, strike: 0.01, isAtm: false, normalVol: 0.0064 },
  { expiryYears: 5, strike: -0.005, isAtm: false, normalVol: 0.0101 },
  { expiryYears: 1, strike: -0.005, isAtm: false, normalVol: 0.0058 },
  { expiryYears: 5, strike: 0.03, isAtm: false, normalVol: 0.0085 },
  { expiryYears: 1, strike: null, isAtm: true, normalVol: 0.0066 },
];

describe("capGrid", () => {
  it("sorts rows and cols, scales each cell once, and includes ATM in min/max", () => {
    const g = capGrid(CAP);
    expect(VOL_TO_BP).toBe(10000);
    expect(g.rows).toEqual([1, 5]);
    expect(g.cols).toEqual([-0.005, 0.01, 0.03]);
    expect(g.cells).toEqual([
      [0.0058 * 10000, 0.0064 * 10000, 0.0071 * 10000],
      [0.0101 * 10000, 0.0090 * 10000, 0.0085 * 10000],
    ]);
    expect(g.atm).toEqual([0.0066 * 10000, 0.0120 * 10000]);
    expect(g.min).toBe(0.0058 * 10000);
    expect(g.max).toBe(0.0120 * 10000);
  });

  it("leaves a missing (expiry, strike) cell null and excludes it from min/max", () => {
    const g = capGrid(CAP.filter((q) => !(q.expiryYears === 1 && q.strike === 0.03)));
    expect(g.cells[0]).toEqual([0.0058 * 10000, 0.0064 * 10000, null]);
    expect(g.cols).toEqual([-0.005, 0.01, 0.03]);
    expect(g.min).toBe(0.0058 * 10000);
    expect(g.max).toBe(0.0120 * 10000);
  });

  it("throws naming expiry and strike on a duplicate fixed-strike quote", () => {
    const dup = [...CAP, { expiryYears: 5, strike: 0.01, isAtm: false, normalVol: 0.0091 }];
    expect(() => capGrid(dup)).toThrow("duplicate point on the short-rate volatility surface at expiry 5, strike 0.01");
  });

  it("throws naming the expiry on a duplicate ATM quote", () => {
    const dup = [...CAP, { expiryYears: 1, strike: null, isAtm: true, normalVol: 0.0067 }];
    expect(() => capGrid(dup)).toThrow("duplicate at-the-money point on the short-rate volatility surface at expiry 1");
  });

  it("throws naming the expiry on a null strike without the ATM flag", () => {
    const bad = [...CAP, { expiryYears: 5, strike: null, isAtm: false, normalVol: 0.0099 }];
    expect(() => capGrid(bad)).toThrow("short-rate volatility surface point at expiry 5 has a null strike and no at-the-money flag");
  });

  it("puts an ATM-flagged quote in the ATM column even when it carries a strike", () => {
    const g = capGrid([{ expiryYears: 2, strike: 0.02, isAtm: true, normalVol: 0.0080 }]);
    expect(g.rows).toEqual([2]);
    expect(g.cols).toEqual([]);
    expect(g.cells).toEqual([[]]);
    expect(g.atm).toEqual([0.0080 * 10000]);
  });

  it("returns the empty grid on an empty surface", () => {
    expect(capGrid([])).toEqual({ rows: [], cols: [], cells: [], atm: [], min: 0, max: 0 });
  });
});

const SWAPTION = [
  { expiryYears: 2, tenorYears: 10, normalVol: 0.0110 },
  { expiryYears: 0.25, tenorYears: 1, normalVol: 0.0095 },
  { expiryYears: 2, tenorYears: 1, normalVol: 0.0105 },
  { expiryYears: 0.25, tenorYears: 10, normalVol: 0.0118 },
];

describe("swaptionGrid", () => {
  it("sorts rows and cols, scales each cell once, and has no ATM column", () => {
    const g = swaptionGrid(SWAPTION);
    expect(g.rows).toEqual([0.25, 2]);
    expect(g.cols).toEqual([1, 10]);
    expect(g.cells).toEqual([
      [0.0095 * 10000, 0.0118 * 10000],
      [0.0105 * 10000, 0.0110 * 10000],
    ]);
    expect(g.atm).toBeNull();
    expect(g.min).toBe(0.0095 * 10000);
    expect(g.max).toBe(0.0118 * 10000);
  });

  it("throws naming expiry and tenor on a duplicate", () => {
    const dup = [...SWAPTION, { expiryYears: 2, tenorYears: 1, normalVol: 0.0106 }];
    expect(() => swaptionGrid(dup)).toThrow("duplicate point on the long-yield volatility surface at expiry 2, tenor 1");
  });

  it("returns the empty grid on an empty surface", () => {
    expect(swaptionGrid([])).toEqual({ rows: [], cols: [], cells: [], atm: null, min: 0, max: 0 });
  });
});

describe("rampIndex", () => {
  it("maps min to 0, max to the last step, the midpoint to the middle, and clamps", () => {
    expect(RAMP_STEPS).toBe(13);
    expect(rampIndex(50, 50, 170)).toBe(0);
    expect(rampIndex(170, 50, 170)).toBe(12);
    expect(rampIndex(110, 50, 170)).toBe(6);
    expect(rampIndex(10, 50, 170)).toBe(0);
    expect(rampIndex(999, 50, 170)).toBe(12);
  });

  it("gives every step an equal-width bin, so the top step is reached below the exact max", () => {
    // 13 bins over [0, 130]: bin k covers [10k, 10k + 10).
    expect(rampIndex(9.99, 0, 130)).toBe(0);
    expect(rampIndex(10, 0, 130)).toBe(1);
    expect(rampIndex(119.99, 0, 130)).toBe(11);
    expect(rampIndex(120, 0, 130)).toBe(12);
    expect(rampIndex(129.99, 0, 130)).toBe(12);
  });

  it("returns 0 when min equals max", () => {
    expect(rampIndex(5, 5, 5)).toBe(0);
  });
});

describe("volBpText (Piece 6d)", () => {
  it("prints a stored decimal normal vol as basis points, at most 4 fraction digits", () => {
    expect(volBpText(0.0095175)).toBe("95.175");
    expect(volBpText(0.006345)).toBe("63.45");
    // 0.0061184513 * 10000 = 61.184513, kept to 4 fraction digits
    expect(volBpText(0.0061184513)).toBe("61.1845");
  });
});
