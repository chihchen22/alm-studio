/**
 * Round-2 ruling 5. A plan compiled over the demo book produces exactly the
 * request the demo builder produces by hand, so the plan front door is proved
 * number-neutral on the book the platform actually ships, not only on the
 * four-position fixture.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { loadMarketSnapshot } from "@alm/kernel";
import {
  BUILTIN_CATALOG,
  compilePlan,
  parseRoutingPolicy,
  SHIPPED_LIBRARIES,
  type RunPlan,
} from "@alm/engine";
import {
  buildDemoAssumptions,
  buildDemoPortfolio,
  buildDemoRequest,
  DEMO_RUN_ID,
  DEMO_RUN_SEED,
} from "../demo/request";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TIMESTAMPS = { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" };

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(`${ROOT}packages/kernel/public/market_public.json`);
});

/**
 * The demo grid as a plan: the same five scenarios, declared rather than built.
 *
 * The demo assumption set binds prepay on mortgages and mbs, nmd-decay on dda
 * and deposit-beta on mma, so R4 reports those four (family, class) pairs
 * uncovered unless the plan carries a behavioral stage for each. They are
 * declared here with the selector each family actually carries, and each feeds
 * only the metrics model-map.json routes to its class: decay feeds no nii,
 * because the policy says "none" there. The gate is met, never loosened.
 */
function demoPlan(portfolioId: string, asOf: string): RunPlan {
  return {
    schemaVersion: "1.4.0",
    planId: "PLAN-DEMO-1",
    label: "The demo book over the regulatory grid",
    authoredBy: "person",
    asOf,
    grid: { horizonMonths: 360 },
    inputs: {
      marketSnapshot: "market_public.json",
      positionBook: portfolioId,
      routingPolicy: "model-map.json",
      assumptionSets: [buildDemoAssumptions().id],
    },
    // A CHAIN. The behavioral stages rewrite position terms
    // (Position -> Position) and hand the rewritten book to the contractual
    // pass; every edge resolves to exactly one producer in the consumer's own
    // dependsOn, each metric stage declares every input its executor reads, and
    // st-tlp is the FundingCurve producer st-eve discounts on. The gap stage is
    // declared because the run envelope carries a gap block on every result.
    stages: [
      { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], params: { dayCount: "ACT/360" } },
      { id: "st-tlp", component: "alm-tlp-overlay", kind: "curve", consumes: ["ZeroCurve", "MarketSnapshot"], produces: ["FundingCurve"], params: { dayCount: "ACT/360" }, dependsOn: ["st-curve"] },
      { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
      { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-beta", "st-term"] },
      { id: "st-prepay", component: "alm-mortgage-prepayment", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-term"], selector: { productFamily: ["mortgages", "mbs"], behavioralClasses: "prepayment" }, disposition: "M", tier: "Tier 1", feeds: ["nii", "eve", "ir-gap"] },
      { id: "st-decay", component: "alm-deposit-decay", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-prepay", "st-term"], selector: { productFamily: "dda", behavioralClasses: "decay" }, disposition: "M", tier: "Tier 1", feeds: ["eve", "ir-gap", "liq-gap"] },
      { id: "st-beta", component: "alm-deposit-beta", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-decay", "st-term"], selector: { productFamily: "mma", behavioralClasses: "deposit-beta" }, disposition: "M", tier: "Tier 1", feeds: ["nii", "eve"] },
      { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
      { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"], produces: ["EveResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-beta"] },
      { id: "st-gap", component: "alm-gap-analytics", kind: "metric", consumes: ["Cashflow", "RepricingSchedule", "Position"], produces: ["GapResult"], dependsOn: ["st-cashflow", "st-beta"] },
    ],
    scenarios: buildDemoRequest(buildDemoPortfolio(), market, TIMESTAMPS).scenarios.map((s) => ({
      id: s.id,
      label: s.label,
      rateSpec: s.rateSpec,
      assumptionSetId: s.assumptionSetId,
      newBusiness: s.newBusiness,
    })),
    reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
    validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5", "T6"], routingGate: ["R1", "R2", "R3", "R4"] },
  };
}

describe("the demo plan compiles to the demo request", () => {
  it("deep-equals buildDemoRequest once plan identity is stripped", () => {
    const portfolio = buildDemoPortfolio();
    const policy = parseRoutingPolicy(JSON.parse(readFileSync(`${ROOT}docs/harness/model-map.json`, "utf8")));
    const compiled = compilePlan(
      demoPlan(portfolio.id, portfolio.asOf),
      {
        portfolio,
        marketSnapshot: market,
        assumptionSets: [buildDemoAssumptions()],
        policy,
        libraries: SHIPPED_LIBRARIES,
        catalog: BUILTIN_CATALOG,
      },
      { runId: DEMO_RUN_ID, seed: DEMO_RUN_SEED, timestamps: TIMESTAMPS },
    );
    const { plan, ...compiledRequest } = compiled.request;
    expect(plan!.planId).toBe("PLAN-DEMO-1");
    expect(compiledRequest).toEqual(buildDemoRequest(portfolio, market, TIMESTAMPS));
    compiled.harness.dispose();
  });
});
