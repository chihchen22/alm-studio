/**
 * Static runoff acceptance tests.
 *
 * The Lab cross-check is the strongest correctness signal of the whole build:
 * it imports @alm/kernel directly for the single-instrument reference values (the
 * kernel IS the Lab math), so the check exercises this module's aggregation and
 * scenario wiring, not a retyped constant. A seasoned mortgage under base and
 * +100 must reproduce the kernel's runoff exactly, including the prepayment
 * response to the shocked path.
 *
 * Also asserts: base-scenario cash flows are internally consistent with the m03
 * base aggregate, and runoff never produces a negative outstanding balance.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  loadMarketSnapshot,
  Mortgage,
  type Cashflow,
  type MarketSnapshot,
  type RatePath,
  type ZeroCurve,
} from "@alm/kernel";
import { buildBaseCurve } from "../../../scenario/rateEnvironment";
import { aggregateScenario } from "../../../portfolio/aggregate";
import type { PortfolioSpec } from "../../../contracts/position";
import type { BucketGrid } from "../../../contracts/results";
import type { Scenario } from "../../../contracts/scenario";
import {
  makePortfolio,
  mortgagePosition,
  fixedPosition,
  mortgageTerms,
  AS_OF,
} from "../../../portfolio/__tests__/fixtures";
import {
  buildScenarioRatePath,
  findNegativeBalance,
  projectStaticScenario,
} from "../staticRunoff";

const FIXTURE = fileURLToPath(
  new URL("../../../../../kernel/public/market_public.json", import.meta.url),
);

const HORIZON = 360;
const GRID: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };

/** A static scenario over the shared base assumption set (no overlays here). */
function staticScenario(id: string, shockBp: number): Scenario {
  return {
    id,
    label: id,
    rateSpec: shockBp === 0 ? { kind: "base" } : { kind: "parallel", shockBp },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "static", rules: [] },
  };
}

/** Bucket a single instrument's cashflows exactly as aggregate.ts does. */
function bucketReference(cfs: Cashflow[], horizon: number) {
  const balance = new Float64Array(horizon);
  const principal = new Float64Array(horizon);
  const interest = new Float64Array(horizon);
  for (const cf of cfs) {
    const bucket = cf.monthOffset - 1;
    if (bucket < 0 || bucket >= horizon) continue;
    balance[bucket] += cf.balance;
    principal[bucket] += cf.principalPaid;
    interest[bucket] += cf.interestPaid;
  }
  return {
    balance: Array.from(balance),
    principal: Array.from(principal),
    interest: Array.from(interest),
  };
}

let snapshot: MarketSnapshot;
let base: ZeroCurve;

beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
  base = buildBaseCurve(snapshot);
});

describe("static runoff — Lab cross-check (seasoned mortgage)", () => {
  // A seasoned mortgage: 5y into a 25y remaining term, 6.5% note.
  const seasoned = { ageMonths: 60, maturityMonths: 300, noteRate: 0.065 };

  for (const shockBp of [0, 100]) {
    it(`reproduces the kernel mortgage runoff exactly under ${shockBp}bp`, () => {
      const portfolio = makePortfolio([mortgagePosition("M1", seasoned)]);
      const scenario = staticScenario(`S${shockBp}`, shockBp);
      const path: RatePath = buildScenarioRatePath(base, scenario, HORIZON);

      const result = projectStaticScenario(portfolio, { scenario, ratePath: path }, GRID);

      // Reference: the same kernel instrument under the same path, bucketed.
      const ref = new Mortgage(mortgageTerms("M1", seasoned)).generateCashflows(path);
      const expected = bucketReference(ref, HORIZON);

      const fam = result.byFamily.find((f) => f.familyId === "MORTGAGE");
      expect(fam).toBeDefined();
      // Exact equality: the aggregator is a pure pass-through of the kernel math.
      expect(fam!.series.balance).toEqual(expected.balance);
      expect(fam!.series.principal).toEqual(expected.principal);
      expect(fam!.series.interest).toEqual(expected.interest);
    });
  }

  it("shows a genuine prepayment response: +100 runs off slower early than base", () => {
    const portfolio = makePortfolio([mortgagePosition("M1", seasoned)]);
    const baseScn = staticScenario("BASE", 0);
    const upScn = staticScenario("UP100", 100);
    const basePath = buildScenarioRatePath(base, baseScn, HORIZON);
    const upPath = buildScenarioRatePath(base, upScn, HORIZON);

    const baseRes = projectStaticScenario(portfolio, { scenario: baseScn, ratePath: basePath }, GRID);
    const upRes = projectStaticScenario(portfolio, { scenario: upScn, ratePath: upPath }, GRID);

    const baseP = baseRes.byFamily.find((f) => f.familyId === "MORTGAGE")!.series.principal;
    const upP = upRes.byFamily.find((f) => f.familyId === "MORTGAGE")!.series.principal;

    // Cumulative principal returned over the first 3 years. Higher market rates
    // (+100) cut the refi incentive (wac - mortgageRate falls), so prepayment
    // slows and less principal comes back early. If prepayment were ignored this
    // would be equal, so a strict inequality proves the behavioral response.
    const cum = (arr: number[]) => arr.slice(0, 36).reduce((s, v) => s + v, 0);
    expect(cum(upP)).toBeLessThan(cum(baseP));
  });
});

describe("static runoff — internal consistency with the m03 base aggregate", () => {
  it("base-scenario output equals aggregateScenario over the same portfolio and path", () => {
    const portfolio: PortfolioSpec = makePortfolio([
      fixedPosition("F1"),
      mortgagePosition("M1", { ageMonths: 60, maturityMonths: 300 }),
    ]);
    const scenario = staticScenario("BASE", 0);
    const path = buildScenarioRatePath(base, scenario, HORIZON);

    const viaStatic = projectStaticScenario(portfolio, { scenario, ratePath: path }, GRID);
    const viaAggregate = aggregateScenario(portfolio, { scenarioId: "BASE", path }, GRID);

    expect(viaStatic).toEqual(viaAggregate);
  });
});

describe("static runoff — non-negative balance invariant", () => {
  it("never produces a negative outstanding balance across the regulatory grid", () => {
    const portfolio = makePortfolio([
      fixedPosition("F1"),
      fixedPosition("F2", { notional: 250_000, maturityMonths: 60 }),
      mortgagePosition("M1", { ageMonths: 60, maturityMonths: 300 }),
      mortgagePosition("M2", { ageMonths: 12, maturityMonths: 348, noteRate: 0.072 }),
    ]);
    for (const shockBp of [0, 100, -100, 200, -200]) {
      const scenario = staticScenario(`S${shockBp}`, shockBp);
      const path = buildScenarioRatePath(base, scenario, HORIZON);
      const result = projectStaticScenario(portfolio, { scenario, ratePath: path }, GRID);
      expect(findNegativeBalance(result)).toBeNull();
    }
  });
});

describe("static runoff — mode guard", () => {
  it("rejects a dynamic scenario rather than ignoring its reinvestment rules", () => {
    const portfolio = makePortfolio([mortgagePosition("M1")]);
    const scenario: Scenario = {
      id: "DYN",
      label: "dynamic",
      rateSpec: { kind: "base" },
      assumptionSetId: "AS-BASE",
      newBusiness: { mode: "dynamic", rules: [] },
    };
    const path = buildScenarioRatePath(base, scenario, HORIZON);
    expect(() => projectStaticScenario(portfolio, { scenario, ratePath: path }, GRID)).toThrow(
      /static runoff requires mode "static"/,
    );
  });
});
