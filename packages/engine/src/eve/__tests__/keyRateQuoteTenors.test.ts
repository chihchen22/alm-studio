/**
 * Key-rate durations on a dense-node curve (Task
 * 6): the tents sit at the curve's QUOTE tenors, not its dense monthly nodes,
 * so the result carries one row per quote. The book and the expected values
 * follow the hand case in keyRate.test.ts: a 5Y zero-coupon bullet, whose
 * whole key-rate mass sits on the node at its own maturity when that tenor is
 * a quote, and whose duration is its maturity.
 */
import { describe, expect, it } from "vitest";
import { buildTLPCurve, rehydrateCurve, type TLPCurve } from "@alm/kernel";
import { computeKeyRateDurations } from "../keyRate";
import { buildCurveFromSetup, quoteTenorsOf } from "../../curveBuilder";
import { NotImplementedError } from "../../runtime/notImplemented";
import type { CurveSetupBlock } from "../../contracts/curveSetup";
import type { PortfolioSpec } from "../../contracts/position";
import { fixedPosition, makePortfolio } from "./fixtures";

const ZERO_TLP: TLPCurve = buildTLPCurve([{ tYears: 1, spread: 0 }]);
const MONTHS = [3, 6, 12, 24, 36, 60, 84];
const ZEROS = [0.03, 0.031, 0.032, 0.033, 0.034, 0.035, 0.036];

const SETUP: CurveSetupBlock = {
  id: "kr-seven",
  label: "seven zero-rate quotes",
  baseCurve: "SOFR",
  interpolation: "log-linear-df",
  dayCount: "ACT/365",
  compounding: "continuous",
  inputs: MONTHS.map((m, i) => ({ instrument: "cash" as const, tenorMonths: m, quoteType: "zero-rate" as const, value: ZEROS[i]! })),
};

/** A one-position book: a 5Y zero-coupon bullet (coupon 0) asset. */
function zeroCouponBook(): PortfolioSpec {
  return makePortfolio([fixedPosition("Z1", { notional: 1_000_000, coupon: 0, maturityMonths: 60, amortType: "bullet" })]);
}

const measure = (curve: Parameters<typeof computeKeyRateDurations>[0]["curve"]) =>
  computeKeyRateDurations({
    portfolio: zeroCouponBook(),
    scenarioId: "S0",
    curve,
    tlp: ZERO_TLP,
    horizonMonths: 72,
    discountBasis: "risk-free",
  });

describe("key-rate durations on a dense curve read the quote tenors", () => {
  const built = buildCurveFromSetup(SETUP);

  it("the built curve is dense and registers seven quote tenors", () => {
    expect(built.curve.t).toHaveLength(84);
    expect(quoteTenorsOf(built.curve)).toEqual(MONTHS.map((m) => m / 12));
  });

  it("has one node per quote tenor, the mass at the 5Y quote, and sums to the parallel reference", () => {
    const kr = measure(built.curve);
    expect(kr.nodes).toHaveLength(7);
    expect(kr.nodes.map((n) => n.tenorYears)).toEqual(MONTHS.map((m) => m / 12));
    const d = new Map(kr.nodes.map((n) => [n.tenorYears, n.duration]));
    // The 5Y tent peaks at the cash flow's own tenor: z(5) moves by the whole bump.
    expect(d.get(5)).toBeCloseTo(5, 3);
    // Every other tent is zero at 5Y, and the dense node there takes no shift.
    for (const [tenor, dur] of d) if (tenor !== 5) expect(Math.abs(dur), `${tenor}y`).toBeLessThan(1e-12);
    expect(kr.parallelReference).toBeCloseTo(5, 3);
    expect(kr.sum).toBeCloseTo(kr.parallelReference, 3);
    expect(kr.convergence.converged).toBe(true);
  });

  it("the same nodes with no registration give one key rate per dense node", () => {
    const bare = rehydrateCurve({ t: [...built.curve.t], z: [...built.curve.z], convention: built.curve.convention });
    const kr = measure(bare);
    expect(kr.nodes).toHaveLength(84);
    // The decomposition differs but the parallel reference is the same machinery on the same curve.
    expect(kr.parallelReference).toBe(measure(built.curve).parallelReference);
  });

  it("a coupon book spreads over several quote tents and still sums to the parallel reference", () => {
    // B1 follow-up: the bullet above loads one tent. A 5Y 5 percent coupon bullet plus a 7Y 4 percent
    // level-pay loan pay monthly from month 1 to 84, so every tent from 3M to 7Y carries mass.
    const book = makePortfolio([
      fixedPosition("C1", { notional: 1_000_000, coupon: 0.05, maturityMonths: 60, amortType: "bullet" }),
      fixedPosition("C2", { notional: 2_000_000, coupon: 0.04, maturityMonths: 84, amortType: "level-pay" }),
    ]);
    const kr = computeKeyRateDurations({
      portfolio: book,
      scenarioId: "S0",
      curve: built.curve,
      tlp: ZERO_TLP,
      horizonMonths: 96,
      discountBasis: "risk-free",
    });
    expect(kr.nodes.map((n) => n.tenorYears)).toEqual(MONTHS.map((m) => m / 12));
    const loaded = kr.nodes.filter((n) => Math.abs(n.duration) > 0.01);
    expect(loaded.length).toBeGreaterThanOrEqual(5);
    // Additivity: the tents partition the parallel shift, so only the second-order residual is left.
    expect(kr.convergence.converged).toBe(true);
    // The single-tent test above holds the sum to toBeCloseTo(.., 3) on a parallel reference of 5 years, that is 5e-4
    // absolute or 1e-4 relative; the same relative bound here. Measured residual: 2.8e-5 years (7.4e-6 relative).
    expect(Math.abs(kr.sum - kr.parallelReference)).toBeLessThan(1e-4 * kr.parallelReference);
  });

  it("refuses a dense curve built from a single quote: one quote tenor is a parallel shock only", () => {
    const one = buildCurveFromSetup({ ...SETUP, inputs: [SETUP.inputs[5]!] });
    expect(one.curve.t.length).toBeGreaterThan(1);
    expect(quoteTenorsOf(one.curve)).toEqual([5]);
    let caught: unknown;
    try {
      measure(one.curve);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotImplementedError);
    expect((caught as NotImplementedError).layer).toBe("eve.key-rate");
    expect((caught as Error).message).toMatch(/carries 1 node\(s\)/);
  });
});
