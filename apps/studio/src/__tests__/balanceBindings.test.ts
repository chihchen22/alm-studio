// apps/studio/src/__tests__/balanceBindings.test.ts
import { describe, expect, it } from "vitest";
import type { RunPlan } from "@alm/engine";
import { addBalanceStage, bindsBalancePlan, hasBalanceStage, removeScenario, setPlanBalancePlan, setScenarioBalancePlan } from "../scenarios/scenarioEdits";

const plan = (): RunPlan => ({
  schemaVersion: "1.4.0", planId: "P", label: "P", authoredBy: "person", asOf: "2026-03-31", grid: { horizonMonths: 360 },
  inputs: { marketSnapshot: "m", positionBook: "b", routingPolicy: "r", assumptionSets: ["a"] },
  stages: [
    { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"] },
    { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
    { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-term"] },
    { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
    { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve"], produces: ["EveResult"], dependsOn: ["st-curve", "st-cashflow"] },
  ],
  scenarios: [{ ref: "regulatory-grid-v1#BASE" }, { ref: "regulatory-grid-v1#S100" }],
  reports: [],
  validationRules: { typeGate: [], routingGate: [] },
} as RunPlan);

describe("balance plan bindings", () => {
  it("sets and clears the plan default", () => {
    const p = setPlanBalancePlan(plan(), "bp-a");
    expect(p.balancePlan).toBe("bp-a");
    expect("balancePlan" in setPlanBalancePlan(p, null)).toBe(false);
  });
  it("sets and clears one scenario's entry, dropping the empty map", () => {
    const p = setScenarioBalancePlan(plan(), "S100", "bp-a");
    expect(p.scenarioBalancePlans).toEqual({ S100: "bp-a" });
    expect("scenarioBalancePlans" in setScenarioBalancePlan(p, "S100", null)).toBe(false);
  });
  it("removing a scenario drops its entry", () => {
    const p = removeScenario(setScenarioBalancePlan(plan(), "S100", "bp-a"), 1, []);
    expect("scenarioBalancePlans" in p).toBe(false);
  });
  it("binds when either field names a balance plan", () => {
    expect(bindsBalancePlan(plan())).toBe(false);
    expect(bindsBalancePlan(setScenarioBalancePlan(plan(), "BASE", "bp-a"))).toBe(true);
  });
});

describe("addBalanceStage", () => {
  it("inserts st-balance after the contractual stage and points NII at it alone; EVE keeps st-cashflow", () => {
    const r = addBalanceStage(plan());
    if (r.kind !== "ok") throw new Error(r.text);
    expect(r.plan.stages.map((s) => s.id)).toEqual(["st-curve", "st-term", "st-cashflow", "st-balance", "st-nii", "st-eve"]);
    expect(r.plan.stages[3]).toEqual({
      id: "st-balance", component: "engine.balance-plan", kind: "balance-new-business",
      consumes: ["Position", "RatePath", "Cashflow"], produces: ["Cashflow"], dependsOn: ["st-cashflow", "st-term"],
    });
    expect(r.plan.stages.find((s) => s.id === "st-nii")!.dependsOn).toEqual(["st-balance"]);
    expect(r.plan.stages.find((s) => s.id === "st-eve")!.dependsOn).toEqual(["st-curve", "st-cashflow"]);
    expect(hasBalanceStage(r.plan)).toBe(true);
  });
  it("returns the plan unchanged when the stage is present", () => {
    const once = addBalanceStage(plan());
    if (once.kind !== "ok") throw new Error(once.text);
    const twice = addBalanceStage(once.plan);
    expect(twice).toEqual({ kind: "ok", plan: once.plan });
  });
  it("refuses a chain with no NII stage reading the contractual stage", () => {
    const p = plan();
    p.stages = p.stages.filter((s) => s.id !== "st-nii");
    expect(addBalanceStage(p)).toEqual({ kind: "refused", text: "The chain has no NII stage that reads the contractual stage, so Studio cannot place the balance stage. Add it on the Model chain page." });
  });
});
