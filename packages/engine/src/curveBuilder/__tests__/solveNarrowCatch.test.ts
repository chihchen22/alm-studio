/**
 * Narrowed catches (Task 7 carried hardening). Only a BrentBracketError means
 * "no root in the bracket": in solveNodes it becomes the par-row refusal, in
 * the legacy delegate it means the kernel refused and the solver takes over.
 * Any other throw is a defect and must propagate unchanged. The interpolator
 * and the kernel bootstrap are wrapped so a test can make them throw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrentBracketError } from "@alm/kernel";
import type { CurveInput, CurveSetupBlock } from "../../contracts/curveSetup";

const state = vi.hoisted(() => ({
  interpolatorThrows: undefined as Error | undefined,
  kernelThrows: undefined as Error | undefined,
}));

vi.mock("../interpolators", async (importOriginal) => {
  const real = await importOriginal<typeof import("../interpolators")>();
  return {
    ...real,
    makeZeroInterpolator: (...args: Parameters<typeof real.makeZeroInterpolator>) => {
      const zf = real.makeZeroInterpolator(...args);
      return (s: number) => {
        if (state.interpolatorThrows) throw state.interpolatorThrows;
        return zf(s);
      };
    },
  };
});

vi.mock("@alm/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@alm/kernel")>();
  return {
    ...real,
    bootstrapZeroCurve: (...args: Parameters<typeof real.bootstrapZeroCurve>) => {
      if (state.kernelThrows) throw state.kernelThrows;
      return real.bootstrapZeroCurve(...args);
    },
  };
});

const { solveNodes, CurveBuildError } = await import("../solve");
const { buildCurveFromSetup } = await import("../buildCurve");

const block = (over: Partial<CurveSetupBlock> & { inputs: CurveInput[] }): CurveSetupBlock => ({
  id: "c", label: "c", baseCurve: "SOFR", interpolation: "linear-zero",
  dayCount: "ACT/360", compounding: "annual", ...over,
});
const PAR: CurveInput[] = [
  { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.04 },
  { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.041 },
];

afterEach(() => {
  state.interpolatorThrows = undefined;
  state.kernelThrows = undefined;
});

describe("solveNodes catch", () => {
  it("lets a throw that is not a bracket failure propagate unchanged from the par root find", () => {
    const boom = new TypeError("interpolator defect");
    state.interpolatorThrows = boom;
    let caught: unknown;
    try {
      solveNodes(block({ interpolation: "log-linear-df", inputs: PAR }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(CurveBuildError);
  });
});

describe("buildCurveFromSetup kernel fall-through", () => {
  it("falls through to the solver on a kernel BrentBracketError", () => {
    state.kernelThrows = new BrentBracketError("no root");
    const b = block({ inputs: PAR });
    const r = buildCurveFromSetup(b);
    state.kernelThrows = undefined;
    const solved = solveNodes(b);
    expect(r.curve.t).toEqual(solved.t);
    expect(r.curve.z).toEqual(solved.z);
  });

  it("propagates any other kernel throw unchanged", () => {
    const boom = new RangeError("kernel defect");
    state.kernelThrows = boom;
    expect(() => buildCurveFromSetup(block({ inputs: PAR }))).toThrow(boom);
  });
});
