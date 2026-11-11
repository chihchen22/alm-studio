/**
 * Futures rows.
 *
 * A futures row's tenorMonths is the START s of a 3-month period, its value
 * the price P. The forward it fixes is F = (100 - P)/100 - convexityBp/1e4,
 * simple over the period with fixed-leg fraction fix(ACT/360) = 365/360 and
 * fix(ACT/365) = 1:
 *
 *   DF(s + 0.25) = DF(s) / (1 + F 0.25 fix)
 *
 * so the row's node sits at s + 3 months. The repricing below restates that
 * formula from DF reads on the built kernel curve at whole months; nothing is
 * imported from rowDiscount.ts or solve.ts for it.
 */
import { describe, expect, it } from "vitest";
import type { ZeroCurve } from "@alm/kernel";
import { CurveBuildError, solveNodes } from "../solve";
import { buildCurveFromSetup } from "../buildCurve";
import { validateCurveSetup } from "../validate";
import type { CurveDayCount, CurveInput, CurveInterpolation, CurveSetupBlock } from "../../contracts/curveSetup";

const METHODS: CurveInterpolation[] = ["linear-zero", "log-linear-df", "cubic-zero", "monotone-convex"];

const setup = (over: Partial<CurveSetupBlock> & { inputs: CurveInput[] }): CurveSetupBlock => ({
  id: "f", label: "f", baseCurve: "SOFR", interpolation: "log-linear-df",
  dayCount: "ACT/360", compounding: "annual", ...over,
});

const fut = (start: number, price: number, convexityBp?: number): CurveInput => ({
  instrument: "futures", tenorMonths: start, quoteType: "par-rate", value: price,
  ...(convexityBp !== undefined ? { convexityBp } : {}),
});

/** The classic strip: cash 3M, then futures starting at 3, 6 and 9 months, then two swaps. */
const STRIP: CurveInput[] = [
  { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.0431 },
  fut(3, 95.80, 0.5),
  fut(6, 95.95, 1.0),
  fut(9, 96.10, 1.5),
  { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.0392 },
  { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0389 },
];

/** A strip whose futures starts fall strictly between nodes, so DF(s) leans on the row's own node. */
const GAPPED: CurveInput[] = [
  { instrument: "cash", tenorMonths: 1, quoteType: "par-rate", value: 0.0433 },
  fut(2, 95.70),
  fut(5, 95.90, 2),
  { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.0395 },
];

/** The forward a futures row reads off a built curve, restated from DF reads at whole months. */
const impliedForward = (curve: ZeroCurve, startMonths: number, dc: CurveDayCount): number => {
  const fix = dc === "ACT/360" ? 365 / 360 : 1;
  const p1 = curve.discountFactor(startMonths / 12);
  const p2 = curve.discountFactor((startMonths + 3) / 12);
  return (p1 / p2 - 1) / (0.25 * fix);
};
const typedForward = (row: CurveInput): number => (100 - row.value) / 100 - (row.convexityBp ?? 0) / 1e4;

const refusalsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CurveBuildError);
    return (e as CurveBuildError).refusals;
  }
  throw new Error("expected a CurveBuildError");
};

describe("futures rows", () => {
  it("a futures price of 96 with 2 bp convexity gives a 3-month forward of 3.98 percent", () => {
    const r = solveNodes({ id: "f", label: "f", baseCurve: "SOFR", interpolation: "linear-zero",
      dayCount: "ACT/360", compounding: "annual",
      inputs: [
        { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
        { instrument: "futures", tenorMonths: 3, quoteType: "par-rate", value: 96, convexityBp: 2 },
      ] });
    const df = (t: number, i: number) => Math.exp(-r.z[i] * t);
    const impliedF = (df(0.25, 0) / df(0.5, 1) - 1) / (0.25 * (365 / 360));
    expect(impliedF).toBeCloseTo(0.0398, 8);
  });
  it("refuses a futures row whose start precedes the first quote", () => {
    expect(() => solveNodes({ id: "f", label: "f", baseCurve: "SOFR", interpolation: "linear-zero",
      dayCount: "ACT/360", compounding: "annual",
      inputs: [{ instrument: "futures", tenorMonths: 1, quoteType: "par-rate", value: 96 }] }))
      .toThrow(/futures start precedes the first quote/);
  });

  it("places each futures node at its start plus 3 months", () => {
    const { t } = solveNodes(setup({ inputs: STRIP }));
    expect(t).toEqual([3, 6, 9, 12, 24, 60].map((m) => m / 12));
  });

  for (const method of METHODS) {
    for (const dayCount of ["ACT/360", "ACT/365"] as const) {
      it(`${method} ${dayCount}: the built curve reprices every futures row of the strip to 1e-12`, () => {
        for (const inputs of [STRIP, GAPPED]) {
          const { curve } = buildCurveFromSetup(setup({ interpolation: method, dayCount, inputs }));
          for (const row of inputs.filter((r) => r.instrument === "futures")) {
            expect(Math.abs(impliedForward(curve, row.tenorMonths, dayCount) - typedForward(row))).toBeLessThan(1e-12);
          }
          // The cash row still reprices on its own simple-rate equation; under ACT/360 a new method accrues it
          // on t 365/360 and linear-zero on t.
          const cash = inputs[0];
          const m = cash.tenorMonths;
          const cashFix = method !== "linear-zero" && dayCount === "ACT/360" ? 365 / 360 : 1;
          const cashRate = (1 / curve.discountFactor(m / 12) - 1) / ((m / 12) * cashFix);
          expect(Math.abs(cashRate - cash.value)).toBeLessThan(1e-12);
        }
      });
    }
  }

  it("convexity shifts the implied forward by exactly the typed basis points", () => {
    for (const method of METHODS) {
      const without = STRIP.map((r) => (r.instrument === "futures" ? fut(r.tenorMonths, r.value) : r));
      const withBp = STRIP.map((r) => (r.instrument === "futures" ? fut(r.tenorMonths, r.value, 7.5) : r));
      const a = buildCurveFromSetup(setup({ interpolation: method, inputs: without })).curve;
      const b = buildCurveFromSetup(setup({ interpolation: method, inputs: withBp })).curve;
      for (const start of [3, 6, 9]) {
        const shift = impliedForward(a, start, "ACT/360") - impliedForward(b, start, "ACT/360");
        expect(Math.abs(shift - 7.5e-4)).toBeLessThan(1e-12);
      }
    }
  });

  it("refuses a futures price that gives a non-positive discount factor", () => {
    // 600 is far outside the validator's (50, 150), so only the solver sees it: F = -5, 1 + F 0.25 fix < 0.
    const refusals = refusalsOf(() => solveNodes(setup({ inputs: [
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
      fut(3, 600),
    ] })));
    expect(refusals).toEqual(["row 2 futures price gives a non-positive discount factor"]);
  });

  it("refuses a futures price whose node zero rate falls below the -20 percent bracket, in words", () => {
    // B1 follow-up. Both prices sit inside the validator's (50, 150), and both keep 1 + F 0.25 fix > 0.
    // Hand check, ACT/360, cash 3M at 4 percent: DF(0.25) = 1/1.01 under linear-zero, and
    // 1/(1 + 0.04 * 0.25 * 365/360) = 1/1.0101389 under a new method.
    //   P = 140:   F = -0.40,  DF(0.5) = DF(0.25) / (1 - 0.40 * 0.25 * 365/360)  = 1.10181 (new method 1.10166),
    //              z = -19.39 percent (new method -19.36): solves.
    //   P = 149.9: F = -0.499, DF(0.5) = DF(0.25) / (1 - 0.499 * 0.25 * 365/360) = 1.13346 (new method 1.13331),
    //              z = -25.06 percent (new method -25.03): refused.
    const inputs = (price: number): CurveInput[] => [
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
      fut(3, price),
    ];
    for (const interpolation of METHODS) {
      for (const price of [140, 149.9]) expect(validateCurveSetup(setup({ interpolation, inputs: inputs(price) })).ok).toBe(true);
      const solved = solveNodes(setup({ interpolation, inputs: inputs(140) }));
      const cashDf = 1 / (1 + 0.04 * 0.25 * (interpolation === "linear-zero" ? 1 : 365 / 360));
      expect(solved.z[1]).toBeCloseTo(-Math.log(cashDf / (1 - 0.4 * 0.25 * (365 / 360))) / 0.5, 12);
      expect(solved.z[1]).toBeGreaterThan(-0.2);
      expect(refusalsOf(() => solveNodes(setup({ interpolation, inputs: inputs(149.9) })))).toEqual([
        "row 2 futures price has no zero rate between -20 and 100 percent that fits its forward",
      ]);
    }
  });

  it("refuses every futures row whose start precedes the first node, naming each", () => {
    // Nodes at 4 and 5 months (the two futures ends), then 9: no node sits at or before month 1 or month 2.
    const refusals = refusalsOf(() => solveNodes(setup({ inputs: [
      fut(1, 96),
      fut(2, 96),
      { instrument: "cash", tenorMonths: 9, quoteType: "par-rate", value: 0.04 },
    ] })));
    expect(refusals).toEqual([
      "row 1 futures start precedes the first quote",
      "row 2 futures start precedes the first quote",
    ]);
  });

  it("a futures start on another futures row's node counts as a node: only the earlier row is refused", () => {
    // Row 1's node is at 4 months, but row 1 itself starts before any node, so it is refused alone.
    const refusals = refusalsOf(() => solveNodes(setup({ inputs: [
      fut(1, 96),
      { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: 0.04 },
      fut(4, 96),
    ] })));
    expect(refusals).toEqual(["row 1 futures start precedes the first quote"]);
  });

  it("the dense grid runs to the last node, the last futures start plus 3 months", () => {
    const inputs = STRIP.slice(0, 4);
    const r = buildCurveFromSetup(setup({ inputs }));
    expect(r.curve.t).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) / 12));
    expect(r.quoteTenors).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it("negative-forward warnings run to the last node, the futures end", () => {
    // P = 101 fixes a forward of -1 percent from month 3 to month 6; log-linear-df holds it flat.
    const { warnings } = solveNodes(setup({ inputs: [
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
      fut(3, 101),
    ] }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^negative forward of -\d+\.\d bp between month 3 and month 4 \(3 intervals\)$/);
  });

  it("the legacy delegate never runs with a futures row: linear-zero gives the solver's quote nodes", () => {
    const inputs = STRIP.slice(0, 4);
    const block = setup({ interpolation: "linear-zero", inputs });
    const r = buildCurveFromSetup(block);
    const solved = solveNodes(block);
    expect(r.curve.t).toEqual(solved.t);
    expect(r.curve.z).toEqual(solved.z);
    expect(r.curve.t).toEqual([0.25, 0.5, 0.75, 1]);
    expect(r.curve.convention).toBe("annual_act360");
  });
});

describe("validateCurveSetup with futures rows", () => {
  const block = (inputs: unknown[]) => ({
    id: "f", label: "f", baseCurve: "SOFR", interpolation: "log-linear-df",
    dayCount: "ACT/360", compounding: "annual", inputs,
  });

  it("accepts the strip, sorts by node tenor and keeps each row's own tenorMonths", () => {
    const shuffled = [STRIP[3], STRIP[5], STRIP[0], STRIP[2], STRIP[4], STRIP[1]];
    const r = validateCurveSetup(block(shuffled));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.block.inputs).toEqual(STRIP);
  });

  it("sorts a futures node between rows by its end, not its start", () => {
    const inputs = [
      { instrument: "cash", tenorMonths: 7, quoteType: "par-rate", value: 0.04 },
      fut(5, 96),
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
    ];
    const r = validateCurveSetup(block(inputs));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.block.inputs.map((i) => [i.instrument, i.tenorMonths])).toEqual([
      ["cash", 3], ["cash", 7], ["futures", 5],
    ]);
  });

  it("accepts a futures start of 357 and refuses 358 in words", () => {
    expect(validateCurveSetup(block([STRIP[0], fut(357, 96)])).ok).toBe(true);
    const r = validateCurveSetup(block([STRIP[0], fut(358, 96)]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals).toEqual([
      "row 2 futures start 358 months leaves no room for a 3-month period; the latest start is 357",
    ]);
  });

  it("refuses a futures node that repeats another row's tenor, naming the later row and both tenors", () => {
    const later = validateCurveSetup(block([
      { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: 0.04 },
      fut(3, 96),
    ]));
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.refusals).toEqual([
      "row 2 (futures starting at 3 months) ends at 6 months, the same node as row 1 (tenor 6 months)",
    ]);
    const earlier = validateCurveSetup(block([
      fut(3, 96),
      { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: 0.04 },
    ]));
    expect(earlier.ok).toBe(false);
    if (!earlier.ok) expect(earlier.refusals).toEqual([
      "row 2 (tenor 6 months) ends at 6 months, the same node as row 1 (futures starting at 3 months)",
    ]);
  });

  it("refuses two futures rows with the same start as a repeated node", () => {
    const r = validateCurveSetup(block([STRIP[0], fut(6, 96), fut(6, 95.9)]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals).toEqual([
      "row 3 (futures starting at 6 months) ends at 9 months, the same node as row 2 (futures starting at 6 months)",
    ]);
  });

  it("still refuses two plain rows at one tenor with the old sentence", () => {
    const r = validateCurveSetup(block([STRIP[0], STRIP[0]]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals).toEqual(["row 2 repeats tenor 3 months"]);
  });
});
