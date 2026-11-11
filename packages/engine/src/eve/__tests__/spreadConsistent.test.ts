/**
 * Spread-consistent discount basis.
 *
 *   DF_i(t) = DF_rf(t) * exp(-(tlp(t) + s_i) t),  s_i = discountSpreadBp / 1e4
 *
 * read per position, 0 when absent, and forced 0 for nmd and nmd-b terms and
 * for every child of the regulatory transform (a position carrying
 * parentPositionId). Pins:
 *  - the discount function itself, and that spread 0 is the all-in function;
 *  - a one-position fixed-loan book with 250bp prices, in the headline PV, in
 *    the duration legs and in the key-rate legs, at the all-in PV of the same
 *    cash flows with an extra exp(-0.025 t), recomputed here by hand;
 *  - a deposit carrying a spread by mistake prices identically under all-in
 *    and spread-consistent (Review Focus 4);
 *  - all-in ignores the field entirely, so an all-in run is unchanged by it;
 *  - a family mixing two spreads is refused by name rather than priced on one;
 *  - the run context's discountBasis reaches the EVE block and is echoed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TLP_CURVE,
  DeterministicRatePath,
  loadMarketSnapshot,
  type Cashflow,
  type MarketSnapshot,
  type ZeroCurve,
} from "@alm/kernel";
import type { PortfolioSpec, Position } from "../../contracts/position";
import { buildBaseCurve, shockedCurve } from "../../scenario/rateEnvironment";
import {
  buildScenarioRatePath,
  projectStaticRunoffAll,
  type StaticScenarioLeg,
} from "../../projection/static/staticRunoff";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { computeEve } from "../computeEve";
import { discountFunction, positionDiscountSpreadBp } from "../discount";
import { computeEnvironmentDurations } from "../effectiveDuration";
import { collectSidedPositions, regeneratedEve } from "../keyRate";
import {
  fixedPosition,
  makePortfolio,
  nmdBetaPosition,
  nmdPosition,
  regulatoryScenarios,
  AS_OF,
} from "./fixtures";
import { resolveDefaultContext } from "../../run/engine";
import { buildRunResult } from "../../run/orchestrate";
import { makeRunRequest, twoSidedBook } from "../../run/__tests__/fixtures";

const MARKET = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);
const HORIZON = 360;
const GRID = { horizonMonths: HORIZON, asOf: AS_OF };
const SPREAD_BP = 250;

let market: MarketSnapshot;
let base: ZeroCurve;
beforeAll(async () => {
  market = await loadMarketSnapshot(MARKET);
  base = buildBaseCurve(market);
});

function project(portfolio: PortfolioSpec) {
  const scenarios = regulatoryScenarios();
  const legs: StaticScenarioLeg[] = scenarios.map((scenario) => ({
    scenario,
    ratePath: buildScenarioRatePath(base, scenario, HORIZON),
  }));
  return { scenarios, cashflows: projectStaticRunoffAll(portfolio, legs, GRID) };
}

/** Hand PV: DF_rf(t) exp(-tlp(t) t) exp(-s t) on the kernel's own cash flows, t = monthOffset / 12. */
function handPv(cfs: Cashflow[], curve: ZeroCurve, spreadBp: number): number {
  const s = spreadBp / 1e4;
  let pv = 0;
  for (const cf of cfs) {
    const t = cf.monthOffset / 12;
    const allIn = curve.discountFactor(t) * Math.exp(-DEFAULT_TLP_CURVE.tlp(t) * t);
    pv += allIn * Math.exp(-s * t) * (cf.principalPaid + cf.interestPaid);
  }
  return pv;
}

function loanBook(spreadBp: number | undefined): PortfolioSpec {
  const pos = fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 });
  return makePortfolio([spreadBp === undefined ? pos : { ...pos, discountSpreadBp: spreadBp }]);
}

function relErr(a: number, b: number): number {
  return Math.abs(a - b) / Math.abs(b);
}

describe("discountFunction: the spread-consistent basis", () => {
  it("is the all-in factor times exp(-s t), on the base leg and under a shock", () => {
    for (const shockBp of [0, 100, -200]) {
      const allIn = discountFunction(base, DEFAULT_TLP_CURVE, shockBp, "all-in");
      const sc = discountFunction(base, DEFAULT_TLP_CURVE, shockBp, "spread-consistent", SPREAD_BP);
      for (const t of [0.25, 1, 5, 12.5, 30]) {
        expect(relErr(sc(t), allIn(t) * Math.exp(-0.025 * t))).toBeLessThan(1e-12);
      }
      expect(sc(0)).toBe(1);
    }
  });

  it("with spread 0 returns exactly the all-in factor, and all-in ignores a spread", () => {
    const allIn = discountFunction(base, DEFAULT_TLP_CURVE, 0, "all-in");
    const sc0 = discountFunction(base, DEFAULT_TLP_CURVE, 0, "spread-consistent", 0);
    const allInWithSpread = discountFunction(base, DEFAULT_TLP_CURVE, 0, "all-in", SPREAD_BP);
    for (const t of [0.5, 2, 10, 30]) {
      expect(sc0(t)).toBe(allIn(t));
      expect(allInWithSpread(t)).toBe(allIn(t));
    }
  });
});

describe("positionDiscountSpreadBp: the spread a position discounts at", () => {
  it("reads the field, defaults to 0, and forces 0 for deposits and transform children", () => {
    expect(positionDiscountSpreadBp({ ...fixedPosition("F1"), discountSpreadBp: 250 })).toBe(250);
    expect(positionDiscountSpreadBp(fixedPosition("F2"))).toBe(0);
    expect(positionDiscountSpreadBp({ ...nmdBetaPosition("B1"), discountSpreadBp: 250 })).toBe(0);
    expect(positionDiscountSpreadBp({ ...nmdPosition("D1"), discountSpreadBp: 250 })).toBe(0);
    const child: Position = { ...fixedPosition("B1-noncore"), discountSpreadBp: 250, parentPositionId: "B1" };
    expect(positionDiscountSpreadBp(child)).toBe(0);
  });

  it("refuses a non-finite spread by naming the position and the field", () => {
    expect(() => positionDiscountSpreadBp({ ...fixedPosition("F9"), discountSpreadBp: Number.NaN })).toThrow(
      /position "F9".*discountSpreadBp/,
    );
  });
});

describe("computeEve: spread-consistent headline PV", () => {
  it("a 250bp fixed loan prices at the all-in PV with an extra exp(-0.025 t), by hand within 1e-9", () => {
    const book = loanBook(SPREAD_BP);
    const { scenarios, cashflows } = project(book);
    const result = computeEve({
      portfolio: book, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE,
      discountBasis: "spread-consistent",
    });
    expect(result.discountBasis).toBe("spread-consistent");
    for (const id of ["S0", "S200", "S-100"]) {
      const scenario = scenarios.find((s) => s.id === id)!;
      const curve = shockedCurve(base, scenario.rateSpec);
      const cfs = makeInstrument(book.positions[0]!.terms).generateCashflows(buildScenarioRatePath(base, scenario, HORIZON));
      const row = result.byScenario.find((r) => r.scenarioId === id)!;
      const fam = row.byFamily.find((f) => f.familyId === "FIXED")!;
      expect(relErr(fam.pv, handPv(cfs, curve, SPREAD_BP))).toBeLessThan(1e-9);
      expect(relErr(row.pvAssets, handPv(cfs, curve, SPREAD_BP))).toBeLessThan(1e-9);
      // And the spread really bites: strictly below the all-in PV of the same flows.
      expect(fam.pv).toBeLessThan(handPv(cfs, curve, 0));
    }
  });

  it("an nmd-b position given 250bp by mistake prices identically under all-in and spread-consistent", () => {
    const book = makePortfolio([
      fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }),
      { ...nmdBetaPosition("B1", { notional: 2_000_000 }), discountSpreadBp: SPREAD_BP },
      { ...nmdPosition("D1", { notional: 3_000_000 }), discountSpreadBp: SPREAD_BP },
    ]);
    const { scenarios, cashflows } = project(book);
    const inputs = { portfolio: book, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE };
    const allIn = computeEve({ ...inputs, discountBasis: "all-in" });
    const sc = computeEve({ ...inputs, discountBasis: "spread-consistent" });
    for (let i = 0; i < allIn.byScenario.length; i++) {
      const a = allIn.byScenario[i]!;
      const s = sc.byScenario[i]!;
      expect(s.pvLiabilities).toBe(a.pvLiabilities);
      for (const familyId of ["MMA", "DDA"]) {
        const fa = a.byFamily.find((f) => f.familyId === familyId)!;
        const fs = s.byFamily.find((f) => f.familyId === familyId)!;
        expect(fs.pv).toBe(fa.pv);
        expect(fs.effectiveDuration).toBe(fa.effectiveDuration);
      }
    }
  });

  it("all-in and risk-free ignore the field: a book with spreads prices exactly as the book without", () => {
    const withSpread = loanBook(SPREAD_BP);
    const without = loanBook(undefined);
    for (const discountBasis of ["all-in", "risk-free"] as const) {
      const a = project(withSpread);
      const b = project(without);
      const ra = computeEve({ portfolio: withSpread, ...a, baseCurve: base, tlp: DEFAULT_TLP_CURVE, discountBasis });
      const rb = computeEve({ portfolio: without, ...b, baseCurve: base, tlp: DEFAULT_TLP_CURVE, discountBasis });
      expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
    }
  });

  it("refuses a family that mixes two spreads, naming the family and the field", () => {
    const book = makePortfolio([
      { ...fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }), discountSpreadBp: 250 },
      { ...fixedPosition("F2", { notional: 1_000_000, coupon: 0.04, maturityMonths: 36 }), discountSpreadBp: 100 },
    ]);
    const { scenarios, cashflows } = project(book);
    const inputs = { portfolio: book, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE };
    expect(() => computeEve({ ...inputs, discountBasis: "spread-consistent" })).toThrow(/family "FIXED".*discountSpreadBp/);
    expect(() => computeEve({ ...inputs, discountBasis: "all-in" })).not.toThrow();
  });
});

describe("duration and key-rate legs: the per-position spread", () => {
  it("the effective-duration legs discount each position at its own spread", () => {
    const book = loanBook(SPREAD_BP);
    const pos = book.positions[0]!;
    const fam = { family: book.coa.families.find((f) => f.id === "FIXED")!, positions: [pos] };
    const d = computeEnvironmentDurations([fam], base, DEFAULT_TLP_CURVE, HORIZON, 100, "spread-consistent");
    const path = new DeterministicRatePath(base, HORIZON);
    const inst = makeInstrument(pos.terms);
    const pv0 = handPv(inst.generateCashflows(path), base, SPREAD_BP);
    expect(relErr(d.perFamily[0]!.pvBase, pv0)).toBeLessThan(1e-9);
    const up = handPv(inst.generateCashflows(path), shockedCurve(base, { kind: "parallel", shockBp: 100 }), SPREAD_BP);
    const dn = handPv(inst.generateCashflows(path), shockedCurve(base, { kind: "parallel", shockBp: -100 }), SPREAD_BP);
    expect(relErr(d.perFamily[0]!.effectiveDuration, (dn - up) / (2 * pv0 * 0.01))).toBeLessThan(1e-9);
  });

  it("the key-rate regenerated EVE discounts each position at its own spread", () => {
    const book = loanBook(SPREAD_BP);
    const eve = regeneratedEve(collectSidedPositions(book), base, DEFAULT_TLP_CURVE, "spread-consistent", HORIZON, [], 0);
    const cfs = makeInstrument(book.positions[0]!.terms).generateCashflows(new DeterministicRatePath(base, HORIZON));
    expect(relErr(eve, handPv(cfs, base, SPREAD_BP))).toBeLessThan(1e-9);
    const allIn = regeneratedEve(collectSidedPositions(book), base, DEFAULT_TLP_CURVE, "all-in", HORIZON, [], 0);
    expect(relErr(allIn, handPv(cfs, base, 0))).toBeLessThan(1e-9);
  });
});

describe("run pipeline: context discountBasis", () => {
  function spreadBook(): PortfolioSpec {
    const book = twoSidedBook();
    return {
      ...book,
      positions: book.positions.map((p) => (p.familyId === "FIXED" ? { ...p, discountSpreadBp: SPREAD_BP } : p)),
    };
  }

  it("reaches the EVE block, is echoed, and lowers the spread family's PV", () => {
    const req = makeRunRequest(market);
    const sc = buildRunResult(req, spreadBook(), { ...resolveDefaultContext(), discountBasis: "spread-consistent" });
    const allIn = buildRunResult(req, spreadBook(), resolveDefaultContext());
    expect(sc.eve.discountBasis).toBe("spread-consistent");
    expect(allIn.eve.discountBasis).toBe("all-in");
    const pv = (r: typeof sc, fam: string) =>
      r.eve.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((f) => f.familyId === fam)!.pv;
    expect(pv(sc, "FIXED")).toBeLessThan(pv(allIn, "FIXED"));
    expect(pv(sc, "MMA")).toBe(pv(allIn, "MMA"));
    expect(pv(sc, "DDA")).toBe(pv(allIn, "DDA"));
  });

  it("reaches the opt-in channel block too, so the EVE blocks report one basis", () => {
    const req = makeRunRequest(market);
    const sc = buildRunResult(req, spreadBook(), {
      ...resolveDefaultContext(), discountBasis: "spread-consistent", eveChannels: true,
    });
    expect(sc.eve.channels!.discountBasis).toBe("spread-consistent");
  });

  it("a run without the field is unchanged by a book's spreads", () => {
    const req = makeRunRequest(market);
    const withSpread = buildRunResult(req, spreadBook(), resolveDefaultContext());
    const without = buildRunResult(req, twoSidedBook(), resolveDefaultContext());
    expect(JSON.stringify(withSpread.eve)).toBe(JSON.stringify(without.eve));
  });
});
