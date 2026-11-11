// flatCurves.test.ts: restates the par formula; does NOT import it from solve.ts.
import { describe, expect, it } from "vitest";
import { solveNodes } from "../solve";
import type { CurveSetupBlock } from "../../contracts/curveSetup";

const flatZ = 0.04;
const df = (t: number) => Math.exp(-flatZ * t);
const fix = (dc: string) => (dc === "ACT/360" ? 365 / 360 : 1);
const parAnnual = (T: number, dc: string) => {
  let a = 0; for (let k = 1; k <= T; k++) a += fix(dc) * df(k);
  return (1 - df(T)) / a;
};
const parSemi = (T: number, dc: string) => {
  let a = 0; for (let k = 1; k <= 2 * T; k++) a += 0.5 * fix(dc) * df(k / 2);
  return (1 - df(T)) / a;
};
const methods = ["linear-zero", "log-linear-df", "cubic-zero", "monotone-convex"] as const;

describe("flat curve closed form, six convention combinations", () => {
  for (const dc of ["ACT/360", "ACT/365"] as const) {
    for (const comp of ["annual", "semi-annual"] as const) {
      for (const m of methods) {
        it(`par rows rebuild a flat ${flatZ} curve: ${dc} ${comp} ${m}`, () => {
          const tenors = [2, 3, 5, 7, 10, 20, 30];
          const inputs = tenors.map((y) => ({
            instrument: "ois-swap" as const, tenorMonths: y * 12, quoteType: "par-rate" as const,
            value: comp === "annual" ? parAnnual(y, dc) : parSemi(y, dc),
          }));
          const block: CurveSetupBlock = { id: "x", label: "x", baseCurve: "SOFR",
            interpolation: m, dayCount: dc, compounding: comp, inputs };
          const { t, z } = solveNodes(block);
          expect(t).toHaveLength(tenors.length);
          t.forEach((_, i) => expect(Math.abs(z[i] - flatZ)).toBeLessThan(1e-10));
        });
      }
    }
  }
  for (const m of methods) {
    it(`zero-rate rows continuous rebuild a flat curve: ${m}`, () => {
      const inputs = [1, 5, 10].map((y) => ({ instrument: "cash" as const, tenorMonths: y * 12,
        quoteType: "zero-rate" as const, value: flatZ }));
      const { z } = solveNodes({ id: "x", label: "x", baseCurve: "SOFR", interpolation: m,
        dayCount: "ACT/365", compounding: "continuous", inputs });
      expect(z).toHaveLength(3);
      z.forEach((zi) => expect(Math.abs(zi - flatZ)).toBeLessThan(1e-10));
    });
  }
});
