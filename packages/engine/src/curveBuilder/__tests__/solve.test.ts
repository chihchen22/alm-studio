/**
 * solveNodes: negative rates, failure in words, and every quote repriced off
 * the solved curve. The repricing equations are restated here from the plan's
 * equation table, not imported from rowDiscount.ts or solve.ts.
 */
import { describe, expect, it } from "vitest";
import { CurveBuildError, solveNodes } from "../solve";
import { makeZeroInterpolator } from "../interpolators";
import { validateCurveSetup } from "../validate";
import type { CurveInput, CurveSetupBlock } from "../../contracts/curveSetup";

const methods = ["linear-zero", "log-linear-df", "cubic-zero", "monotone-convex"] as const;

const block = (over: Partial<CurveSetupBlock> & { inputs: CurveInput[] }): CurveSetupBlock => ({
  id: "n", label: "n", baseCurve: "SOFR", interpolation: "log-linear-df",
  dayCount: "ACT/360", compounding: "annual", ...over,
});

/** The refusals a call throws, or a failure when it does not throw a CurveBuildError. */
const refusalsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CurveBuildError);
    return (e as CurveBuildError).refusals;
  }
  throw new Error("expected a CurveBuildError");
};

/** Reprice one row off the solved curve, restating the equation table. */
const reprice = (b: CurveSetupBlock, row: CurveInput, df: (u: number) => number): number => {
  const t = row.tenorMonths / 12;
  const fix = b.dayCount === "ACT/360" ? 365 / 360 : 1;
  const P = df(t);
  if (row.quoteType === "discount-factor") return P;
  if (row.quoteType === "zero-rate") {
    if (b.compounding === "annual") return P ** (-1 / t) - 1;
    if (b.compounding === "semi-annual") return 2 * (P ** (-1 / (2 * t)) - 1);
    return -Math.log(P) / t;
  }
  if (b.compounding === "annual") {
    // Spec v7 decision 71: a cash row accrues on t fix(dc) under the three new methods, on t under linear-zero.
    if (row.instrument === "cash") return (1 / P - 1) / (t * (b.interpolation === "linear-zero" ? 1 : fix));
    if (t <= 1) return (1 / P - 1) / t;
    let a = 0;
    for (let k = 1; k <= t; k++) a += fix * df(k);
    return (1 - P) / a;
  }
  if (t < 0.5) return 2 * (P ** (-1 / (2 * t)) - 1);
  if (t < 1) return 2 * (1 / P - 1);
  let a = 0;
  for (let k = 1; k <= 2 * t; k++) a += 0.5 * fix * df(k / 2);
  return (1 - P) / a;
};

const roundTripError = (b: CurveSetupBlock): number => {
  const { t, z } = solveNodes(b);
  const zf = makeZeroInterpolator(b.interpolation, t, z);
  const df = (u: number) => Math.exp(-zf(u) * u);
  return Math.max(...b.inputs.map((row) => Math.abs(reprice(b, row, df) - row.value)));
};

describe("solveNodes", () => {
  it("solves a negative-rate setup and returns a negative-forward warning", () => {
    const r = solveNodes({ id: "n", label: "n", baseCurve: "SOFR", interpolation: "log-linear-df",
      dayCount: "ACT/360", compounding: "annual",
      inputs: [
        { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: -0.004 },
        { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: -0.002 },
        { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.001 },
      ] });
    expect(r.z[0]).toBeLessThan(0);
    expect(r.warnings.join(" ")).toMatch(/negative forward/);
  });
  it("refuses a discount factor above 1.5 only through the validator, not the solver", () => {
    const above = { id: "n", label: "n", baseCurve: "SOFR", interpolation: "linear-zero",
      dayCount: "ACT/360", compounding: "annual",
      inputs: [{ instrument: "cash", tenorMonths: 12, quoteType: "discount-factor", value: 1.6 }] } as const;
    const r = solveNodes({ ...above, inputs: [...above.inputs] });
    expect(r.z[0]).toBe(-Math.log(1.6));
    const v = validateCurveSetup(above);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.refusals).toEqual(["row 1 value 1.6 is outside (0, 1.5]; a discount-factor row carries the factor itself"]);
  });

  it("solves a negative zero-rate row and reprices it", () => {
    for (const compounding of ["annual", "semi-annual", "continuous"] as const) {
      const b = block({ compounding, inputs: [
        { instrument: "cash", tenorMonths: 12, quoteType: "zero-rate", value: -0.005 },
        { instrument: "cash", tenorMonths: 60, quoteType: "zero-rate", value: -0.002 },
      ] });
      const { z } = solveNodes(b);
      expect(z[0]).toBeLessThan(0);
      expect(z[1]).toBeLessThan(0);
      expect(roundTripError(b)).toBeLessThan(1e-10);
    }
  });

  it("solves a negative par swap row under both par compoundings and reprices it", () => {
    for (const compounding of ["annual", "semi-annual"] as const) {
      for (const m of methods) {
        const b = block({ compounding, interpolation: m, dayCount: "ACT/365", inputs: [
          { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: -0.006 },
          { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: -0.004 },
          { instrument: "ois-swap", tenorMonths: 120, quoteType: "par-rate", value: -0.001 },
        ] });
        const { z } = solveNodes(b);
        z.forEach((zi) => expect(zi).toBeLessThan(0));
        expect(roundTripError(b)).toBeLessThan(1e-10);
      }
    }
  });

  it("reprices every quote of a mixed setup to 1e-10 under every method and convention", () => {
    const inputs: CurveInput[] = [
      { instrument: "cash", tenorMonths: 1, quoteType: "par-rate", value: 0.0431 },
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.0436 },
      { instrument: "cash", tenorMonths: 6, quoteType: "discount-factor", value: 0.9785 },
      { instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.0418 },
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.0392 },
      { instrument: "ois-swap", tenorMonths: 36, quoteType: "par-rate", value: 0.0381 },
      { instrument: "cash", tenorMonths: 48, quoteType: "zero-rate", value: 0.0383 },
      { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0389 },
      { instrument: "ois-swap", tenorMonths: 120, quoteType: "par-rate", value: 0.0412 },
      { instrument: "ois-swap", tenorMonths: 240, quoteType: "par-rate", value: 0.0447 },
      { instrument: "ois-swap", tenorMonths: 360, quoteType: "par-rate", value: 0.0439 },
    ];
    for (const dayCount of ["ACT/360", "ACT/365"] as const) {
      for (const compounding of ["annual", "semi-annual"] as const) {
        for (const m of methods) {
          expect(roundTripError(block({ dayCount, compounding, interpolation: m, inputs }))).toBeLessThan(1e-10);
        }
      }
    }
  });

  it("returns t in years as tenorMonths / 12, quote nodes only", () => {
    const { t, warnings } = solveNodes(block({ inputs: [
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.041 },
    ] }));
    expect(t).toEqual([3 / 12, 2]);
    expect(warnings).toEqual([]);
  });

  it("refuses an empty setup", () => {
    const refusals = refusalsOf(() => solveNodes(block({ inputs: [] })));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/0 rows/);
  });

  it("refuses tenors that are not strictly ascending", () => {
    const repeated = refusalsOf(() => solveNodes(block({ inputs: [
      { instrument: "cash", tenorMonths: 12, quoteType: "par-rate", value: 0.04 },
      { instrument: "cash", tenorMonths: 12, quoteType: "par-rate", value: 0.041 },
    ] })));
    expect(repeated.join(" ")).toMatch(/strictly ascending/);
    const descending = refusalsOf(() => solveNodes(block({ inputs: [
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.04 },
      { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: 0.041 },
    ] })));
    expect(descending.join(" ")).toMatch(/strictly ascending/);
  });

  it("solves a futures row at its node, start plus 3 months (Task 7 replaced the not-supported refusal)", () => {
    const { t } = solveNodes(block({ inputs: [
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
      { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 95.8 },
    ] }));
    expect(t).toEqual([3 / 12, 9 / 12]);
    const refusals = refusalsOf(() => solveNodes(block({ inputs: [
      { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 95.8 },
    ] })));
    expect(refusals).toEqual(["row 1 futures start precedes the first quote"]);
  });

  it("local methods settle in one polish pass; a neighbour-dependent method refuses when held to one", () => {
    const inputs: CurveInput[] = [
      { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: 0.043 },
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.039 },
      { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0385 },
      { instrument: "ois-swap", tenorMonths: 120, quoteType: "par-rate", value: 0.042 },
      { instrument: "ois-swap", tenorMonths: 360, quoteType: "par-rate", value: 0.045 },
    ];
    for (const m of ["linear-zero", "log-linear-df"] as const) {
      expect(() => solveNodes(block({ interpolation: m, inputs }), { maxSweeps: 1 })).not.toThrow();
    }
    for (const m of ["cubic-zero", "monotone-convex"] as const) {
      const refusals = refusalsOf(() => solveNodes(block({ interpolation: m, inputs }), { maxSweeps: 1 }));
      expect(refusals).toEqual(["the curve did not settle after 1 passes; the quotes may be inconsistent"]);
      expect(() => solveNodes(block({ interpolation: m, inputs }))).not.toThrow();
    }
  });

  it("aggregates negative forwards into one warning naming the first month and the count", () => {
    const { warnings } = solveNodes(block({ interpolation: "linear-zero", compounding: "continuous", inputs: [
      { instrument: "cash", tenorMonths: 12, quoteType: "zero-rate", value: 0.03 },
      { instrument: "cash", tenorMonths: 24, quoteType: "zero-rate", value: 0.01 },
    ] }));
    // Continuous forward over month k: (z(t2) t2 - z(t1) t1) / (t2 - t1), linear z from 0.03 at 1Y to 0.01 at 2Y.
    // Months 0..11 are flat at 3 percent. From month 12 the forward is z(t) + t z'(t) with z' = -0.02,
    // negative once 0.05 - 0.04 t < 0, that is t > 1.25: the interval from month 15 to 16 is the first, 9 in all.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^negative forward of -\d+\.\d bp between month 15 and month 16 \(9 intervals\)$/);
  });
});
