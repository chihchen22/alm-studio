/**
 * validateCurveSetup. Refusal sentences
 * are matched as literals here because Studio shows them to the user verbatim.
 */
import { describe, expect, it } from "vitest";
import { MAX_CURVE_INPUTS, MAX_TENOR_MONTHS, validateCurveSetup } from "../validate";

const base = {
  id: "cs-1", label: "t", baseCurve: "SOFR",
  interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual",
  inputs: [
    { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
    { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.038 },
  ],
};

const refusalsOf = (v: unknown): string[] => {
  const r = validateCurveSetup(v);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.refusals;
};

describe("validateCurveSetup", () => {
  it("accepts a clean setup and sorts rows by tenor", () => {
    const r = validateCurveSetup({ ...base, inputs: [...base.inputs].reverse() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.block.inputs.map((i) => i.tenorMonths)).toEqual([3, 24]);
  });
  it("refuses a duplicate tenor and names the row", () => {
    const r = validateCurveSetup({ ...base, inputs: [base.inputs[0], base.inputs[0]] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals[0]).toMatch(/row 2 repeats tenor 3 months/);
  });
  it("refuses a par-rate row with continuous compounding", () => {
    const r = validateCurveSetup({ ...base, compounding: "continuous" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(" ")).toMatch(/row 1 is a par rate; continuous compounding has no coupon schedule/);
  });
  it("accepts continuous compounding when every row is a zero rate", () => {
    const inputs = base.inputs.map((i) => ({ ...i, quoteType: "zero-rate" }));
    expect(validateCurveSetup({ ...base, compounding: "continuous", inputs }).ok).toBe(true);
  });
  it("refuses a 15-month semi-annual par row and an 18-month annual par row", () => {
    const semi = validateCurveSetup({ ...base, compounding: "semi-annual",
      inputs: [{ instrument: "ois-swap", tenorMonths: 15, quoteType: "par-rate", value: 0.04 }] });
    expect(semi.ok).toBe(false);
    const ann = validateCurveSetup({ ...base,
      inputs: [{ instrument: "ois-swap", tenorMonths: 18, quoteType: "par-rate", value: 0.04 }] });
    expect(ann.ok).toBe(false);
  });
  it("refuses a non-integer or out-of-range tenor and unknown keys", () => {
    expect(validateCurveSetup({ ...base, inputs: [{ ...base.inputs[0], tenorMonths: 0.5 }] }).ok).toBe(false);
    expect(validateCurveSetup({ ...base, inputs: [{ ...base.inputs[0], tenorMonths: 361 }] }).ok).toBe(false);
    expect(validateCurveSetup({ ...base, surprise: 1 }).ok).toBe(false);
  });

  it("exports the limits", () => {
    expect(MAX_CURVE_INPUTS).toBe(60);
    expect(MAX_TENOR_MONTHS).toBe(360);
  });

  it("words the compounding-multiple refusals exactly, and allows exactly 12 months", () => {
    const semi = refusalsOf({ ...base, compounding: "semi-annual",
      inputs: [{ instrument: "ois-swap", tenorMonths: 15, quoteType: "par-rate", value: 0.04 }] });
    expect(semi).toEqual([
      "row 1 tenor 15 months is not a multiple of 6 months; a semi-annual par row above 12 months needs one",
    ]);
    const ann = refusalsOf({ ...base,
      inputs: [{ instrument: "ois-swap", tenorMonths: 18, quoteType: "par-rate", value: 0.04 }] });
    expect(ann).toEqual([
      "row 1 tenor 18 months is not a whole number of years; an annual par row above 12 months needs one",
    ]);
    const twelve = [{ instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.04 }];
    expect(validateCurveSetup({ ...base, inputs: twelve }).ok).toBe(true);
    expect(validateCurveSetup({ ...base, compounding: "semi-annual", inputs: twelve }).ok).toBe(true);
    const short = [{ instrument: "cash", tenorMonths: 7, quoteType: "par-rate", value: 0.04 }];
    expect(validateCurveSetup({ ...base, inputs: short }).ok).toBe(true);
    expect(validateCurveSetup({ ...base, compounding: "semi-annual", inputs: short }).ok).toBe(true);
    const r = validateCurveSetup({ ...base, compounding: "semi-annual",
      inputs: [{ instrument: "ois-swap", tenorMonths: 18, quoteType: "par-rate", value: 0.04 }] });
    expect(r.ok).toBe(true);
  });

  it("words the continuous refusal in full", () => {
    expect(refusalsOf({ ...base, compounding: "continuous" })).toEqual([
      "row 1 is a par rate; continuous compounding has no coupon schedule. Use annual or semi-annual.",
      "row 2 is a par rate; continuous compounding has no coupon schedule. Use annual or semi-annual.",
    ]);
  });

  it("lets a discount-factor row and a zero-rate row ignore the par compounding rules", () => {
    const inputs = [
      { instrument: "ois-swap", tenorMonths: 15, quoteType: "discount-factor", value: 0.95 },
      { instrument: "ois-swap", tenorMonths: 21, quoteType: "zero-rate", value: 0.04 },
    ];
    expect(validateCurveSetup({ ...base, inputs }).ok).toBe(true);
    expect(validateCurveSetup({ ...base, compounding: "semi-annual", inputs }).ok).toBe(true);
    expect(validateCurveSetup({ ...base, compounding: "continuous", inputs }).ok).toBe(true);
  });

  it("words the tenor and value refusals exactly", () => {
    const r = refusalsOf({ ...base, inputs: [
      { instrument: "cash", tenorMonths: 0.5, quoteType: "par-rate", value: 0.04 },
      { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: Number.NaN },
      { instrument: "cash", tenorMonths: "12", quoteType: "par-rate", value: "0.04" },
    ] });
    expect(r).toEqual([
      "row 1 tenor must be a whole number of months from 1 to 360",
      "row 2 value is not a finite number",
      "row 3 tenor must be a whole number of months from 1 to 360",
      "row 3 value is not a finite number",
    ]);
    expect(refusalsOf({ ...base, inputs: [{ ...base.inputs[0], tenorMonths: 0 }] })).toEqual([
      "row 1 tenor must be a whole number of months from 1 to 360",
    ]);
    expect(validateCurveSetup({ ...base, inputs: [{ ...base.inputs[0], tenorMonths: 360 }] }).ok).toBe(true);
    expect(refusalsOf({ ...base, inputs: [{ ...base.inputs[0], value: Number.POSITIVE_INFINITY }] })).toEqual([
      "row 1 value is not a finite number",
    ]);
  });

  it("bounds a par or zero rate at magnitude 1.0", () => {
    expect(validateCurveSetup({ ...base, inputs: [{ ...base.inputs[0], value: 1.0 }] }).ok).toBe(true);
    expect(validateCurveSetup({ ...base, inputs: [{ ...base.inputs[0], value: -0.005 }] }).ok).toBe(true);
    const r = refusalsOf({ ...base, inputs: [{ ...base.inputs[0], value: 4 }] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/^row 1 value/);
    const z = refusalsOf({ ...base, inputs: [{ ...base.inputs[0], quoteType: "zero-rate", value: -1.5 }] });
    expect(z).toHaveLength(1);
    expect(z[0]).toMatch(/^row 1 value/);
  });

  it("bounds a discount factor in (0, 1.5]", () => {
    const df = (value: number) => ({ ...base, inputs: [
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "discount-factor", value },
    ] });
    expect(validateCurveSetup(df(1.5)).ok).toBe(true);
    expect(validateCurveSetup(df(0.001)).ok).toBe(true);
    for (const bad of [0, -0.2, 1.5000001]) {
      const r = refusalsOf(df(bad));
      expect(r).toHaveLength(1);
      expect(r[0]).toMatch(/^row 1 value/);
    }
  });

  it("checks a futures row: price in (50, 150), quoteType par-rate, convexity within 100 bp", () => {
    const fut = (row: Record<string, unknown>) => ({ ...base, inputs: [
      base.inputs[0],
      { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 95.8, ...row },
    ] });
    const ok = validateCurveSetup(fut({ convexityBp: 1.5 }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.block.inputs[1]).toEqual(
      { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 95.8, convexityBp: 1.5 });
    expect(validateCurveSetup(fut({ convexityBp: -100 })).ok).toBe(true);
    expect(validateCurveSetup(fut({ convexityBp: 100 })).ok).toBe(true);
    for (const value of [50, 150, 0.042]) {
      const r = refusalsOf(fut({ value }));
      expect(r).toHaveLength(1);
      expect(r[0]).toMatch(/^row 2 value/);
    }
    const qt = refusalsOf(fut({ quoteType: "zero-rate" }));
    expect(qt).toHaveLength(1);
    expect(qt[0]).toMatch(/^row 2 quoteType/);
    for (const convexityBp of [100.5, -101, Number.NaN, "2"]) {
      const r = refusalsOf(fut({ convexityBp }));
      expect(r).toHaveLength(1);
      expect(r[0]).toMatch(/^row 2 convexityBp/);
    }
  });

  it("refuses convexityBp on a row that is not a futures row", () => {
    const r = refusalsOf({ ...base, inputs: [{ ...base.inputs[0], convexityBp: 1 }] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/^row 1 convexityBp/);
  });

  it("does not apply the par compounding rules to a futures row", () => {
    const inputs = [
      { instrument: "futures", tenorMonths: 15, quoteType: "par-rate", value: 96 },
      { instrument: "cash", tenorMonths: 3, quoteType: "zero-rate", value: 0.04 },
    ];
    expect(validateCurveSetup({ ...base, inputs }).ok).toBe(true);
    expect(validateCurveSetup({ ...base, compounding: "semi-annual", inputs }).ok).toBe(true);
    expect(validateCurveSetup({ ...base, compounding: "continuous", inputs }).ok).toBe(true);
  });

  it("refuses an unknown menu value with the allowed list", () => {
    expect(refusalsOf({ ...base, interpolation: "spline" })).toEqual([
      'interpolation must be one of linear-zero, log-linear-df, cubic-zero, monotone-convex; got "spline"',
    ]);
    expect(refusalsOf({ ...base, dayCount: "30/360" })).toEqual([
      'dayCount must be one of ACT/360, ACT/365; got "30/360"',
    ]);
    expect(refusalsOf({ ...base, compounding: "quarterly" })).toEqual([
      'compounding must be one of annual, semi-annual, continuous; got "quarterly"',
    ]);
    expect(refusalsOf({ ...base, inputs: [{ ...base.inputs[0], quoteType: "yield" }] })).toEqual([
      'row 1 quoteType must be one of par-rate, zero-rate, discount-factor; got "yield"',
    ]);
    expect(refusalsOf({ ...base, inputs: [{ ...base.inputs[0], instrument: "bond" }] })).toEqual([
      'row 1 instrument must be one of cash, ois-swap, futures; got "bond"',
    ]);
  });

  it("refuses unknown keys on the block and on a row by name", () => {
    const b = refusalsOf({ ...base, surprise: 1 });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatch(/unknown field "surprise"/);
    const r = refusalsOf({ ...base, inputs: [{ ...base.inputs[0], note: "x" }] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/^row 1 unknown field "note"/);
  });

  it("refuses an empty input list and more than 60 rows", () => {
    const empty = refusalsOf({ ...base, inputs: [] });
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatch(/setup holds 0 rows/);
    const many = Array.from({ length: 61 }, (_, i) =>
      ({ instrument: "cash", tenorMonths: i + 1, quoteType: "zero-rate", value: 0.04 }));
    expect(refusalsOf({ ...base, inputs: many })).toEqual(["setup holds 61 rows; the limit is 60"]);
    expect(validateCurveSetup({ ...base, inputs: many.slice(0, 60) }).ok).toBe(true);
  });

  it("refuses a missing or malformed block and missing header fields", () => {
    expect(refusalsOf(null)).toHaveLength(1);
    expect(refusalsOf([base])).toHaveLength(1);
    const r = refusalsOf({ ...base, id: "", label: 3, baseCurve: undefined, inputs: "x" });
    expect(r).toHaveLength(4);
    expect(r[0]).toMatch(/^id /);
    expect(r[1]).toMatch(/^label /);
    expect(r[2]).toMatch(/^baseCurve /);
    expect(r[3]).toMatch(/^inputs /);
    const notRow = refusalsOf({ ...base, inputs: [base.inputs[0], 7] });
    expect(notRow).toHaveLength(1);
    expect(notRow[0]).toMatch(/^row 2 /);
  });

  it("refuses a block that is a string, NaN or Infinity", () => {
    for (const bad of ["cs-1", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateCurveSetup(bad)).not.toThrow();
      const r = refusalsOf(bad);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatch(/^curve setup must be an object/);
    }
  });

  it("never throws on an object whose toString is not callable", () => {
    const hostile = (): unknown => JSON.parse('{"toString":1}');
    expect(() => validateCurveSetup({ ...base, interpolation: hostile() })).not.toThrow();
    expect(refusalsOf({ ...base, interpolation: hostile() })).toEqual([
      "interpolation must be one of linear-zero, log-linear-df, cubic-zero, monotone-convex; got an object",
    ]);
    const fut = { ...base, inputs: [
      base.inputs[0],
      { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 95.8, convexityBp: hostile() },
    ] };
    expect(() => validateCurveSetup(fut)).not.toThrow();
    const r = refusalsOf(fut);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/^row 2 convexityBp .*; got an object$/);
    const lists = refusalsOf({ ...base, dayCount: [hostile()] });
    expect(lists).toEqual(["dayCount must be one of ACT/360, ACT/365; got a list"]);
  });

  it("never throws on a null-prototype object", () => {
    const bare = (): unknown => Object.create(null);
    expect(() => validateCurveSetup({ ...base, compounding: bare() })).not.toThrow();
    expect(refusalsOf({ ...base, compounding: bare() })).toEqual([
      "compounding must be one of annual, semi-annual, continuous; got an object",
    ]);
    expect(refusalsOf({ ...base, inputs: [{ ...base.inputs[0], value: bare() }] })).toEqual([
      "row 1 value is not a finite number",
    ]);
    expect(refusalsOf({ ...base, inputs: [{ ...base.inputs[0], quoteType: bare() }] })).toEqual([
      "row 1 quoteType must be one of par-rate, zero-rate, discount-factor; got an object",
    ]);
    const fut = { ...base, inputs: [
      { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 95.8, convexityBp: bare() },
    ] };
    expect(() => validateCurveSetup(fut)).not.toThrow();
    expect(refusalsOf(fut)[0]).toMatch(/^row 1 convexityBp .*; got an object$/);
    expect(() => validateCurveSetup(bare())).not.toThrow();
    expect(refusalsOf(bare()).length).toBeGreaterThan(0);
  });

  it("collects every refusal rather than stopping at the first", () => {
    const r = refusalsOf({ ...base, interpolation: "spline", compounding: "continuous", inputs: [
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
      { instrument: "cash", tenorMonths: 3, quoteType: "zero-rate", value: 0.04 },
      { instrument: "cash", tenorMonths: 400, quoteType: "zero-rate", value: 0.04 },
    ] });
    expect(r).toEqual([
      'interpolation must be one of linear-zero, log-linear-df, cubic-zero, monotone-convex; got "spline"',
      "row 1 is a par rate; continuous compounding has no coupon schedule. Use annual or semi-annual.",
      "row 2 repeats tenor 3 months",
      "row 3 tenor must be a whole number of months from 1 to 360",
    ]);
  });

  it("returns a fresh block in canonical shape, leaving convexityBp out when absent", () => {
    const input = { ...base, inputs: [base.inputs[1], base.inputs[0]] };
    const r = validateCurveSetup(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block).toEqual({ ...base, inputs: [base.inputs[0], base.inputs[1]] });
    expect(r.block).not.toBe(input);
    expect(Object.keys(r.block.inputs[0])).toEqual(["instrument", "tenorMonths", "quoteType", "value"]);
    expect(input.inputs[0].tenorMonths).toBe(24);
  });
});
