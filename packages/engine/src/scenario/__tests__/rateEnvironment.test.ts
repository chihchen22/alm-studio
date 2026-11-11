/**
 * Rate-environment tests: base-curve bootstrap, parallel/twist shocks, RatePath
 * construction. These are the mathematical acceptance criteria for m04:
 *   - parallel 0bp reproduces the base curve exactly;
 *   - parallel +100 matches kernel shockCurve;
 *   - twist round-trips the base curve at zero twist;
 *   - twist preserves discount-factor monotonicity.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  loadMarketSnapshot,
  shockCurve,
  type MarketSnapshot,
  type ZeroCurve,
} from "@alm/kernel";
import {
  buildBaseCurve,
  buildRatePath,
  customCurve,
  customShiftBp,
  CustomShockError,
  discountFactorsMonotone,
  shockedCurve,
  twistCurve,
  twistShiftBp,
  TwistError,
  validateCustomShocks,
} from "../rateEnvironment";

const FIXTURE = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);

// Sample tenors spanning the curve; a couple sit off the nodes to exercise
// interpolation, not just the pillars.
const SAMPLE_T = [0.25, 0.5, 1, 1.7, 2, 3.3, 5, 7, 10, 20, 30];
// Dense grid for the monotonicity property.
const DENSE_T = Array.from({ length: 300 }, (_, i) => (i + 1) * 0.1); // 0.1 .. 30.0

let snapshot: MarketSnapshot;
let base: ZeroCurve;

beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
  base = buildBaseCurve(snapshot);
});

describe("buildBaseCurve", () => {
  it("bootstraps a curve whose discount factors are monotone non-increasing", () => {
    expect(base.t.length).toBeGreaterThan(0);
    expect(discountFactorsMonotone(base, DENSE_T)).toBe(true);
    expect(base.discountFactor(0)).toBeCloseTo(1, 12);
  });
});

describe("shockedCurve — parallel", () => {
  it("0bp reproduces the base curve exactly at every sample tenor", () => {
    const c = shockedCurve(base, { kind: "parallel", shockBp: 0 });
    for (const t of SAMPLE_T) {
      expect(c.zeroRate(t)).toBe(base.zeroRate(t));
      expect(c.discountFactor(t)).toBe(base.discountFactor(t));
    }
  });

  it("+100 matches kernel shockCurve node-for-node and point-for-point", () => {
    const mine = shockedCurve(base, { kind: "parallel", shockBp: 100 });
    const kernel = shockCurve(base, 100);
    for (const t of SAMPLE_T) {
      expect(mine.zeroRate(t)).toBe(kernel.zeroRate(t));
      expect(mine.discountFactor(t)).toBe(kernel.discountFactor(t));
    }
    // And the zero rate lifts by exactly 100bp versus base at every node.
    for (const t of base.t) {
      expect(mine.zeroRate(t)).toBeCloseTo(base.zeroRate(t) + 0.01, 12);
    }
  });
});

describe("twistCurve", () => {
  it("round-trips the base curve exactly at zero twist", () => {
    const c = twistCurve(base, 0, 0, 5);
    for (const t of SAMPLE_T) {
      expect(c.zeroRate(t)).toBeCloseTo(base.zeroRate(t), 12);
      expect(c.discountFactor(t)).toBeCloseTo(base.discountFactor(t), 12);
    }
    for (const t of base.t) {
      expect(c.zeroRate(t)).toBe(base.zeroRate(t));
    }
  });

  it("shifts the front toward shortBp and the long end toward longBp, pivoting at 0", () => {
    const shortBp = -150;
    const longBp = 200;
    const pivot = 5;
    const c = twistCurve(base, shortBp, longBp, pivot);
    const tMax = base.t[base.t.length - 1];
    // Front node moves down by ~shortBp; long node moves up by ~longBp.
    const tFront = base.t[0];
    const tLong = tMax;
    expect((c.zeroRate(tFront) - base.zeroRate(tFront)) * 1e4).toBeCloseTo(
      twistShiftBp(tFront, shortBp, longBp, pivot, tMax),
      9,
    );
    expect((c.zeroRate(tLong) - base.zeroRate(tLong)) * 1e4).toBeCloseTo(longBp, 9);
    // Pivot tenor is (near) unchanged: the ramp is zero at the pivot.
    expect(twistShiftBp(pivot, shortBp, longBp, pivot, tMax)).toBeCloseTo(0, 12);
  });

  it("preserves discount-factor monotonicity for regulatory-scale twists", () => {
    const twists: Array<[number, number, number]> = [
      [-100, 100, 5], // steepener
      [100, -100, 5], // flattener
      [-200, 200, 2], // sharper steepener, near pivot
      [100, -100, 10], // flattener pivoting long
      [-150, 150, 7], // steepener, mid pivot
    ];
    for (const [s, l, p] of twists) {
      const c = twistCurve(base, s, l, p);
      expect(discountFactorsMonotone(c, DENSE_T)).toBe(true);
    }
  });

  it("surfaces (does not hide) a negative long forward from an extreme flattener", () => {
    // A 200bp flattener pivoting at 10Y drives the 30Y zero (~4.15%) down to
    // ~2.15% while the 25Y sits near 2.70%, so z·t turns down past 25Y: the
    // implied 25-30Y forward is negative and discount factors stop decreasing.
    // This is a property of the shocked curve, not a transform defect; the
    // transform reports it honestly rather than clamping it away.
    const c = twistCurve(base, 200, -200, 10);
    expect(discountFactorsMonotone(c, DENSE_T)).toBe(false);
    // The break is confined to the far long end (past the 25Y region).
    const shortEnd = DENSE_T.filter((t) => t <= 20);
    expect(discountFactorsMonotone(c, shortEnd)).toBe(true);
  });

  it("rejects a pivot outside (0, maxTenor) with an inspectable TwistError", () => {
    const tMax = base.t[base.t.length - 1];
    expect(() => twistCurve(base, -100, 100, 0)).toThrow(TwistError);
    expect(() => twistCurve(base, -100, 100, tMax)).toThrow(TwistError);
    try {
      twistCurve(base, -100, 100, -1);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TwistError);
      expect((e as TwistError).pivotYears).toBe(-1);
      expect((e as TwistError).maxTenorYears).toBe(tMax);
    }
  });
});

describe("shockedCurve — twist and base dispatch", () => {
  it("kind base returns the base curve unchanged", () => {
    expect(shockedCurve(base, { kind: "base" })).toBe(base);
  });

  it("kind twist delegates to twistCurve", () => {
    const viaSpec = shockedCurve(base, {
      kind: "twist",
      shortBp: -100,
      longBp: 100,
      pivotYears: 5,
    });
    const direct = twistCurve(base, -100, 100, 5);
    for (const t of SAMPLE_T) {
      expect(viaSpec.zeroRate(t)).toBe(direct.zeroRate(t));
    }
  });
});

describe("customCurve", () => {
  it("ANCHOR: a custom vector on the twist's knots reproduces twistCurve to 1e-12", () => {
    // The twist ramp is piecewise linear with breakpoints {0, pivot, maxTenor};
    // a custom vector with exactly those knots must be the same function. This
    // proves the custom arm is the same node-wise-shift machinery as the twist,
    // not a parallel implementation.
    const shortBp = -150;
    const longBp = 200;
    const pivot = 5;
    const tMax = base.t[base.t.length - 1];
    const viaTwist = twistCurve(base, shortBp, longBp, pivot);
    const viaCustom = customCurve(base, [
      { tenorYears: 0, shockBp: shortBp },
      { tenorYears: pivot, shockBp: 0 },
      { tenorYears: tMax, shockBp: longBp },
    ]);
    let maxZ = 0;
    let maxDf = 0;
    for (const t of [...base.t, ...SAMPLE_T, ...DENSE_T]) {
      maxZ = Math.max(maxZ, Math.abs(viaCustom.zeroRate(t) - viaTwist.zeroRate(t)));
      maxDf = Math.max(maxDf, Math.abs(viaCustom.discountFactor(t) - viaTwist.discountFactor(t)));
    }
    // Measured 2026-08-02: maxZ = 0, maxDf = 0 — exact identity, the two arms
    // share lerp + makeZeroCurve and the shift arithmetic agrees to the ulp.
    expect(maxZ).toBeLessThan(1e-12);
    expect(maxDf).toBeLessThan(1e-12);
  });

  it("ANCHOR: a zero vector round-trips the base curve exactly", () => {
    const c = customCurve(base, [
      { tenorYears: 0, shockBp: 0 },
      { tenorYears: 10, shockBp: 0 },
      { tenorYears: 30, shockBp: 0 },
    ]);
    for (const t of base.t) {
      expect(c.zeroRate(t)).toBe(base.zeroRate(t));
    }
    for (const t of SAMPLE_T) {
      expect(c.zeroRate(t)).toBe(base.zeroRate(t));
      expect(c.discountFactor(t)).toBe(base.discountFactor(t));
    }
  });

  it("degeneracy: a single-knot vector is a parallel shock matching kernel shockCurve to 1e-12", () => {
    // One knot extends flat both ways: a +100bp single knot must reproduce the
    // kernel's own parallel machinery.
    const viaCustom = customCurve(base, [{ tenorYears: 5, shockBp: 100 }]);
    const viaKernel = shockCurve(base, 100);
    for (const t of [...base.t, ...SAMPLE_T]) {
      expect(viaCustom.zeroRate(t)).toBeCloseTo(viaKernel.zeroRate(t), 12);
      expect(viaCustom.discountFactor(t)).toBeCloseTo(viaKernel.discountFactor(t), 12);
    }
  });

  it("interpolates linearly between knots and extends flat outside them", () => {
    const shocks = [
      { tenorYears: 2, shockBp: -50 },
      { tenorYears: 10, shockBp: 150 },
    ];
    expect(customShiftBp(2, shocks)).toBe(-50);
    expect(customShiftBp(10, shocks)).toBe(150);
    expect(customShiftBp(6, shocks)).toBeCloseTo(50, 12); // midpoint
    expect(customShiftBp(0.25, shocks)).toBe(-50); // flat below the first knot
    expect(customShiftBp(30, shocks)).toBe(150); // flat past the last knot
    const c = customCurve(base, shocks);
    for (const t of base.t) {
      expect((c.zeroRate(t) - base.zeroRate(t)) * 1e4).toBeCloseTo(customShiftBp(t, shocks), 9);
    }
  });

  it("REFUSES malformed vectors with a CustomShockError naming the offending knot", () => {
    // Empty vector.
    expect(() => customCurve(base, [])).toThrow(CustomShockError);
    // Non-finite tenor.
    try {
      validateCustomShocks([{ tenorYears: Number.NaN, shockBp: 10 }]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomShockError);
      expect((e as CustomShockError).field).toBe("rateSpec.shocks[0].tenorYears");
    }
    // Negative tenor: message names the offending tenor.
    try {
      validateCustomShocks([{ tenorYears: -1, shockBp: 10 }]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomShockError);
      expect((e as CustomShockError).message).toContain("-1y");
    }
    // Non-finite shock: message names the tenor whose shock is bad.
    try {
      validateCustomShocks([{ tenorYears: 5, shockBp: Number.POSITIVE_INFINITY }]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomShockError);
      expect((e as CustomShockError).field).toBe("rateSpec.shocks[0].shockBp");
      expect((e as CustomShockError).message).toContain("5y");
    }
    // Non-ascending tenors: names both the knot and the preceding tenor.
    try {
      validateCustomShocks([
        { tenorYears: 5, shockBp: 10 },
        { tenorYears: 5, shockBp: 20 },
      ]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomShockError);
      expect((e as CustomShockError).field).toBe("rateSpec.shocks[1].tenorYears");
      expect((e as CustomShockError).message).toContain("5y");
    }
  });
});

describe("shockedCurve — custom dispatch", () => {
  it("kind custom delegates to customCurve", () => {
    const shocks = [
      { tenorYears: 1, shockBp: -25 },
      { tenorYears: 20, shockBp: 75 },
    ];
    const viaSpec = shockedCurve(base, { kind: "custom", shocks });
    const direct = customCurve(base, shocks);
    for (const t of SAMPLE_T) {
      expect(viaSpec.zeroRate(t)).toBe(direct.zeroRate(t));
    }
  });
});

describe("buildRatePath", () => {
  it("wraps a curve into a DeterministicRatePath with the requested horizon", () => {
    const path = buildRatePath(base, 360);
    expect(path.nSteps).toBe(360);
    expect(path.times.length).toBe(361);
    expect(Number.isFinite(path.rateAt(0))).toBe(true);
    expect(Number.isFinite(path.forwardRateAt(12, 10))).toBe(true);
  });

  it("an up-shocked path carries higher forward rates than base at every sampled step", () => {
    const basePath = buildRatePath(base, 360);
    const upPath = buildRatePath(shockedCurve(base, { kind: "parallel", shockBp: 200 }), 360);
    for (const step of [1, 12, 60, 120, 240]) {
      expect(upPath.forwardRateAt(step, 1)).toBeGreaterThan(basePath.forwardRateAt(step, 1));
    }
  });
});
