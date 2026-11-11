/**
 * A plan over the two-sided run fixture book (families FIXED, MORTGAGE, DDA,
 * MMA) that passes both gates and compiles to exactly makeRunRequest().
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunPlan, RoutingPolicy } from "../../contracts/plan";
import { AS_OF, HORIZON } from "../../run/__tests__/fixtures";
import { parseRoutingPolicy } from "../parse";

export const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

export function loadPolicy(): RoutingPolicy {
  return parseRoutingPolicy(JSON.parse(readFileSync(`${ROOT}docs/harness/model-map.json`, "utf8")));
}

export function fixturePlan(): RunPlan {
  return {
    schemaVersion: "1.4.0",
    planId: "PLAN-FIXTURE-1",
    label: "Two-sided fixture book over the regulatory grid",
    authoredBy: "person",
    asOf: AS_OF,
    grid: { horizonMonths: HORIZON },
    inputs: { marketSnapshot: "market-public-2026-03-31", positionBook: "PF-RUN", routingPolicy: "model-map-default-v1", assumptionSets: ["AS-BASE"] },
    // A CHAIN, not a fan. The behavioral stages rewrite position
    // terms (Position -> Position) and hand the rewritten book to the
    // contractual pass, which is what the engine's overlays actually do; the
    // pre-1c arrows said Cashflow -> Cashflow and were decorative. Every edge
    // here is one the tightened T1 resolves in the consumer's own dependsOn,
    // and st-tlp is the FundingCurve producer st-eve discounts on.
    stages: [
      { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], params: { dayCount: "ACT/360" } },
      { id: "st-tlp", component: "alm-tlp-overlay", kind: "curve", consumes: ["ZeroCurve", "MarketSnapshot"], produces: ["FundingCurve"], params: { dayCount: "ACT/360" }, dependsOn: ["st-curve"] },
      { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
      { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-beta", "st-term"] },
      { id: "st-prepay", component: "alm-mortgage-prepayment", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-term"], selector: { productFamily: "MORTGAGE", behavioralClasses: "prepayment" }, disposition: "M", tier: "Tier 1", feeds: ["nii", "eve", "ir-gap"] },
      { id: "st-decay", component: "alm-deposit-decay", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-prepay", "st-term"], selector: { productFamily: "DDA", behavioralClasses: "decay" }, disposition: "M", tier: "Tier 1", feeds: ["eve", "ir-gap", "liq-gap"] },
      { id: "st-beta", component: "alm-deposit-beta", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], dependsOn: ["st-decay", "st-term"], selector: { productFamily: "MMA", behavioralClasses: "deposit-beta" }, disposition: "M", tier: "Tier 1", feeds: ["nii", "eve"] },
      { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
      { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"], produces: ["EveResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-beta"] },
      { id: "st-gap", component: "alm-gap-analytics", kind: "metric", consumes: ["Cashflow", "RepricingSchedule", "Position"], produces: ["GapResult"], dependsOn: ["st-cashflow", "st-beta"] },
    ],
    scenarios: [{ ref: "regulatory-grid-v1#S0" }, { ref: "regulatory-grid-v1#S100" }, { ref: "regulatory-grid-v1#S-100" }, { ref: "regulatory-grid-v1#S200" }, { ref: "regulatory-grid-v1#S-200" }],
    reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
    validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5", "T6"], routingGate: ["R1", "R2", "R3", "R4"] },
  };
}

/**
 * The fixture plan's chain with a balance stage, wired the way the
 * server's balance-plan run test wires it: st-balance reads the contractual and
 * term stages, and st-nii reads st-balance alone (two Cashflow producers on one
 * edge is a T1 refusal). EVE, gap and FTP keep reading st-cashflow.
 */
export function withBalanceStage(plan: RunPlan): RunPlan {
  const stages = plan.stages.map((s) => (s.id === "st-nii" ? { ...s, dependsOn: ["st-balance"] } : s));
  const at = stages.findIndex((s) => s.id === "st-cashflow") + 1;
  stages.splice(at, 0, {
    id: "st-balance", component: "engine.balance-plan", kind: "balance-new-business",
    consumes: ["Position", "RatePath", "Cashflow"], produces: ["Cashflow"], dependsOn: ["st-cashflow", "st-term"],
  });
  return { ...plan, stages };
}
