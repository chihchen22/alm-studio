import { describe, expect, it } from "vitest";
import { bootstrapZeroCurve, rehydrateCurve, type MarketSnapshot } from "@alm/kernel";
import type {
  CurveCompounding,
  CurveDayCount,
  CurveInput,
  CurveInterpolation,
  CurveSetupBlock,
} from "../../contracts/curveSetup";
import {
  buildCurveFromSetup,
  CurveBuildError,
  inheritQuoteTenors,
  makeZeroInterpolator,
  quoteTenorsOf,
  registerQuoteTenors,
  solveNodes,
} from "../index";

const MONTHS = [1, 3, 6, 12, 24, 60, 120];
const rows: CurveInput[] = MONTHS.map((m, i) => ({
  instrument: m <= 12 ? "cash" : "ois-swap",
  tenorMonths: m,
  quoteType: "par-rate",
  value: 0.04 + i * 0.0005,
}));
const mk = (
  interpolation: CurveInterpolation,
  over: Partial<Pick<CurveSetupBlock, "dayCount" | "compounding" | "inputs">> = {},
): CurveSetupBlock => ({
  id: "x",
  label: "x",
  baseCurve: "SOFR",
  interpolation,
  dayCount: "ACT/360",
  compounding: "annual",
  inputs: rows,
  ...over,
});

/** The kernel snapshot the legacy delegate should build, restated here for the comparison. */
const kernelSnapshot = (
  inputs: readonly CurveInput[],
  convention: "annual_act360" | "semiannual_bond",
): MarketSnapshot =>
  ({
    curveConvention: convention,
    curveQuotes: inputs.map((r) => ({
      term: `${r.tenorMonths}M`,
      tYears: r.tenorMonths / 12,
      instrumentType: r.instrument === "cash" ? "CASH" : "SWAP",
      rate: r.value,
    })),
  }) as unknown as MarketSnapshot; // bootstrapZeroCurve reads curveQuotes and curveConvention only

describe("buildCurveFromSetup", () => {
  it("log-linear gives 120 dense monthly nodes and 7 quote tenors", () => {
    const r = buildCurveFromSetup(mk("log-linear-df"));
    expect(r.curve.t).toHaveLength(120);
    expect(quoteTenorsOf(r.curve)).toEqual(MONTHS.map((m) => m / 12));
    expect(r.quoteTenors).toEqual(MONTHS.map((m) => m / 12));
  });

  it("linear-zero keeps quote nodes only", () => {
    const r = buildCurveFromSetup(mk("linear-zero"));
    expect(r.curve.t).toHaveLength(7);
  });

  it("a plain kernel curve reports its own nodes as quote tenors", () => {
    const r = buildCurveFromSetup(mk("linear-zero"));
    expect(quoteTenorsOf(r.curve)).toEqual(r.curve.t);
    const plain = rehydrateCurve({ t: [0.5, 1, 2], z: [0.03, 0.031, 0.032] });
    expect(quoteTenorsOf(plain)).toEqual([0.5, 1, 2]);
  });

  for (const method of ["log-linear-df", "cubic-zero", "monotone-convex"] as const) {
    it(`${method} writes nodes at k/12 from the method's interpolator`, () => {
      const block = mk(method);
      const r = buildCurveFromSetup(block);
      const solved = solveNodes(block);
      const zf = makeZeroInterpolator(method, solved.t, solved.z);
      expect(r.curve.t).toEqual(Array.from({ length: 120 }, (_, i) => (i + 1) / 12));
      r.curve.t.forEach((ti, i) => expect(r.curve.z[i]).toBe(zf(ti)));
      // The dense nodes sit on the quote nodes at the quote tenors.
      MONTHS.forEach((m, j) => expect(Math.abs(r.curve.z[m - 1] - solved.z[j])).toBeLessThan(1e-14));
      expect(r.curve.convention).toBe("annual_act360");
      expect(r.warnings).toEqual(solved.warnings);
    });
  }

  it("dense nodes start at one month when the first quote is later, held flat at the first zero", () => {
    const later = rows.filter((r) => r.tenorMonths >= 6);
    const r = buildCurveFromSetup(mk("log-linear-df", { inputs: later }));
    const solved = solveNodes(mk("log-linear-df", { inputs: later }));
    expect(r.curve.t[0]).toBe(1 / 12);
    expect(r.curve.z.slice(0, 5)).toEqual(Array(5).fill(solved.z[0]));
    expect(r.quoteTenors).toEqual([6, 12, 24, 60, 120].map((m) => m / 12));
  });

  it("legacy delegate returns the kernel bootstrap unchanged (ACT/360, annual)", () => {
    const r = buildCurveFromSetup(mk("linear-zero"));
    const kernel = bootstrapZeroCurve(kernelSnapshot(rows, "annual_act360"));
    expect(r.curve.t).toEqual(kernel.t);
    expect(r.curve.z).toEqual(kernel.z);
    expect(r.curve.convention).toBe("annual_act360");
  });

  // The cash rows here are ACT/360 annual, so the three new methods price
  // them on t 365/360 and linear-zero (the kernel's bytes) on t. Restated, not imported.
  for (const method of ["log-linear-df", "cubic-zero", "monotone-convex"] as const) {
    it(`${method} reprices each ACT/360 annual cash row on 1 / (1 + r t 365/360)`, () => {
      const { curve } = buildCurveFromSetup(mk(method));
      for (const row of rows.filter((r) => r.instrument === "cash")) {
        const t = row.tenorMonths / 12;
        expect(Math.abs(curve.discountFactor(t) - 1 / (1 + row.value * t * (365 / 360)))).toBeLessThan(1e-14);
      }
    });
  }

  it("linear-zero keeps the cash rows on 1 / (1 + r t), the kernel's accrual", () => {
    const { curve } = buildCurveFromSetup(mk("linear-zero"));
    for (const row of rows.filter((r) => r.instrument === "cash")) {
      const t = row.tenorMonths / 12;
      expect(Math.abs(curve.discountFactor(t) - 1 / (1 + row.value * t))).toBeLessThan(1e-14);
    }
  });

  it("legacy delegate maps ACT/365 semi-annual to semiannual_bond", () => {
    const semiRows = rows.map((r) => ({ ...r, instrument: "ois-swap" as const }));
    const r = buildCurveFromSetup(mk("linear-zero", { dayCount: "ACT/365", compounding: "semi-annual", inputs: semiRows }));
    const kernel = bootstrapZeroCurve(kernelSnapshot(semiRows, "semiannual_bond"));
    expect(r.curve.t).toEqual(kernel.t);
    expect(r.curve.z).toEqual(kernel.z);
    expect(r.curve.convention).toBe("semiannual_bond");
  });

  it("an unmapped semi-annual pair carries the semiannual_bond convention and keeps its nodes", () => {
    const block = mk("linear-zero", { dayCount: "ACT/360", compounding: "semi-annual" });
    const r = buildCurveFromSetup(block); // nodes are computed by the engine solver, not the kernel
    const solved = solveNodes(block);
    expect(r.curve.convention).toBe("semiannual_bond");
    expect(Array.from(r.curve.t)).toEqual(Array.from(solved.t));
    expect(Array.from(r.curve.z)).toEqual(Array.from(solved.z));
  });

  it("linear-zero with a zero-rate row goes through the solver, keeping the mapped convention", () => {
    const mixed: CurveInput[] = [{ instrument: "cash", tenorMonths: 1, quoteType: "zero-rate", value: 0.04 }, ...rows.slice(1)];
    const block = mk("linear-zero", { dayCount: "ACT/365", compounding: "semi-annual", inputs: mixed });
    const r = buildCurveFromSetup(block);
    const solved = solveNodes(block);
    expect(r.curve.t).toEqual(solved.t);
    expect(r.curve.z).toEqual(solved.z);
    expect(r.curve.convention).toBe("semiannual_bond");
  });

  const unmapped: Array<[CurveDayCount, CurveCompounding, "annual_act360" | "semiannual_bond"]> = [
    ["ACT/360", "semi-annual", "semiannual_bond"],
    ["ACT/365", "annual", "annual_act360"],
    ["ACT/360", "continuous", "annual_act360"],
    ["ACT/365", "continuous", "annual_act360"],
  ];
  for (const [dayCount, compounding, convention] of unmapped) {
    it(`unmapped ${dayCount} ${compounding} carries ${convention}`, () => {
      const zeroRows = rows.map((r) => ({ ...r, quoteType: "zero-rate" as const }));
      const r = buildCurveFromSetup(mk("cubic-zero", { dayCount, compounding, inputs: zeroRows }));
      expect(r.curve.convention).toBe(convention);
      expect(r.curve.t).toHaveLength(120);
    });
  }

  it("falls through to the solver when the kernel refuses negative swap rates", () => {
    const negative = rows.map((r) => ({ ...r, value: -0.005 - r.tenorMonths * 1e-5 }));
    expect(() => bootstrapZeroCurve(kernelSnapshot(negative, "annual_act360"))).toThrow();
    const block = mk("linear-zero", { inputs: negative });
    const r = buildCurveFromSetup(block);
    const solved = solveNodes(block);
    expect(r.curve.t).toEqual(solved.t);
    expect(r.curve.z).toEqual(solved.z);
    expect(r.curve.z.every((z) => z < 0)).toBe(true);
    expect(r.curve.convention).toBe("annual_act360");
  });

  // B1 follow-up: the fall-through is no longer silent. The sentence is restated by hand.
  const FALL_THROUGH =
    "the platform bootstrap could not bracket a zero rate for these rows (a negative or very steep zero rate is outside its root search); the engine solver built this curve under the same linear-zero model";

  it("the fall-through to the solver carries one warning line saying so", () => {
    const negative = rows.map((r) => ({ ...r, value: -0.005 - r.tenorMonths * 1e-5 }));
    const r = buildCurveFromSetup(mk("linear-zero", { inputs: negative }));
    expect(r.warnings.filter((w) => w === FALL_THROUGH)).toHaveLength(1);
    // The solver's own warnings still come through after it.
    expect(r.warnings.filter((w) => w !== FALL_THROUGH)).toEqual(solveNodes(mk("linear-zero", { inputs: negative })).warnings);
  });

  it("a steep all-positive curve the kernel cannot bracket falls through with the same warning", () => {
    // Review fix round 1 (I-1): the kernel's brackets run from 1e-5 to 30 percent around the prior node, so a steep
    // jump above them falls through too; the warning must not blame a negative rate.
    const steep: CurveInput[] = [
      { instrument: "cash", tenorMonths: 12, quoteType: "par-rate", value: 0.04 },
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.45 },
    ];
    expect(() => bootstrapZeroCurve(kernelSnapshot(steep, "annual_act360"))).toThrow();
    const block = mk("linear-zero", { inputs: steep });
    const r = buildCurveFromSetup(block);
    expect(r.curve.z.every((z) => z > 0)).toBe(true);
    expect(r.curve.z).toEqual(solveNodes(block).z);
    expect(r.warnings.filter((w) => w === FALL_THROUGH)).toHaveLength(1);
  });

  it("a setup the kernel builds, or one that never tries the kernel, carries no fall-through warning", () => {
    expect(buildCurveFromSetup(mk("linear-zero")).warnings).not.toContain(FALL_THROUGH);
    expect(buildCurveFromSetup(mk("log-linear-df")).warnings).not.toContain(FALL_THROUGH);
    const swapFirst = rows.filter((r) => r.tenorMonths >= 24);
    expect(buildCurveFromSetup(mk("linear-zero", { inputs: swapFirst })).warnings).not.toContain(FALL_THROUGH);
  });

  it("does not delegate when the first row is a swap the kernel cannot start from", () => {
    const swapFirst = rows.filter((r) => r.tenorMonths >= 24);
    const block = mk("linear-zero", { inputs: swapFirst });
    const r = buildCurveFromSetup(block);
    const solved = solveNodes(block);
    expect(r.curve.t).toEqual(solved.t);
    expect(r.curve.z).toEqual(solved.z);
    expect(r.curve.z.every(Number.isFinite)).toBe(true);
  });

  it("a futures row is never delegated; the solver's CurveBuildError propagates unchanged", () => {
    // Futures now solve, so the solver's refusal here is the start-before-first-quote rule.
    const withFutures: CurveInput[] = [
      { instrument: "futures", tenorMonths: 1, quoteType: "par-rate", value: 95.8 },
      ...rows.slice(2),
    ];
    let caught: unknown;
    try {
      buildCurveFromSetup(mk("linear-zero", { inputs: withFutures }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CurveBuildError);
    expect((caught as CurveBuildError).refusals).toEqual(["row 1 futures start precedes the first quote"]);
  });

  it("the legacy path reports the same negative-forward warning as the solver", () => {
    const inverted: CurveInput[] = [
      { instrument: "cash", tenorMonths: 1, quoteType: "par-rate", value: 0.1 },
      { instrument: "cash", tenorMonths: 12, quoteType: "par-rate", value: 0.01 },
    ];
    const block = mk("linear-zero", { inputs: inverted });
    const r = buildCurveFromSetup(block);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings).toEqual(solveNodes(block).warnings);
  });
});

describe("quote tenor side channel", () => {
  it("registers a copy and returns a copy", () => {
    const curve = rehydrateCurve({ t: [0.25, 0.5, 1], z: [0.03, 0.031, 0.032] });
    const tenors = [0.25, 1];
    registerQuoteTenors(curve, tenors);
    tenors.push(99);
    const read = quoteTenorsOf(curve);
    expect(read).toEqual([0.25, 1]);
    read.push(42);
    expect(quoteTenorsOf(curve)).toEqual([0.25, 1]);
  });

  it("the fallback is a copy of curve.t, not the array itself", () => {
    const curve = rehydrateCurve({ t: [1, 2], z: [0.03, 0.031] });
    const read = quoteTenorsOf(curve);
    expect(read).toEqual([1, 2]);
    expect(read).not.toBe(curve.t);
  });

  it("is keyed on the curve object: an equal curve elsewhere has no registration", () => {
    const a = rehydrateCurve({ t: [1, 2, 3], z: [0.03, 0.031, 0.032] });
    const b = rehydrateCurve({ t: [1, 2, 3], z: [0.03, 0.031, 0.032] });
    registerQuoteTenors(a, [3]);
    expect(quoteTenorsOf(a)).toEqual([3]);
    expect(quoteTenorsOf(b)).toEqual([1, 2, 3]);
  });

  it("inheritQuoteTenors copies a registration and leaves the target alone when there is none", () => {
    const built = buildCurveFromSetup(mk("monotone-convex")).curve;
    const shifted = rehydrateCurve({ t: [...built.t], z: built.z.map((z) => z + 0.01) });
    expect(quoteTenorsOf(shifted)).toHaveLength(120);
    inheritQuoteTenors(built, shifted);
    expect(quoteTenorsOf(shifted)).toEqual(MONTHS.map((m) => m / 12));

    const plain = rehydrateCurve({ t: [1, 2], z: [0.03, 0.031] });
    const target = rehydrateCurve({ t: [1, 2, 5], z: [0.03, 0.031, 0.033] });
    registerQuoteTenors(target, [5]);
    inheritQuoteTenors(plain, target);
    expect(quoteTenorsOf(target)).toEqual([5]);
  });
});
