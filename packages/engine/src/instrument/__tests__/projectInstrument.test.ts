/**
 * The single-instrument drill on the CONTRACTUAL
 * path. One position, one scenario list, the monthly schedule the kernel
 * produces, and what that schedule is worth.
 *
 * EVERY arithmetic expectation here is RESTATED from the formula, never read
 * back from the module under test: the level-pay payment and its balance
 * recursion, the discounted sum, the principal-weighted average life, and the
 * two-sided bump. The curve seam (buildBaseCurve, shockedCurve, buildTLPCurve)
 * IS called, because the curve is an input to the drill and not its arithmetic;
 * nothing in projectInstrument.ts is called to produce an expected number.
 *
 * ABSENCE IS THE HONESTY RULE. A drill that cannot observe a WAL or a duration
 * leaves the key OUT. There is no zero-notional case to test, because every
 * kernel constructor refuses a non-positive notional; the absence case is a
 * zero-coupon bullet whose only principal falls beyond the horizon.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  buildTLPCurve,
  DEFAULT_TLP_CURVE,
  loadMarketSnapshot,
  type FixedLoanTerms,
  type FloatingLoanTerms,
  type MarketSnapshot,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import type { RateSpec, Scenario } from "../../contracts/scenario";
import { NotImplementedError } from "../../runtime/notImplemented";
import { buildBaseCurve, shockedCurve } from "../../scenario/rateEnvironment";
import { projectInstrument, ProjectInstrumentError } from "../projectInstrument";

const FIXTURE = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);

let snapshot: MarketSnapshot;
let baseCurve: ZeroCurve;
let tlp: TLPCurve;

beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
  baseCurve = buildBaseCurve(snapshot);
  // The all-in overlay rule, restated: the snapshot's own nodes when it carries
  // them, the kernel default when it does not.
  tlp = snapshot.tlpNodes.length > 0 ? buildTLPCurve(snapshot.tlpNodes) : DEFAULT_TLP_CURVE;
});

// --- Fixtures ----------------------------------------------------------------

const HORIZON = 60;

function fixedTerms(over: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return {
    id: "drill-fixed-1",
    type: "fixed-loan",
    label: "Term loan 5y",
    notional: 1_000_000,
    maturityMonths: 60,
    originationOffsetMonths: 0,
    amortType: "level-pay",
    coupon: 0.06,
    ...over,
  };
}

function floatingTerms(over: Partial<FloatingLoanTerms> = {}): FloatingLoanTerms {
  return {
    id: "drill-float-1",
    type: "floating-loan",
    label: "Floater 2y, quarterly reset",
    notional: 1_000_000,
    maturityMonths: 24,
    originationOffsetMonths: 0,
    amortType: "level-pay",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 3,
    ...over,
  };
}

function scenario(id: string, rateSpec: RateSpec): Scenario {
  return {
    id,
    label: id,
    rateSpec,
    assumptionSetId: "none",
    newBusiness: { mode: "static", rules: [] },
  };
}

// --- Restated arithmetic -----------------------------------------------------

/** The level-pay payment, restated: P = B r (1+r)^n / ((1+r)^n - 1). */
function levelPay(balance: number, monthlyRate: number, n: number): number {
  const f = Math.pow(1 + monthlyRate, n);
  return (balance * monthlyRate * f) / (f - 1);
}

interface Row {
  month: number;
  balance: number;
  principal: number;
  interest: number;
}

/** The level-pay schedule, restated from the payment and the balance recursion. */
function contractualRows(terms: FixedLoanTerms): Row[] {
  const r = terms.coupon / 12;
  const rows: Row[] = [];
  let bal = terms.notional;
  if (terms.amortType === "bullet") {
    for (let m = 1; m <= terms.maturityMonths; m++) {
      const interest = bal * r;
      const principal = m === terms.maturityMonths ? bal : 0;
      rows.push({ month: m, balance: bal, principal, interest });
      bal -= principal;
    }
    return rows;
  }
  const pay = levelPay(terms.notional, r, terms.maturityMonths);
  for (let m = 1; m <= terms.maturityMonths; m++) {
    const interest = bal * r;
    let principal = pay - interest;
    if (m === terms.maturityMonths || principal > bal) principal = bal;
    rows.push({ month: m, balance: bal, principal, interest });
    bal -= principal;
  }
  return rows;
}

/**
 * The 1M rate a deterministic monthly path carries at `step`, restated as the
 * simple forward the discount factors imply, (DF(t)/DF(t + dt) - 1)/dt: the
 * accrual convention since Lab fix A, not the curve's forward-swap (quoted)
 * convention. Restated here rather than read off a built path.
 */
function pathRateAtStep(curve: ZeroCurve, step: number): number {
  const t = step / 12;
  return (curve.discountFactor(t) / curve.discountFactor(t + 1 / 12) - 1) / (1 / 12);
}

/** The all-in discount factor, restated: DF_rf(t) times exp(-tlp(t) t). */
function dfAllIn(curve: ZeroCurve, t: number): number {
  return t <= 0 ? 1 : curve.discountFactor(t) * Math.exp(-tlp.tlp(t) * t);
}

/** The discounted sum of principal plus interest at t = month / 12. */
function pvOf(rows: Row[], horizon: number, df: (t: number) => number): number {
  let pv = 0;
  for (const row of rows) {
    if (row.month < 1 || row.month > horizon) continue;
    pv += df(row.month / 12) * (row.principal + row.interest);
  }
  return pv;
}

describe("projectInstrument, the contractual path", () => {
  it("projects the level-pay schedule the terms describe, restated here from the payment formula", () => {
    const terms = fixedTerms();
    const result = projectInstrument({
      terms,
      familyId: "fixed-loans",
      side: "asset",
      marketSnapshot: snapshot,
      scenarios: [scenario("S0", { kind: "base" })],
      horizonMonths: HORIZON,
    });

    expect(result.familyId).toBe("fixed-loans");
    expect(result.side).toBe("asset");
    expect(result.horizonMonths).toBe(HORIZON);
    expect(result.durationBumpBp).toBe(100);
    expect(result.overlayApplied).toBe("none");
    expect(result.terms).toEqual(terms);
    expect(result.byScenario).toHaveLength(1);

    const p = result.byScenario[0]!;
    expect(p.scenarioId).toBe("S0");
    expect(p.rateSpec).toEqual({ kind: "base" });
    expect(p.repricingMonths).toEqual([]);
    expect(p.rows).toHaveLength(60);

    const want = contractualRows(terms);
    const payment = levelPay(terms.notional, terms.coupon / 12, terms.maturityMonths);
    for (const m of [1, 2, 12, 59, 60]) {
      const got = p.rows[m - 1]!;
      const exp = want[m - 1]!;
      expect(got.month).toBe(m);
      expect(got.balance).toBeCloseTo(exp.balance, 6);
      expect(got.principal).toBeCloseTo(exp.principal, 6);
      expect(got.interest).toBeCloseTo(exp.interest, 6);
      expect(got.payment).toBeCloseTo(exp.principal + exp.interest, 6);
      expect(got.couponRate).toBeCloseTo(terms.coupon, 12);
    }
    // Every month but the last pays the constant level payment.
    expect(p.rows[11]!.payment).toBeCloseTo(payment, 6);
    // The balance is exhausted at maturity: the final row pays its own balance.
    const last = p.rows[59]!;
    expect(last.balance - last.principal).toBeCloseTo(0, 6);
  });

  it("prices the schedule as the discounted sum of principal plus interest, on both bases", () => {
    const terms = fixedTerms();
    const result = projectInstrument({
      terms,
      familyId: "fixed-loans",
      side: "asset",
      marketSnapshot: snapshot,
      scenarios: [scenario("S0", { kind: "base" })],
      horizonMonths: HORIZON,
    });
    const p = result.byScenario[0]!;
    const rows = contractualRows(terms);
    expect(p.pvAllIn).toBeCloseTo(pvOf(rows, HORIZON, (t) => dfAllIn(baseCurve, t)), 4);
    expect(p.pvRiskFree).toBeCloseTo(
      pvOf(rows, HORIZON, (t) => baseCurve.discountFactor(t)),
      4,
    );
  });

  it("reports WAL in MONTHS as the principal-weighted average of the row months", () => {
    const terms = fixedTerms();
    const p = projectInstrument({
      terms,
      familyId: "fixed-loans",
      side: "asset",
      marketSnapshot: snapshot,
      scenarios: [scenario("S0", { kind: "base" })],
      horizonMonths: HORIZON,
    }).byScenario[0]!;

    let num = 0;
    let den = 0;
    for (const row of contractualRows(terms)) {
      num += row.month * row.principal;
      den += row.principal;
    }
    expect(p.walMonths!).toBeCloseTo(num / den, 6);
    // A five-year level-pay loan runs off well inside its own maturity.
    expect(p.walMonths!).toBeGreaterThan(0);
    expect(p.walMonths!).toBeLessThan(terms.maturityMonths);
  });

  it("under a parallel shock moves the path rate and the PV but no balance of a fixed-rate schedule, and the duration is the bump restated here", () => {
    const terms = fixedTerms();
    const result = projectInstrument({
      terms,
      familyId: "fixed-loans",
      side: "asset",
      marketSnapshot: snapshot,
      scenarios: [scenario("S0", { kind: "base" }), scenario("S200", { kind: "parallel", shockBp: 200 })],
      horizonMonths: HORIZON,
      durationBumpBp: 100,
    });
    const base = result.byScenario[0]!;
    const up = result.byScenario[1]!;

    // Column-wise: a fixed coupon is path independent, but pathRate is not.
    expect(up.rows.map((r) => r.balance)).toEqual(base.rows.map((r) => r.balance));
    expect(up.rows.map((r) => r.principal)).toEqual(base.rows.map((r) => r.principal));
    expect(up.rows.map((r) => r.interest)).toEqual(base.rows.map((r) => r.interest));
    expect(up.rows.map((r) => r.couponRate)).toEqual(base.rows.map((r) => r.couponRate));
    expect(up.rows[0]!.pathRate).toBeGreaterThan(base.rows[0]!.pathRate);
    expect(up.pvAllIn).toBeLessThan(base.pvAllIn);

    // (PV_down - PV_up) / (2 PV_0 delta), restated on this scenario's own curve.
    const rows = contractualRows(terms);
    const curveUp = shockedCurve(baseCurve, { kind: "parallel", shockBp: 100 });
    const curveDown = shockedCurve(baseCurve, { kind: "parallel", shockBp: -100 });
    const pv0 = pvOf(rows, HORIZON, (t) => dfAllIn(baseCurve, t));
    const pvUp = pvOf(rows, HORIZON, (t) => dfAllIn(curveUp, t));
    const pvDown = pvOf(rows, HORIZON, (t) => dfAllIn(curveDown, t));
    const expected = (pvDown - pvUp) / (2 * pv0 * 0.01);
    expect(base.effectiveDuration!).toBeCloseTo(expected, 6);
    expect(base.effectiveDuration!).toBeGreaterThan(0);
  });

  it("a floating loan reprices on its reset months and holds the coupon between them", () => {
    const terms = floatingTerms();
    const p = projectInstrument({
      terms,
      familyId: "floating-loans",
      side: "asset",
      marketSnapshot: snapshot,
      scenarios: [scenario("S0", { kind: "base" })],
      horizonMonths: 24,
    }).byScenario[0]!;

    expect(p.repricingMonths).toEqual([1, 4, 7, 10, 13, 16, 19, 22]);
    expect(p.rows).toHaveLength(24);
    // On a reset month the coupon is that month's path rate plus the margin.
    for (const m of p.repricingMonths) {
      const row = p.rows[m - 1]!;
      expect(row.couponRate).toBeCloseTo(row.pathRate + terms.margin, 12);
    }
    // Between resets the coupon is the one the last reset set, which is NOT
    // this month's path rate plus the margin on an upward-sloping curve.
    for (const m of [2, 3]) {
      const row = p.rows[m - 1]!;
      expect(row.couponRate).toBeCloseTo(p.rows[0]!.couponRate, 12);
      expect(row.couponRate).not.toBeCloseTo(row.pathRate + terms.margin, 8);
    }
  });

  it("refuses a dynamic scenario, a non-integer or non-positive horizon, and a non-positive bump", () => {
    const common = {
      terms: fixedTerms(),
      familyId: "fixed-loans",
      side: "asset" as const,
      marketSnapshot: snapshot,
      horizonMonths: HORIZON,
    };
    const dynamic: Scenario = {
      id: "SDYN",
      label: "dynamic",
      rateSpec: { kind: "base" },
      assumptionSetId: "none",
      newBusiness: { mode: "dynamic", rules: [] },
    };
    expect(() => projectInstrument({ ...common, scenarios: [dynamic] })).toThrow(NotImplementedError);
    expect(() => projectInstrument({ ...common, scenarios: [dynamic] })).toThrow(
      /static runoff requires mode "static"/,
    );

    const ok = [scenario("S0", { kind: "base" })];
    expect(() =>
      projectInstrument({ ...common, scenarios: ok, horizonMonths: 0 }),
    ).toThrow(ProjectInstrumentError);
    expect(() =>
      projectInstrument({ ...common, scenarios: ok, horizonMonths: 12.5 }),
    ).toThrow(/horizonMonths/);
    expect(() =>
      projectInstrument({ ...common, scenarios: ok, durationBumpBp: 0 }),
    ).toThrow(ProjectInstrumentError);
    expect(() =>
      projectInstrument({ ...common, scenarios: ok, durationBumpBp: Number.NaN }),
    ).toThrow(/durationBumpBp/);
  });

  it("refuses a schedule that carries a non-finite number rather than publishing it", () => {
    // The kernel constructors refuse a non-positive notional and a non-positive
    // maturity; they do NOT refuse a coupon that is not a number, and the
    // level-pay recursion carries that NaN into every row and into both present
    // values. Absence is the honesty rule for what cannot be OBSERVED; a NaN is
    // arithmetic that did not happen, so it is refused, not left out.
    const thrown = (): void => {
      projectInstrument({
        terms: fixedTerms({ coupon: Number.NaN }),
        familyId: "fixed-loans",
        side: "asset",
        marketSnapshot: snapshot,
        scenarios: [scenario("S0", { kind: "base" })],
        horizonMonths: HORIZON,
      });
    };
    expect(thrown).toThrow(ProjectInstrumentError);
    expect(thrown).toThrow(/the schedule carries a non-finite number/);
    let field: string | undefined;
    try {
      thrown();
    } catch (err) {
      field = err instanceof ProjectInstrumentError ? err.field : undefined;
    }
    expect(field).toBe("terms");
  });

  it("refuses a horizon past the 360-month cap the plan gate applies to a run", () => {
    // The cap is stated once, in plan/typeGate's MAX_HORIZON, and restated here
    // as the literal 360 so this test would catch a change to that constant
    // rather than moving with it.
    const common = {
      terms: fixedTerms(),
      familyId: "fixed-loans",
      side: "asset" as const,
      marketSnapshot: snapshot,
      scenarios: [scenario("S0", { kind: "base" })],
    };
    expect(() => projectInstrument({ ...common, horizonMonths: 361 })).toThrow(
      ProjectInstrumentError,
    );
    expect(() => projectInstrument({ ...common, horizonMonths: 361 })).toThrow(/horizonMonths/);
    // The cap itself is accepted: the refusal is strictly ABOVE it.
    expect(projectInstrument({ ...common, horizonMonths: 360 }).horizonMonths).toBe(360);
  });

  it("leaves walMonths and effectiveDuration OUT when the horizon carries no cash at all", () => {
    // Every kernel instrument refuses a non-positive notional, so the absent
    // case is a zero-coupon bullet whose only principal falls beyond the
    // horizon: in-horizon principal and interest are both exactly 0.
    const terms = fixedTerms({ amortType: "bullet", coupon: 0, maturityMonths: 120 });
    const p = projectInstrument({
      terms,
      familyId: "fixed-loans",
      side: "asset",
      marketSnapshot: snapshot,
      scenarios: [scenario("S0", { kind: "base" })],
      horizonMonths: 12,
    }).byScenario[0]!;

    expect(p.rows).toHaveLength(12);
    expect(p.rows.every((r) => r.principal === 0 && r.interest === 0)).toBe(true);
    expect(p.pvAllIn).toBe(0);
    expect(p.pvRiskFree).toBe(0);
    expect("walMonths" in p).toBe(false);
    expect("effectiveDuration" in p).toBe(false);
  });

  it("on a seasoned position reads pathRate at the UNSHIFTED step the kernel actually read", () => {
    // fixed-loan is the only type seasoningOffsetOf re-anchors; every other type
    // throws SeasoningError and carries its age another way.
    const terms = fixedTerms({ originationOffsetMonths: -12 });
    const p = projectInstrument({
      terms,
      familyId: "fixed-loans",
      side: "asset",
      marketSnapshot: snapshot,
      scenarios: [scenario("S0", { kind: "base" })],
      horizonMonths: HORIZON,
    }).byScenario[0]!;

    // A year of the loan is already elapsed: its months 13 to 60 land on as-of
    // months 1 to 48, and the twelve elapsed months are dropped, not stacked.
    expect(p.rows).toHaveLength(48);
    expect(p.rows[0]!.month).toBe(1);
    expect(p.rows[47]!.month).toBe(48);

    const want = contractualRows(fixedTerms());
    for (const k of [1, 2, 24, 48]) {
      const got = p.rows[k - 1]!;
      const exp = want[k + 12 - 1]!;
      expect(got.month).toBe(k);
      expect(got.balance).toBeCloseTo(exp.balance, 6);
      expect(got.principal).toBeCloseTo(exp.principal, 6);
      expect(got.interest).toBeCloseTo(exp.interest, 6);
      // The kernel was handed the path as-is and read it in instrument time, so
      // the rate behind as-of month k is the one at step (k + 12) - 1.
      expect(got.pathRate).toBeCloseTo(pathRateAtStep(baseCurve, k + 12 - 1), 12);
    }
    // And it is NOT the rate at the shifted step, which is what a naive
    // as-of-month read would have reported.
    expect(p.rows[0]!.pathRate).not.toBeCloseTo(pathRateAtStep(baseCurve, 0), 8);
  });

  it("refuses an empty scenario list", () => {
    const call = () =>
      projectInstrument({
        terms: fixedTerms(),
        familyId: "fixed-loans",
        side: "asset",
        marketSnapshot: snapshot,
        scenarios: [],
        horizonMonths: HORIZON,
      });
    expect(call).toThrow(ProjectInstrumentError);
    expect(call).toThrow(/scenarios/);
  });

  it("answers one projection per scenario in request order, and is byte-identical across calls", () => {
    const input = {
      terms: fixedTerms(),
      familyId: "fixed-loans",
      side: "asset" as const,
      marketSnapshot: snapshot,
      scenarios: [
        scenario("S0", { kind: "base" as const }),
        scenario("S100", { kind: "parallel" as const, shockBp: 100 }),
        scenario("S-100", { kind: "parallel" as const, shockBp: -100 }),
      ],
      horizonMonths: HORIZON,
    };
    const a = projectInstrument(input);
    const b = projectInstrument(input);
    expect(a.byScenario.map((s) => s.scenarioId)).toEqual(["S0", "S100", "S-100"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
