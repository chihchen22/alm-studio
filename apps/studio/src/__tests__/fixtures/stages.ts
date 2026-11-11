/**
 * Compiled stage lists as the setup validate route returns them (`compiledChain`), written by hand from the
 * engine's default plan derivation (packages/engine/src/run/defaultPlan.ts): a Runoff chain without `st-balance`,
 * and the same chain with `st-balance` between `st-cashflow` and `st-nii`, which is the one difference a Flat or
 * Custom setup shows (spec v3.1 Section 5.5).
 */
import type { PlanStage } from "@alm/engine";

const BASE_HEAD: PlanStage[] = [
  { id: "st-curve", component: "engine.curve.bootstrap", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"] },
  { id: "st-tlp", component: "engine.tlp-overlay", kind: "curve", consumes: ["ZeroCurve", "MarketSnapshot"], produces: ["FundingCurve"], dependsOn: ["st-curve"] },
  { id: "st-term", component: "engine.rate-path.deterministic", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
  { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-term"] },
];

const EVE: PlanStage = { id: "st-eve", component: "engine.metric.eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"], produces: ["EveResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp"] };
const GAP: PlanStage = { id: "st-gap", component: "engine.metric.gap", kind: "metric", consumes: ["Cashflow", "RepricingSchedule", "Position"], produces: ["GapResult"], dependsOn: ["st-cashflow"] };

export const RUNOFF_STAGES: PlanStage[] = [
  ...BASE_HEAD,
  { id: "st-nii", component: "engine.metric.nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
  EVE,
  GAP,
];

export const FLAT_STAGES: PlanStage[] = [
  ...BASE_HEAD,
  { id: "st-balance", component: "engine.balance-plan", kind: "balance-new-business", consumes: ["Position", "RatePath", "Cashflow"], produces: ["Cashflow"], dependsOn: ["st-cashflow", "st-term"] },
  { id: "st-nii", component: "engine.metric.nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-balance"] },
  EVE,
  GAP,
];
