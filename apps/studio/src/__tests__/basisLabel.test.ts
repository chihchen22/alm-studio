// apps/studio/src/__tests__/basisLabel.test.ts
import { describe, expect, it } from "vitest";
import { basisLabelOf, envelopeBasisLabel } from "../rows/basisLabel";
import { freshResult } from "./fixtures/results";

const scen = (id: string, mode: "static" | "dynamic") => ({ id, newBusiness: { mode } });
describe("basis label from the run's own record", () => {
  it("Flat from request.plan.balanceBasis", () => {
    expect(basisLabelOf({ plan: { balanceBasis: { kind: "flat" } }, scenarios: [scen("S0", "dynamic")] }, null)).toBe("Flat (simple top-up)");
  });
  it("Runoff when every scenario is static and no plan hash is stamped", () => {
    expect(basisLabelOf({ plan: {}, scenarios: [scen("S0", "static"), scen("S100", "static")] }, null)).toBe("Runoff");
  });
  it("Custom from balancePlanHash with the plan id read off planDocument; per scenario when mixed", () => {
    expect(basisLabelOf({ plan: { balancePlanHash: "h" }, scenarios: [scen("S0", "dynamic")] }, { balancePlan: "balance-targets-demo-v1" })).toBe("Custom dynamic (balance-targets-demo-v1)");
    expect(basisLabelOf({ plan: { scenarioBalancePlanHashes: { S0: "h" } }, scenarios: [scen("S0", "dynamic"), scen("S100", "static"), scen("S-100", "static"), scen("S200", "static"), scen("S-200", "static")] }, { scenarioBalancePlans: { S0: "bp-vanilla-book-v1-edit-1" } })).toBe("Custom dynamic on S0 (bp-vanilla-book-v1-edit-1), Runoff on S100, S-100, S200, S-200");
  });
  it("never reads a setup: the function takes only the run record", () => {
    expect(basisLabelOf.length).toBe(2);
  });
  it("a Flat basis with one scenario on its own static strategy names both groups", () => {
    expect(basisLabelOf({ plan: { balanceBasis: { kind: "flat" } }, scenarios: [scen("S0", "dynamic"), scen("S100", "static")] }, null)).toBe("Flat on S0, Runoff on S100");
  });
  it("a plan hash with no stored plan document names the gap instead of a plan id", () => {
    expect(basisLabelOf({ plan: { balancePlanHash: "h" }, scenarios: [scen("S0", "dynamic")] }, null)).toBe("Custom dynamic (plan id not stored)");
  });
  it("a scenario with no newBusiness stamp reads as static, the engine's default", () => {
    expect(basisLabelOf({ plan: {}, scenarios: [{ id: "S0" }, { id: "S100" }] }, null)).toBe("Runoff");
  });
});

describe("the label read off a stored envelope when no server label is at hand", () => {
  it("reads Runoff when no scenario carries a new-business arm", () => {
    expect(envelopeBasisLabel(freshResult())).toBe("Runoff");
  });
  it("says the basis is not recorded when a scenario ran new business and provenance names no plan", () => {
    const r = freshResult();
    r.nii.byScenario[0]!.newBusiness = [{ familyId: "cash", originations: [0, 1] }];
    expect(envelopeBasisLabel(r)).toBe("Dynamic new business (basis not recorded on this envelope)");
  });
  it("names the plan hash holder when provenance carries a balance plan hash", () => {
    const r = freshResult();
    r.nii.byScenario[0]!.newBusiness = [{ familyId: "cash", originations: [0, 1] }];
    r.provenance.balancePlanHash = "h";
    expect(envelopeBasisLabel(r)).toBe("Custom dynamic on S0 (plan id not stored), Runoff on S100, S-100, S200, S-200");
  });
});
