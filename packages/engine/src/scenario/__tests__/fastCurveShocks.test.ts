/**
 * Shocks keep the fast curve.
 *
 * From a fast base, the parallel, twist and custom results are fast curves and
 * read bit for bit like the same shock of a kernel curve over the same nodes;
 * from a kernel base (no curve setup) they stay kernel objects. The EVE
 * discount function's parallel leg follows the same rule. Fixtures restated.
 */
import { describe, expect, it } from "vitest";
import { buildTLPCurve, rehydrateCurve, shockCurve, type ZeroCurve } from "@alm/kernel";
import { isFastCurve, makeFastCurve, shiftCurveParallel } from "../../curveBuilder/fastCurve";
import { quoteTenorsOf, registerQuoteTenors } from "../../curveBuilder";
import { shockedCurve } from "../rateEnvironment";
import { discountFunction } from "../../eve/discount";
import type { RateSpec } from "../../contracts/scenario";

const T: number[] = [];
const Z: number[] = [];
for (let k = 1; k <= 360; k++) {
  T.push(k / 12);
  Z.push(0.036 + 0.006 * Math.sin(k / 41) + 0.001 * Math.cos(k / 7));
}

const SPECS: Array<Exclude<RateSpec, { kind: "base" }>> = [
  { kind: "parallel", shockBp: 200 },
  { kind: "parallel", shockBp: -137.5 },
  { kind: "twist", shortBp: 25, longBp: -40, pivotYears: 5 },
  { kind: "custom", shocks: [{ tenorYears: 0.5, shockBp: 15 }, { tenorYears: 7, shockBp: -30 }, { tenorYears: 25, shockBp: 5 }] },
];

const TIMES: number[] = [];
for (let m = 0; m <= 380; m++) TIMES.push(m / 12, m / 12 + 0.013);
for (let m = 1; m <= 360; m++) TIMES.push((m - 1) / 12 + 3 / 2);
TIMES.push(-0.5, 0, 1e-9, 45);

function mismatches(a: ZeroCurve, b: ZeroCurve): number {
  let n = 0;
  for (const x of TIMES) {
    if (!Object.is(a.zeroRate(x), b.zeroRate(x))) n++;
    if (!Object.is(a.discountFactor(x), b.discountFactor(x))) n++;
    for (const d of [1 / 12, 0.5, 1, 10]) {
      if (!Object.is(a.forwardRate(x, x + d), b.forwardRate(x, x + d))) n++;
      if (!Object.is(a.forwardRateBey(x, x + d), b.forwardRateBey(x, x + d))) n++;
      if (!Object.is(a.forwardSwapRate(x, x + d), b.forwardSwapRate(x, x + d))) n++;
    }
  }
  return n;
}

describe("shockedCurve from a fast base", () => {
  for (const convention of ["semiannual_bond", "annual_act360"] as const) {
    for (const spec of SPECS) {
      it(`${spec.kind} ${JSON.stringify(spec)} (${convention}) is fast and reads like the kernel shock`, () => {
        const fastBase = makeFastCurve([...T], [...Z], convention);
        const kernelBase = rehydrateCurve({ t: [...T], z: [...Z], convention });
        const fast = shockedCurve(fastBase, spec);
        const kernel = shockedCurve(kernelBase, spec);
        expect(isFastCurve(fast)).toBe(true);
        expect(isFastCurve(kernel)).toBe(false);
        expect(fast.t).toEqual(kernel.t);
        expect(fast.z).toEqual(kernel.z);
        expect(fast.convention).toBe(convention);
        expect(mismatches(fast, kernel)).toBe(0);
      });
    }
  }

  it("the parallel shift adds shockBp / 1e4 to every node, exactly as the kernel's shockCurve", () => {
    const fastBase = makeFastCurve([...T], [...Z], "semiannual_bond");
    const kernelShock = shockCurve(rehydrateCurve({ t: [...T], z: [...Z], convention: "semiannual_bond" }), 200);
    const fast = shockedCurve(fastBase, { kind: "parallel", shockBp: 200 });
    expect(fast.z).toEqual(kernelShock.z);
    expect(fast.t).not.toBe(fastBase.t);
  });

  it("a shocked fast curve keeps the base's quote tenors", () => {
    const fastBase = makeFastCurve([...T], [...Z], "semiannual_bond");
    registerQuoteTenors(fastBase, [1, 5, 30]);
    for (const spec of SPECS) expect(quoteTenorsOf(shockedCurve(fastBase, spec))).toEqual([1, 5, 30]);
  });

  it("base returns the fast base itself", () => {
    const fastBase = makeFastCurve([...T], [...Z], "semiannual_bond");
    expect(shockedCurve(fastBase, { kind: "base" })).toBe(fastBase);
  });
});

describe("shockedCurve from a kernel base stays on the kernel objects", () => {
  for (const spec of SPECS) {
    it(`${spec.kind} ${JSON.stringify(spec)}`, () => {
      const kernelBase = rehydrateCurve({ t: [...T], z: [...Z], convention: "semiannual_bond" });
      expect(isFastCurve(shockedCurve(kernelBase, spec))).toBe(false);
    });
  }
});

describe("shiftCurveParallel and the EVE discount function", () => {
  const tlp = buildTLPCurve([{ tYears: 1, spread: 0.001 }, { tYears: 10, spread: 0.004 }]);

  it("shifts a fast curve to a fast curve and a kernel curve to a kernel curve", () => {
    const fastBase = makeFastCurve([...T], [...Z], "annual_act360");
    const kernelBase = rehydrateCurve({ t: [...T], z: [...Z], convention: "annual_act360" });
    const f = shiftCurveParallel(fastBase, 100);
    const k = shiftCurveParallel(kernelBase, 100);
    expect(isFastCurve(f)).toBe(true);
    expect(isFastCurve(k)).toBe(false);
    expect(mismatches(f, k)).toBe(0);
    expect(mismatches(k, shockCurve(kernelBase, 100))).toBe(0);
  });

  for (const basis of ["all-in", "risk-free"] as const) {
    for (const bp of [0, 100, -100]) {
      it(`discountFunction ${basis} at ${bp}bp reads the same off a fast and a kernel base`, () => {
        const fast = discountFunction(makeFastCurve([...T], [...Z], "semiannual_bond"), tlp, bp, basis);
        const kernel = discountFunction(rehydrateCurve({ t: [...T], z: [...Z], convention: "semiannual_bond" }), tlp, bp, basis);
        let n = 0;
        for (const x of TIMES) if (!Object.is(fast(x), kernel(x))) n++;
        expect(n).toBe(0);
      });
    }
  }
});
