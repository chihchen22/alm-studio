/**
 * Dynamic new-business / reinvestment acceptance tests.
 *
 * The correctness signal is the kernel itself: the existing book runs off
 * through the m03 aggregator (the kernel math), and reinvestment tranches are
 * kernel fixed-loan instruments minted by the m01 factory. These tests exercise
 * this module's reinvestment sweep, bucket-shift, target logic, and shortfall
 * reporting, never a retyped constant.
 *
 * Coverage against the acceptance criteria:
 *  - flat mode holds the family balance constant month over month;
 *  - growth mode hits monthlyGrowthRate;
 *  - runoff mode reinvests exactly the maturing principal;
 *  - an unreachable (declining) target reports a shortfall, not a silent miss;
 *  - a new-business coupon equals index + spread at origination;
 *  - the mode guard rejects a static scenario;
 *  - families with no rule are untouched and the COA roll-up stays consistent.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  loadMarketSnapshot,
  type MarketSnapshot,
  type ZeroCurve,
} from "@alm/kernel";
import { buildBaseCurve } from "../../../scenario/rateEnvironment";
import { buildScenarioRatePath } from "../../static";
import { aggregateScenario } from "../../../portfolio/aggregate";
import type { BucketGrid } from "../../../contracts/results";
import type { NewBusinessRule, Scenario } from "../../../contracts/scenario";
import {
  makePortfolio,
  makeCoa,
  fixedPosition,
  mortgagePosition,
  AS_OF,
} from "../../../portfolio/__tests__/fixtures";
import {
  DEFAULT_NEW_BUSINESS_TERM_MONTHS,
  reinvestmentCoupon,
  sweepFamilyReinvestment,
  projectDynamicScenario,
} from "../dynamicNewBusiness";

const FIXTURE = fileURLToPath(
  new URL("../../../../../kernel/public/market_public.json", import.meta.url),
);

const HORIZON = 120;
const GRID: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };

function dynamicScenario(id: string, shockBp: number, rules: NewBusinessRule[]): Scenario {
  return {
    id,
    label: id,
    rateSpec: shockBp === 0 ? { kind: "base" } : { kind: "parallel", shockBp },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "dynamic", rules },
  };
}

const FIXED_FAMILY = makeCoa().families.find((f) => f.id === "FIXED")!;

let snapshot: MarketSnapshot;
let base: ZeroCurve;

beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
  base = buildBaseCurve(snapshot);
});

/** The FIXED family's aggregated series (existing book only) under a base path. */
function fixedBaseSeries(portfolio = makePortfolio([fixedPosition("F1")])) {
  const scn = dynamicScenario("BASE", 0, []);
  const path = buildScenarioRatePath(base, scn, HORIZON);
  const agg = aggregateScenario(portfolio, { scenarioId: "BASE", path }, GRID);
  return { series: agg.byFamily.find((f) => f.familyId === "FIXED")!.series, path };
}

describe("reinvestment coupon = index + spread at origination", () => {
  it("equals the path forward-swap index plus the rule spread", () => {
    const scn = dynamicScenario("BASE", 0, []);
    const path = buildScenarioRatePath(base, scn, HORIZON);
    const term = 36;
    const spreadBp = 150;
    for (const step of [0, 1, 12, 48]) {
      const index = path.forwardRateAt(step, term / 12);
      expect(reinvestmentCoupon(path, step, term, spreadBp)).toBeCloseTo(index + spreadBp / 1e4, 12);
    }
  });

  it("prices a minted tranche's first-month interest at that coupon", () => {
    const { series, path } = fixedBaseSeries();
    const rule: NewBusinessRule = {
      familyId: "FIXED",
      reinvest: "flat",
      termMonths: 36,
      spreadOverIndexBp: 150,
    };
    const swept = sweepFamilyReinvestment(series, rule, path, FIXED_FAMILY, HORIZON);
    // The tranche minted at bucket 1 pays interest = notional * coupon / 12 into
    // bucket 1 (its monthOffset 1). No existing-book tranche touches bucket 1, so
    // the delta interest there is exactly that tranche's first accrual.
    const coupon = reinvestmentCoupon(path, 1, 36, 150);
    expect(swept.originations[1]).toBeGreaterThan(0);
    expect(swept.delta.interest[1]).toBeCloseTo((swept.originations[1] * coupon) / 12, 6);
  });
});

describe("flat mode holds month-over-month balance constant", () => {
  it("keeps the family balance at its month-zero level across the horizon", () => {
    const rule: NewBusinessRule = { familyId: "FIXED", reinvest: "flat", termMonths: 24 };
    const scn = dynamicScenario("FLAT", 0, [rule]);
    const path = buildScenarioRatePath(base, scn, HORIZON);
    const res = projectDynamicScenario(makePortfolio([fixedPosition("F1")]), { scenario: scn, ratePath: path }, GRID);

    const bal = res.cashflows.byFamily.find((f) => f.familyId === "FIXED")!.series.balance;
    const b0 = bal[0];
    expect(b0).toBeGreaterThan(0);
    const tol = b0 * 1e-6;
    for (let k = 0; k < HORIZON; k++) {
      expect(Math.abs(bal[k] - b0)).toBeLessThan(tol);
    }
    expect(res.shortfalls).toEqual([]); // a flat target is always reachable
  });
});

describe("growth mode hits the monthly growth rate", () => {
  it("grows the family balance at monthlyGrowthRate each month", () => {
    const g = 0.005;
    const rule: NewBusinessRule = {
      familyId: "FIXED",
      reinvest: "growth",
      monthlyGrowthRate: g,
      termMonths: 60,
    };
    const scn = dynamicScenario("GROWTH", 0, [rule]);
    const path = buildScenarioRatePath(base, scn, HORIZON);
    const res = projectDynamicScenario(makePortfolio([fixedPosition("F1")]), { scenario: scn, ratePath: path }, GRID);

    const bal = res.cashflows.byFamily.find((f) => f.familyId === "FIXED")!.series.balance;
    const b0 = bal[0];
    for (let k = 0; k < HORIZON; k++) {
      const target = b0 * Math.pow(1 + g, k);
      expect(Math.abs(bal[k] - target)).toBeLessThan(target * 1e-6);
    }
    expect(res.shortfalls).toEqual([]); // non-negative growth is always reachable
  });
});

describe("runoff mode reinvests exactly the maturing principal", () => {
  it("originates the matured principal one bucket after each maturity, and nothing before", () => {
    // A single 12-month bullet: all principal returns at its maturity (bucket 11),
    // and is reinvested at bucket 12 into a 24-month bullet that matures at bucket
    // 35, reinvested at bucket 36, and so on — a clean reinvestment ladder.
    const portfolio = makePortfolio([
      fixedPosition("F1", { amortType: "bullet", maturityMonths: 12 }),
    ]);
    const { series, path } = fixedBaseSeries(portfolio);
    const rule: NewBusinessRule = { familyId: "FIXED", reinvest: "runoff", termMonths: 24 };
    const swept = sweepFamilyReinvestment(series, rule, path, FIXED_FAMILY, HORIZON);

    const notional = series.balance[0];
    // Nothing reinvested before the first maturity.
    for (let k = 1; k <= 11; k++) expect(swept.originations[k]).toBe(0);
    // Exactly the matured principal, reinvested one bucket after each maturity.
    expect(swept.originations[12]).toBeCloseTo(notional, 6);
    expect(swept.originations[36]).toBeCloseTo(notional, 6);
    expect(swept.originations[60]).toBeCloseTo(notional, 6);
    // No shortfall: reinvesting runoff is always achievable.
    expect(swept.shortfall).toBeNull();
  });

  it("holds the balance flat as a consequence of full reinvestment", () => {
    const rule: NewBusinessRule = { familyId: "FIXED", reinvest: "runoff", termMonths: 24 };
    const scn = dynamicScenario("RUNOFF", 0, [rule]);
    const path = buildScenarioRatePath(base, scn, HORIZON);
    const res = projectDynamicScenario(makePortfolio([fixedPosition("F1")]), { scenario: scn, ratePath: path }, GRID);
    const bal = res.cashflows.byFamily.find((f) => f.familyId === "FIXED")!.series.balance;
    const b0 = bal[0];
    for (let k = 0; k < HORIZON; k++) expect(Math.abs(bal[k] - b0)).toBeLessThan(b0 * 1e-6);
  });
});

describe("unreachable target reports a shortfall", () => {
  it("under-hits a declining target the book cannot run off to, and reports the gap", () => {
    // A 120-month bullet does not run off within a 60-month horizon, so a book
    // told to SHRINK 5%/month cannot be shrunk without disposals: the strategy
    // clamps origination at zero and the balance stays put. The miss is reported.
    const horizon = 60;
    const grid: BucketGrid = { horizonMonths: horizon, asOf: AS_OF };
    const portfolio = makePortfolio([
      fixedPosition("F1", { amortType: "bullet", maturityMonths: 120 }),
    ]);
    const rule: NewBusinessRule = {
      familyId: "FIXED",
      reinvest: "growth",
      monthlyGrowthRate: -0.05,
      termMonths: 24,
    };
    const scn = dynamicScenario("DECLINE", 0, [rule]);
    const path = buildScenarioRatePath(base, scn, horizon);
    const res = projectDynamicScenario(portfolio, { scenario: scn, ratePath: path }, grid);

    expect(res.shortfalls).toHaveLength(1);
    const sf = res.shortfalls[0];
    expect(sf.familyId).toBe("FIXED");
    expect(sf.reinvest).toBe("growth");
    expect(sf.firstBucket).toBe(1);
    expect(sf.clampedBuckets).toBe(horizon - 1);
    // The book is held at its notional, far above the collapsed target.
    const notional = res.cashflows.byFamily.find((f) => f.familyId === "FIXED")!.series.balance[0];
    expect(sf.achievedBalanceEnd).toBeCloseTo(notional, 6);
    expect(sf.targetBalanceEnd).toBeLessThan(notional);
    expect(sf.balanceGapEnd).toBeGreaterThan(0);
  });
});

describe("mode guard", () => {
  it("rejects a static scenario rather than treating it as a no-op reinvestment", () => {
    const portfolio = makePortfolio([fixedPosition("F1")]);
    const scn: Scenario = {
      id: "STAT",
      label: "static",
      rateSpec: { kind: "base" },
      assumptionSetId: "AS-BASE",
      newBusiness: { mode: "static", rules: [] },
    };
    const path = buildScenarioRatePath(base, scn, HORIZON);
    expect(() => projectDynamicScenario(portfolio, { scenario: scn, ratePath: path }, GRID)).toThrow(
      /dynamic reinvestment requires mode "dynamic"/,
    );
  });
});

describe("integration with static runoff and COA roll-up", () => {
  it("leaves a ruleless family identical to its static runoff and keeps the roll-up consistent", () => {
    const portfolio = makePortfolio([
      fixedPosition("F1"),
      mortgagePosition("M1", { maturityMonths: 300 }),
    ]);
    const rule: NewBusinessRule = { familyId: "FIXED", reinvest: "flat", termMonths: 60 };
    const scn = dynamicScenario("MIX", 0, [rule]);
    const path = buildScenarioRatePath(base, scn, HORIZON);

    const dyn = projectDynamicScenario(portfolio, { scenario: scn, ratePath: path }, GRID);
    const stat = aggregateScenario(portfolio, { scenarioId: "MIX", path }, GRID);

    // MORTGAGE has no rule: byte-identical to the static aggregate.
    const dynMtg = dyn.cashflows.byFamily.find((f) => f.familyId === "MORTGAGE")!.series;
    const statMtg = stat.byFamily.find((f) => f.familyId === "MORTGAGE")!.series;
    expect(dynMtg).toEqual(statMtg);

    // FIXED has a flat rule: its balance is held flat, strictly above static runoff.
    const dynFixed = dyn.cashflows.byFamily.find((f) => f.familyId === "FIXED")!.series;
    const statFixed = stat.byFamily.find((f) => f.familyId === "FIXED")!.series;
    expect(dynFixed.balance[HORIZON - 1]).toBeGreaterThan(statFixed.balance[HORIZON - 1]);

    // The 'loans' roll-up node equals the sum of its two family leaves, post-reinvestment.
    const loans = dyn.cashflows.byCoaNode.find((n) => n.coaNodeId === "loans")!.series;
    for (let k = 0; k < HORIZON; k++) {
      expect(loans.balance[k]).toBeCloseTo(dynFixed.balance[k] + dynMtg.balance[k], 6);
      expect(loans.interest[k]).toBeCloseTo(dynFixed.interest[k] + dynMtg.interest[k], 6);
      expect(loans.principal[k]).toBeCloseTo(dynFixed.principal[k] + dynMtg.principal[k], 6);
    }
    // The assets root also reflects the reinvestment (both leaves live under it).
    const assets = dyn.cashflows.byCoaNode.find((n) => n.coaNodeId === "assets")!.series;
    for (let k = 0; k < HORIZON; k++) {
      expect(assets.balance[k]).toBeCloseTo(loans.balance[k], 6);
    }
  });

  it("is deterministic: two runs of the same request are byte-identical", () => {
    const portfolio = makePortfolio([fixedPosition("F1")]);
    const rule: NewBusinessRule = { familyId: "FIXED", reinvest: "growth", monthlyGrowthRate: 0.003 };
    const scn = dynamicScenario("DET", 0, [rule]);
    const path = buildScenarioRatePath(base, scn, HORIZON);
    const a = projectDynamicScenario(portfolio, { scenario: scn, ratePath: path }, GRID);
    const b = projectDynamicScenario(portfolio, { scenario: scn, ratePath: path }, GRID);
    expect(a).toEqual(b);
  });

  it("defaults the tranche term to DEFAULT_NEW_BUSINESS_TERM_MONTHS when a rule omits it", () => {
    const { series, path } = fixedBaseSeries();
    const rule: NewBusinessRule = { familyId: "FIXED", reinvest: "flat" };
    const swept = sweepFamilyReinvestment(series, rule, path, FIXED_FAMILY, HORIZON);
    // The month-1 tranche interest must price at the default-term coupon.
    const coupon = reinvestmentCoupon(path, 1, DEFAULT_NEW_BUSINESS_TERM_MONTHS, 0);
    expect(swept.delta.interest[1]).toBeCloseTo((swept.originations[1] * coupon) / 12, 6);
  });
});
