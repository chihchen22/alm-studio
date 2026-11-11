/**
 * Discount function and bucketed PV.
 *
 * The discount function must be byte-identical to the kernel effective-duration
 * engine's internal all-in df, and a bucketed bullet's PV must equal notional
 * times the discount factor — the analytic anchor for the whole PV path.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  bootstrapZeroCurve,
  buildTLPCurve,
  DEFAULT_TLP_CURVE,
  DeterministicRatePath,
  loadMarketSnapshot,
  shockCurve,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import type { BucketedSeries } from "../../contracts/results";
import { aggregateScenario } from "../../portfolio";
import { discountFunction } from "../discount";
import { pvBucketedSeries } from "../pv";
import { fixedPosition, makeCoa } from "./fixtures";

const MARKET = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);
const ZERO_TLP: TLPCurve = buildTLPCurve([{ tYears: 1, spread: 0 }]);

let base: ZeroCurve;
beforeAll(async () => {
  base = bootstrapZeroCurve(await loadMarketSnapshot(MARKET));
});

describe("discountFunction — all-in funding curve", () => {
  it("matches the kernel dfFor formula on the base leg (all-in)", () => {
    const df = discountFunction(base, DEFAULT_TLP_CURVE, 0, "all-in");
    for (const t of [0.25, 1, 5, 12.5, 30]) {
      const expected = base.discountFactor(t) * Math.exp(-DEFAULT_TLP_CURVE.tlp(t) * t);
      expect(df(t)).toBeCloseTo(expected, 14);
    }
    expect(df(0)).toBe(1); // time-zero flow undiscounted
  });

  it("rebuilds the risk-free leg from the shifted curve under a shock, TLP static", () => {
    const df = discountFunction(base, DEFAULT_TLP_CURVE, 100, "all-in");
    const shifted = shockCurve(base, 100);
    for (const t of [1, 5, 20]) {
      const expected = shifted.discountFactor(t) * Math.exp(-DEFAULT_TLP_CURVE.tlp(t) * t);
      expect(df(t)).toBeCloseTo(expected, 14);
    }
  });

  it("risk-free basis drops the TLP overlay", () => {
    const df = discountFunction(base, DEFAULT_TLP_CURVE, 0, "risk-free");
    for (const t of [1, 5, 20]) expect(df(t)).toBeCloseTo(base.discountFactor(t), 14);
  });

  it("spread-consistent basis adds the spread to the TLP; risk-free ignores a spread (spec E3)", () => {
    const df = discountFunction(base, DEFAULT_TLP_CURVE, 100, "spread-consistent", 120);
    const rf = discountFunction(base, DEFAULT_TLP_CURVE, 0, "risk-free", 120);
    const shifted = shockCurve(base, 100);
    for (const t of [1, 5, 20]) {
      const expected = shifted.discountFactor(t) * Math.exp(-(DEFAULT_TLP_CURVE.tlp(t) + 0.012) * t);
      expect(df(t)).toBeCloseTo(expected, 14);
      expect(rf(t)).toBe(base.discountFactor(t));
    }
  });
});

describe("pvBucketedSeries — bullet PV anchor", () => {
  it("a single bullet's PV equals notional times the discount factor", () => {
    const horizon = 120;
    const maturityMonth = 60; // bucket 59
    const notional = 1_000_000;
    const principal = new Array(horizon).fill(0);
    const interest = new Array(horizon).fill(0);
    principal[maturityMonth - 1] = notional;
    const series: BucketedSeries = {
      balance: new Array(horizon).fill(0),
      principal,
      interest,
    };

    const df = discountFunction(base, DEFAULT_TLP_CURVE, 0, "all-in");
    const pv = pvBucketedSeries(series, df);

    const t = maturityMonth / 12;
    const expected = notional * base.discountFactor(t) * Math.exp(-DEFAULT_TLP_CURVE.tlp(t) * t);
    expect(pv).toBeCloseTo(expected, 6);
  });

  it("a real coupon-bearing bullet reconciles through generate/aggregate/PV to a term-by-term reference", () => {
    // The synthetic anchor above prices a principal-only series. This runs a real
    // coupon-bearing bullet fixed loan through the kernel generator, the m03
    // aggregator, and pvBucketedSeries, and checks the whole chain against an
    // independent hand-rolled term-by-term PV (monthly interest = N·c/12 for
    // every month, principal N at maturity), discounted on the same all-in curve.
    const horizon = 120;
    const notional = 2_500_000;
    const coupon = 0.045;
    const maturityMonths = 84;

    const coa = makeCoa();
    const portfolio = {
      id: "PF-BULLET",
      label: "coupon bullet",
      asOf: "2026-01-01",
      coa,
      positions: [fixedPosition("CB1", { notional, coupon, maturityMonths, amortType: "bullet" as const })],
    };
    const path = new DeterministicRatePath(base, horizon);
    const cashflows = aggregateScenario(portfolio, { scenarioId: "S0", path }, { horizonMonths: horizon, asOf: "2026-01-01" });
    const fixedSeries = cashflows.byFamily.find((f) => f.familyId === "FIXED")!.series;

    const df = discountFunction(base, DEFAULT_TLP_CURVE, 0, "all-in");
    const enginePv = pvBucketedSeries(fixedSeries, df);

    // Independent reference: level monthly coupon on the full notional, plus the
    // notional bullet at maturity, each discounted at t = month/12.
    const monthlyInterest = notional * (coupon / 12);
    let refPv = 0;
    for (let m = 1; m <= maturityMonths; m++) refPv += df(m / 12) * monthlyInterest;
    refPv += df(maturityMonths / 12) * notional;

    expect(enginePv).toBeCloseTo(refPv, 2);
  });

  it("PV is linear: a doubled series has double the PV", () => {
    const horizon = 60;
    const s1: BucketedSeries = {
      balance: new Array(horizon).fill(0),
      principal: new Array(horizon).fill(0).map((_, k) => (k < 12 ? 1000 : 0)),
      interest: new Array(horizon).fill(0).map((_, k) => (k < 12 ? 40 : 0)),
    };
    const s2: BucketedSeries = {
      balance: s1.balance,
      principal: s1.principal.map((v) => 2 * v),
      interest: s1.interest.map((v) => 2 * v),
    };
    const df = discountFunction(base, ZERO_TLP, 0, "all-in");
    expect(pvBucketedSeries(s2, df)).toBeCloseTo(2 * pvBucketedSeries(s1, df), 8);
  });
});
