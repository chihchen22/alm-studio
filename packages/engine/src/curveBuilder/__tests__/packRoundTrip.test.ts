/**
 * All-method round trip on the stored packs (Task 4 carried minor).
 *
 * For both month-exact packs and every interpolation method, build the curve
 * through buildCurveFromSetup and reprice every quote from discountFactor
 * reads on the OUTPUT kernel curve at whole-month tenors m / 12. This proves
 * the dense monthly nodes, read back through the kernel's linear-in-zero lerp,
 * still reprice the quotes. The par formulas are restated here, not imported.
 *
 *   semiannual_bond (ACT/365, semi-annual), the CMT three-branch rule:
 *     t < 0.5        y = 2 (DF(t)^(-1/(2t)) - 1)
 *     0.5 <= t < 1   y = 2 (1 / DF(t) - 1)
 *     t >= 1         y = (1 - DF(t)) / (0.5 sum_{k=1..2t} DF(k/2))
 *   annual_act360 (ACT/360, annual):
 *     cash, a new method r = (1 / DF(t) - 1) / (t 365/360)
 *     cash, linear-zero         r = (1 / DF(t) - 1) / t
 *     not cash, t <= 1          r = (1 / DF(t) - 1) / t
 *     t > 1                     r = (1 - DF(t)) / ((365/360) sum_{k=1..t} DF(k))
 *   The new methods are log-linear-df, cubic-zero and monotone-convex.
 *
 * On the stored packs no row takes the new cash branch: the public pack is
 * semiannual_bond, and the constructed pack's only CASH quote (1D) rounds to
 * 0 months and is dropped. The cash branch is pinned on a hand-built ACT/360
 * annual setup at the end of this file.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMarketSnapshot, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import type { CurveInput, CurveInterpolation } from "../../contracts/curveSetup";
import { buildCurveFromSetup } from "../buildCurve";
import { monthExactSnapshot, setupFromSnapshot } from "./helpers";

const load = (url: URL): MarketSnapshot => parseMarketSnapshot(JSON.parse(readFileSync(url, "utf8")));

const PACKS = [
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
  new URL("../../../../kernel/src/math/rates/__tests__/fixtures/market_constructed.json", import.meta.url),
];
const METHODS: CurveInterpolation[] = ["linear-zero", "log-linear-df", "cubic-zero", "monotone-convex"];

const df = (curve: ZeroCurve, months: number): number => curve.discountFactor(months / 12);

function semiannualPar(curve: ZeroCurve, m: number): number {
  const t = m / 12;
  if (m < 6) return 2 * (df(curve, m) ** (-1 / (2 * t)) - 1);
  if (m < 12) return 2 * (1 / df(curve, m) - 1);
  let annuity = 0;
  for (let k = 1; k <= m / 6; k++) annuity += 0.5 * df(curve, 6 * k);
  return (1 - df(curve, m)) / annuity;
}

function annualAct360Par(curve: ZeroCurve, row: CurveInput, method: CurveInterpolation): number {
  const m = row.tenorMonths;
  const t = m / 12;
  if (row.instrument === "cash") return (1 / df(curve, m) - 1) / (t * (method === "linear-zero" ? 1 : 365 / 360));
  if (m <= 12) return (1 / df(curve, m) - 1) / t;
  let annuity = 0;
  for (let k = 1; k <= m / 12; k++) annuity += (365 / 360) * df(curve, 12 * k);
  return (1 - df(curve, m)) / annuity;
}

describe("every stored pack reprices every quote under every method", () => {
  for (const url of PACKS) {
    for (const method of METHODS) {
      it(`${url.pathname.split("/").pop()} under ${method}`, () => {
        const snap = monthExactSnapshot(load(url)).snapshot;
        const setup = setupFromSnapshot(snap, method);
        const { curve } = buildCurveFromSetup(setup);
        const semi = snap.curveConvention === "semiannual_bond";
        expect(curve.convention).toBe(snap.curveConvention);
        expect(setup.inputs.length).toBeGreaterThan(5);
        for (const row of setup.inputs) {
          const repriced = semi ? semiannualPar(curve, row.tenorMonths) : annualAct360Par(curve, row, method);
          expect(Math.abs(repriced - row.value)).toBeLessThan(1e-10);
        }
      });
    }
  }
});

describe("an ACT/360 annual setup with cash rows reprices them on the decision 71 accrual", () => {
  const inputs: CurveInput[] = [
    { instrument: "cash", tenorMonths: 1, quoteType: "par-rate", value: 0.0375 },
    { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.037 },
    { instrument: "cash", tenorMonths: 6, quoteType: "par-rate", value: 0.0365 },
    { instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.036 },
    { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.0355 },
    { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0365 },
  ];
  for (const method of METHODS) {
    it(`under ${method}`, () => {
      const { curve } = buildCurveFromSetup({
        id: "act360-cash", label: "act360-cash", baseCurve: "SOFR",
        interpolation: method, dayCount: "ACT/360", compounding: "annual", inputs,
      });
      for (const row of inputs) expect(Math.abs(annualAct360Par(curve, row, method) - row.value)).toBeLessThan(1e-10);
    });
  }
});
