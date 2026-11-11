/**
 * Carried hardening in solve.ts, rowDiscount.ts and buildCurve.ts (deferred minors from earlier reviews): non-finite values
 * refuse with a named row, an unknown interpolation refuses in words rather
 * than as a raw Error or a mislabelled bracket failure, the polish-pass test
 * hook is clamped, the exported row helpers are pinned, and an unmapped
 * (dayCount, compounding) pair skips the legacy delegate.
 */
import { describe, expect, it } from "vitest";
import { CurveBuildError, negativeForwardWarnings, solveNodes } from "../solve";
import { rowEquation, rowResidual, rowTargetDf } from "../rowDiscount";
import { buildCurveFromSetup } from "../buildCurve";
import { makeZeroInterpolator } from "../interpolators";
import type { CurveInput, CurveSetupBlock } from "../../contracts/curveSetup";

const block = (over: Partial<CurveSetupBlock> & { inputs: CurveInput[] }): CurveSetupBlock => ({
  id: "h", label: "h", baseCurve: "SOFR", interpolation: "log-linear-df",
  dayCount: "ACT/360", compounding: "annual", ...over,
});

const refusalsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CurveBuildError);
    return (e as CurveBuildError).refusals;
  }
  throw new Error("expected a CurveBuildError");
};

const CASH_3M: CurveInput = { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 };
const SWAP_2Y: CurveInput = { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.041 };

describe("solveNodes hardening", () => {
  it("refuses a non-finite par value with the row named, never a silent zero rate", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const m of ["linear-zero", "log-linear-df", "cubic-zero", "monotone-convex"] as const) {
        const refusals = refusalsOf(() => solveNodes(block({ interpolation: m, inputs: [CASH_3M, { ...SWAP_2Y, value }] })));
        expect(refusals).toEqual(["row 2 value is not a finite number"]);
      }
    }
  });

  it("refuses a non-finite direct value and a non-finite futures convexity with the row named", () => {
    expect(refusalsOf(() => solveNodes(block({ inputs: [{ ...CASH_3M, value: Number.NaN }] }))))
      .toEqual(["row 1 value is not a finite number"]);
    expect(refusalsOf(() => solveNodes(block({ inputs: [
      CASH_3M,
      { instrument: "futures", tenorMonths: 3, quoteType: "par-rate", value: 96, convexityBp: Number.NaN },
    ] })))).toEqual(["row 2 convexityBp is not a finite number"]);
  });

  it("refuses an unknown interpolation in words on a par setup, not as a bracket failure", () => {
    const bad = { ...block({ inputs: [CASH_3M, SWAP_2Y] }), interpolation: "spline" } as unknown as CurveSetupBlock;
    const refusals = refusalsOf(() => solveNodes(bad));
    expect(refusals).toEqual([
      'interpolation must be one of linear-zero, log-linear-df, cubic-zero, monotone-convex; got "spline"',
    ]);
  });

  it("refuses an unknown interpolation in words on an all-direct setup, no raw Error escapes", () => {
    const bad = { ...block({ inputs: [CASH_3M] }), interpolation: "spline" } as unknown as CurveSetupBlock;
    expect(refusalsOf(() => solveNodes(bad))).toEqual([
      'interpolation must be one of linear-zero, log-linear-df, cubic-zero, monotone-convex; got "spline"',
    ]);
    expect(refusalsOf(() => negativeForwardWarnings(bad, [0.25], [0.04]))).toEqual([
      'interpolation must be one of linear-zero, log-linear-df, cubic-zero, monotone-convex; got "spline"',
    ]);
  });

  it("keeps the bracket refusal for a par row no zero rate can price", () => {
    // A 2Y par rate of 500 percent leaves the par residual negative at both bracket ends, -0.2 and 1.0.
    const refusals = refusalsOf(() => solveNodes(block({ inputs: [CASH_3M, { ...SWAP_2Y, value: 5.0 }] })));
    expect(refusals).toEqual([
      "the par-rate ois-swap row at 24 months has no zero rate between -20 and 100 percent that prices it at par",
    ]);
  });

  it("clamps the polish-pass test hook: 0, negative, fractional and NaN never refuse an all-direct setup", () => {
    const direct = block({ interpolation: "cubic-zero", inputs: [
      CASH_3M,
      { instrument: "cash", tenorMonths: 24, quoteType: "zero-rate", value: 0.041 },
    ] });
    for (const maxSweeps of [0, -3, 0.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => solveNodes(direct, { maxSweeps })).not.toThrow();
    }
  });

  it("clamps the polish-pass test hook to a whole number of at least 1 on a neighbour-dependent setup", () => {
    const inputs: CurveInput[] = [
      { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: 0.043 },
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.039 },
      { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0385 },
      { instrument: "ois-swap", tenorMonths: 120, quoteType: "par-rate", value: 0.042 },
    ];
    for (const maxSweeps of [0, -2, 1.9]) {
      expect(refusalsOf(() => solveNodes(block({ interpolation: "cubic-zero", inputs }), { maxSweeps }))).toEqual([
        "the curve did not settle after 1 passes; the quotes may be inconsistent",
      ]);
    }
    // NaN and Infinity read as the hook left out: the production limit.
    for (const maxSweeps of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => solveNodes(block({ interpolation: "cubic-zero", inputs }), { maxSweeps })).not.toThrow();
    }
  });
});

describe("rowTargetDf and rowResidual", () => {
  const conv = { dayCount: "ACT/360", compounding: "annual" } as const;

  it("rowTargetDf gives a direct row's discount factor and null for a row that needs a root find", () => {
    expect(rowTargetDf({ instrument: "cash", tenorMonths: 24, quoteType: "zero-rate", value: 0.05 }, conv))
      .toBe(1.05 ** -2);
    expect(rowTargetDf({ instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: 0.04 }, conv))
      .toBe(1 / (1 + 0.04 * 0.5));
    expect(rowTargetDf({ instrument: "cash", tenorMonths: 6, quoteType: "discount-factor", value: 0.98 }, conv)).toBe(0.98);
    expect(rowTargetDf(SWAP_2Y, conv)).toBeNull();
    expect(rowTargetDf({ instrument: "futures", tenorMonths: 3, quoteType: "par-rate", value: 96 }, conv)).toBeNull();
  });

  it("rowResidual is zero, to 1e-13, for every row of a solved setup with cash, futures and swaps", () => {
    const inputs: CurveInput[] = [
      CASH_3M,
      { instrument: "futures", tenorMonths: 3, quoteType: "par-rate", value: 95.9, convexityBp: 1 },
      { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 96.0 },
      SWAP_2Y,
      { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0395 },
    ];
    for (const m of ["linear-zero", "log-linear-df", "cubic-zero", "monotone-convex"] as const) {
      const b = block({ interpolation: m, inputs });
      const { t, z } = solveNodes(b);
      const zf = makeZeroInterpolator(m, t, z);
      const df = (u: number) => Math.exp(-zf(u) * u);
      for (const row of inputs) expect(Math.abs(rowResidual(row, b, df))).toBeLessThan(1e-13);
    }
  });

  it("rowResidual reads a futures row as DF(end) (1 + F 0.25 fix) less DF(start)", () => {
    const row: CurveInput = { instrument: "futures", tenorMonths: 6, quoteType: "par-rate", value: 96, convexityBp: 2 };
    const df = (u: number) => Math.exp(-0.04 * u);
    const F = 0.04 - 2e-4;
    const expected = df(0.75) * (1 + F * 0.25 * (365 / 360)) - df(0.5);
    expect(rowResidual(row, conv, df)).toBeCloseTo(expected, 15);
  });
});

describe("buildCurveFromSetup hardening", () => {
  it("ACT/365 with annual linear-zero par rows skips the delegate (no kernel convention) and solves the quote nodes", () => {
    const inputs: CurveInput[] = [
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
      { instrument: "cash", tenorMonths: 12, quoteType: "par-rate", value: 0.041 },
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.042 },
      { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.043 },
    ];
    const b = block({ interpolation: "linear-zero", dayCount: "ACT/365", compounding: "annual", inputs });
    const r = buildCurveFromSetup(b);
    const solved = solveNodes(b);
    expect(r.curve.t).toEqual(solved.t);
    expect(r.curve.z).toEqual(solved.z);
    expect(r.curve.convention).toBe("annual_act360");
    // The ACT/365 fixed leg (fraction 1, not 365/360) reprices the 5Y swap: the kernel's ACT/360 leg would not.
    const df = (u: number) => r.curve.discountFactor(u);
    let annuity = 0;
    for (let k = 1; k <= 5; k++) annuity += df(k);
    expect(Math.abs((1 - df(5)) / annuity - 0.043)).toBeLessThan(1e-12);
  });
});

// B1 follow-up: a hand-built block that skips validateCurveSetup. An instrument or quote type off the
// menu used to be solved as a par row; it is now refused in words, with the row named. Sentences restated.
describe("an unknown instrument or quote type is refused when the validator is bypassed", () => {
  const unknownInstrument = { instrument: "swap", tenorMonths: 24, quoteType: "par-rate", value: 0.041 } as unknown as CurveInput;
  const unknownQuote = { instrument: "ois-swap", tenorMonths: 24, quoteType: "yield", value: 0.041 } as unknown as CurveInput;
  const INSTRUMENT_SENTENCE = `row 2 instrument must be one of cash, ois-swap, futures; got "swap"`;
  const QUOTE_SENTENCE = `row 2 quoteType must be one of par-rate, zero-rate, discount-factor; got "yield"`;

  it("solveNodes refuses an unknown instrument and an unknown quote type, naming the row", () => {
    expect(refusalsOf(() => solveNodes(block({ inputs: [CASH_3M, unknownInstrument] })))).toEqual([INSTRUMENT_SENTENCE]);
    expect(refusalsOf(() => solveNodes(block({ inputs: [CASH_3M, unknownQuote] })))).toEqual([QUOTE_SENTENCE]);
    const both = { instrument: "bond", tenorMonths: 24, quoteType: "yield", value: 0.041 } as unknown as CurveInput;
    expect(refusalsOf(() => solveNodes(block({ inputs: [CASH_3M, both] })))).toEqual([
      `row 2 instrument must be one of cash, ois-swap, futures; got "bond"`,
      QUOTE_SENTENCE,
    ]);
  });

  it("buildCurveFromSetup refuses them too, on the legacy-delegate shape as well as the solver path", () => {
    for (const interpolation of ["linear-zero", "log-linear-df"] as const) {
      expect(refusalsOf(() => buildCurveFromSetup(block({ interpolation, inputs: [CASH_3M, unknownInstrument] })))).toEqual([INSTRUMENT_SENTENCE]);
      expect(refusalsOf(() => buildCurveFromSetup(block({ interpolation, inputs: [CASH_3M, unknownQuote] })))).toEqual([QUOTE_SENTENCE]);
    }
  });

  it("a block on the menu still solves", () => {
    expect(solveNodes(block({ inputs: [CASH_3M, SWAP_2Y] })).t).toEqual([0.25, 2]);
  });
});

// Review fix round 1 (M-2): which par rows read the day count, as the limitations page states it.
// The convention objects below name no interpolation, so these cases are the accrual a convention without
// an interpolation keeps (and linear-zero keeps). Since B4 (decision 71) an annual ACT/360 cash row under
// log-linear-df, cubic-zero or monotone-convex accrues 365/360: the decision 71 block below pins that.
describe("day count reaches the fixed leg of these par rows only (a convention with no interpolation)", () => {
  const par = (instrument: "cash" | "ois-swap", tenorMonths: number): CurveInput => ({ instrument, tenorMonths, quoteType: "par-rate", value: 0.04 });
  const accrualOf = (row: CurveInput, compounding: "annual" | "semi-annual", dayCount: "ACT/360" | "ACT/365") => {
    const eq = rowEquation(row, { dayCount, compounding });
    return eq.kind === "par" ? eq.accrual : null;
  };
  it("semi-annual: a 12-month par row is a coupon row whose accrual is 0.5 fix(dc); under 12 months none reads it", () => {
    expect(accrualOf(par("ois-swap", 12), "semi-annual", "ACT/360")).toBeCloseTo(0.5 * (365 / 360), 15);
    expect(accrualOf(par("ois-swap", 12), "semi-annual", "ACT/365")).toBe(0.5);
    expect(accrualOf(par("cash", 12), "semi-annual", "ACT/360")).toBeCloseTo(0.5 * (365 / 360), 15);
    for (const m of [3, 6, 11]) expect(accrualOf(par("ois-swap", m), "semi-annual", "ACT/360")).toBeNull();
  });
  it("annual, no interpolation: a par row of one year or less, and cash at any tenor, never reads it; a longer swap does", () => {
    expect(accrualOf(par("ois-swap", 12), "annual", "ACT/360")).toBeNull();
    expect(accrualOf(par("cash", 24), "annual", "ACT/360")).toBeNull();
    expect(accrualOf(par("ois-swap", 24), "annual", "ACT/360")).toBeCloseTo(365 / 360, 15);
  });
});

// Under ACT/360 with annual compounding, a direct cash par row
// accrues on t 365/360 under log-linear-df, cubic-zero and monotone-convex. Linear-zero, a convention object
// with no interpolation, par rows of one year or less, ACT/365 and semi-annual rows keep their accrual.
// The formulas are restated here, not imported.
describe("decision 71: the annual direct cash row accrues 365/360 under the three new methods only", () => {
  const cash = (tenorMonths: number, value = 0.04): CurveInput => ({ instrument: "cash", tenorMonths, quoteType: "par-rate", value });
  const swap = (tenorMonths: number, value = 0.04): CurveInput => ({ instrument: "ois-swap", tenorMonths, quoteType: "par-rate", value });
  const NEW_METHODS = ["log-linear-df", "cubic-zero", "monotone-convex"] as const;

  it("a new method under ACT/360 annual: cash DF(t) = 1 / (1 + r t 365/360) at every cash tenor", () => {
    for (const interpolation of NEW_METHODS) {
      const conv = { dayCount: "ACT/360", compounding: "annual", interpolation } as const;
      for (const m of [1, 3, 6, 12, 24]) {
        const t = m / 12;
        expect(rowTargetDf(cash(m), conv)).toBeCloseTo(1 / (1 + 0.04 * t * (365 / 360)), 15);
      }
    }
  });

  it("linear-zero and a convention object with no interpolation keep DF(t) = 1 / (1 + r t)", () => {
    const noInterpolation = { dayCount: "ACT/360", compounding: "annual" } as const;
    const linear = { ...noInterpolation, interpolation: "linear-zero" } as const;
    for (const m of [1, 3, 6, 12, 24]) {
      const t = m / 12;
      expect(rowTargetDf(cash(m), noInterpolation)).toBe(1 / (1 + 0.04 * t));
      expect(rowTargetDf(cash(m), linear)).toBe(1 / (1 + 0.04 * t));
    }
  });

  it("a non-cash par row of one year or less keeps 1 / (1 + r t) under every method", () => {
    for (const interpolation of [...NEW_METHODS, "linear-zero"] as const) {
      const conv = { dayCount: "ACT/360", compounding: "annual", interpolation } as const;
      for (const m of [1, 3, 6, 12]) expect(rowTargetDf(swap(m), conv)).toBe(1 / (1 + 0.04 * (m / 12)));
    }
  });

  it("ACT/365 annual cash and semi-annual cash are unchanged under a new method", () => {
    for (const interpolation of NEW_METHODS) {
      expect(rowTargetDf(cash(6), { dayCount: "ACT/365", compounding: "annual", interpolation })).toBe(1 / (1 + 0.04 * 0.5));
      expect(rowTargetDf(cash(3), { dayCount: "ACT/360", compounding: "semi-annual", interpolation })).toBe((1 + 0.02) ** (-0.5));
      expect(rowTargetDf(cash(6), { dayCount: "ACT/360", compounding: "semi-annual", interpolation })).toBe(1 / 1.02);
    }
  });

  it("solveNodes writes the 365/360 cash node under a new method and the old node under linear-zero", () => {
    const inputs = [cash(3, 0.04), swap(24, 0.041)];
    for (const interpolation of NEW_METHODS) {
      const { z } = solveNodes(block({ interpolation, inputs }));
      expect(z[0]).toBeCloseTo(Math.log(1 + 0.04 * 0.25 * (365 / 360)) / 0.25, 15);
    }
    expect(solveNodes(block({ interpolation: "linear-zero", inputs })).z[0]).toBe(-Math.log(1 / (1 + 0.04 * 0.25)) / 0.25);
  });
});
