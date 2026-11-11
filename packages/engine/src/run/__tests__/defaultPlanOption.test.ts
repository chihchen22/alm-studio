/**
 * Studio A+E contract 23: `defaultPlanFor` takes an optional fourth argument so a
 * caller that has not yet resolved its scenarios can force or suppress the
 * balance stage. A caller that passes no option, or an empty one, gets today's
 * plan byte for byte.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PlanStage } from "../../contracts/plan";
import type { Scenario } from "../../contracts/scenario";
import { defaultPlanFor } from "../defaultPlan";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const depsOf = (stages: PlanStage[]): Record<string, string[]> =>
  Object.fromEntries(stages.map((s) => [s.id, s.dependsOn ?? []]));

describe("defaultPlanFor: balanceStage option", () => {
  it("with { balanceStage: true } and no scenarios, carries st-balance and points NII at it while EVE and gap stay on st-cashflow", () => {
    const request = makeRunRequest(market, { scenarios: [] });
    const { plan } = defaultPlanFor(request, twoSidedBook(), undefined, { balanceStage: true });
    const deps = depsOf(plan.stages);
    expect(plan.stages.some((s) => s.id === "st-balance" && s.kind === "balance-new-business")).toBe(true);
    expect(deps["st-nii"]).toContain("st-balance");
    expect(deps["st-nii"]).not.toContain("st-cashflow");
    expect(deps["st-eve"]).toContain("st-cashflow");
    expect(deps["st-eve"]).not.toContain("st-balance");
    expect(deps["st-gap"]).toContain("st-cashflow");
    expect(deps["st-gap"]).not.toContain("st-balance");
  });

  it("without the option derives exactly today's plan for a static request", () => {
    const request = makeRunRequest(market);
    const a = defaultPlanFor(request, twoSidedBook());
    const b = defaultPlanFor(request, twoSidedBook(), undefined, {});
    expect(JSON.stringify(b.plan)).toBe(JSON.stringify(a.plan));
    expect(JSON.stringify(b.licensedBindings)).toBe(JSON.stringify(a.licensedBindings));
    expect(a.plan.stages.some((s) => s.id === "st-balance")).toBe(false);
    expect(depsOf(a.plan.stages)["st-nii"]).toContain("st-cashflow");
  });

  it("without the option still derives the balance stage from a dynamic scenario", () => {
    const base = makeRunRequest(market);
    const scenarios: Scenario[] = base.scenarios.map((s, i) =>
      i === 0 ? { ...s, newBusiness: { mode: "dynamic", rules: [] } } : s,
    );
    const { plan } = defaultPlanFor(makeRunRequest(market, { scenarios }), twoSidedBook());
    expect(plan.stages.some((s) => s.id === "st-balance")).toBe(true);
    expect(depsOf(plan.stages)["st-nii"]).toContain("st-balance");
  });

  it("{ balanceStage: false } removes the stage even when a scenario is dynamic", () => {
    const base = makeRunRequest(market);
    const scenarios: Scenario[] = base.scenarios.map((s, i) =>
      i === 0 ? { ...s, newBusiness: { mode: "dynamic", rules: [] } } : s,
    );
    const { plan } = defaultPlanFor(makeRunRequest(market, { scenarios }), twoSidedBook(), undefined, {
      balanceStage: false,
    });
    expect(plan.stages.some((s) => s.id === "st-balance")).toBe(false);
    expect(depsOf(plan.stages)["st-nii"]).toContain("st-cashflow");
  });
});
