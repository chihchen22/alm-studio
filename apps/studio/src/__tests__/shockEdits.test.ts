// apps/studio/src/__tests__/shockEdits.test.ts
/**
 * The builder's plan edits and the base guard. Expected plans are restated.
 */
import { describe, expect, it } from "vitest";
import type { RunPlan, ScenarioLibrary } from "@alm/engine";
import { planDoc } from "./fixtures/run";
import { addInlineScenario, isOnlyBase, ONLY_BASE, removeScenario, setScenarioBalancePlan, updateScenarioShock } from "../scenarios/scenarioEdits";

const LIBS: ScenarioLibrary[] = [
  { schemaVersion: "1.0.0", id: "regulatory-grid-v1", label: "grid", scenarios: [
    { id: "S0", label: "S0", rateSpec: { kind: "base" } },
    { id: "S100", label: "S100", rateSpec: { kind: "parallel", shockBp: 100 } },
  ] },
];
/** planDoc's scenarios are [{ ref: "regulatory-grid-v1#S0" }]. */
const base = planDoc("plan-x", []);
const withOwn: RunPlan = {
  ...base,
  scenarios: [
    { ref: "regulatory-grid-v1#S0" },
    {
      id: "UP300", label: "Up 300", rateSpec: { kind: "parallel", shockBp: 300 },
      assumptionSetId: "stack-0123456789ab", newBusiness: { mode: "static", rules: [] }, ratePathModel: "deterministic",
    },
  ],
};

describe("addInlineScenario", () => {
  it("appends { id, rateSpec } or { id, label, rateSpec } and touches nothing else", () => {
    const a = addInlineScenario(base, { id: "UP400", rateSpec: { kind: "parallel", shockBp: 400 } });
    expect(a.scenarios).toEqual([{ ref: "regulatory-grid-v1#S0" }, { id: "UP400", rateSpec: { kind: "parallel", shockBp: 400 } }]);
    expect(Object.keys(a.scenarios[1]!)).toEqual(["id", "rateSpec"]);
    const b = addInlineScenario(base, { id: "UP400", label: "Up 400", rateSpec: { kind: "parallel", shockBp: 400 } });
    expect(Object.keys(b.scenarios[1]!)).toEqual(["id", "label", "rateSpec"]);
    expect(a.inputs).toBe(base.inputs);
    expect(base.scenarios).toEqual([{ ref: "regulatory-grid-v1#S0" }]);
  });
  it("throws on an id the plan holds", () => {
    expect(() => addInlineScenario(base, { id: "S0", rateSpec: { kind: "parallel", shockBp: 1 } })).toThrow('already holds a scenario "S0"');
  });
});

describe("updateScenarioShock", () => {
  it("replaces rateSpec and label only; id, position, set, new business, path model and the balance plan entry stay", () => {
    const bound = setScenarioBalancePlan(withOwn, "UP300", "bp-a");
    const u = updateScenarioShock(bound, "UP300", { kind: "twist", shortBp: 10, longBp: 20, pivotYears: 3 }, "Twist");
    expect(u.scenarios[1]).toEqual({
      id: "UP300", label: "Twist", rateSpec: { kind: "twist", shortBp: 10, longBp: 20, pivotYears: 3 },
      assumptionSetId: "stack-0123456789ab", newBusiness: { mode: "static", rules: [] }, ratePathModel: "deterministic",
    });
    expect(Object.keys(u.scenarios[1]!)).toEqual(["id", "label", "rateSpec", "assumptionSetId", "newBusiness", "ratePathModel"]);
    expect(u.scenarios[0]).toEqual({ ref: "regulatory-grid-v1#S0" });
    expect(u.scenarioBalancePlans).toEqual({ UP300: "bp-a" });
  });
  it("an undefined label removes the label; id, set, new business and path model stay, in their order", () => {
    const u = updateScenarioShock(withOwn, "UP300", { kind: "parallel", shockBp: 350 }, undefined);
    expect(u.scenarios[1]).toEqual({
      id: "UP300", rateSpec: { kind: "parallel", shockBp: 350 },
      assumptionSetId: "stack-0123456789ab", newBusiness: { mode: "static", rules: [] }, ratePathModel: "deterministic",
    });
    expect(Object.keys(u.scenarios[1]!)).toEqual(["id", "rateSpec", "assumptionSetId", "newBusiness", "ratePathModel"]);
  });
  it("throws for a ref, an unknown id and a base", () => {
    expect(() => updateScenarioShock(withOwn, "S0", { kind: "parallel", shockBp: 1 }, undefined)).toThrow("library ref");
    expect(() => updateScenarioShock(withOwn, "NOPE", { kind: "parallel", shockBp: 1 }, undefined)).toThrow('no scenario "NOPE"');
    const inlineBase: RunPlan = { ...base, scenarios: [{ id: "B", rateSpec: { kind: "base" } }] };
    expect(() => updateScenarioShock(inlineBase, "B", { kind: "parallel", shockBp: 1 }, undefined)).toThrow("does not build or edit a base scenario");
    // UP300 is inline and not base, so only the new-side check can refuse this.
    expect(() => updateScenarioShock(withOwn, "UP300", { kind: "base" }, undefined)).toThrow("does not build or edit a base scenario");
  });
});

describe("base guard (spec Section 5.2 item 4)", () => {
  it("the only base, as a ref or inline, cannot be removed", () => {
    expect(isOnlyBase(withOwn, 0, LIBS)).toBe(true);
    expect(() => removeScenario(withOwn, 0, LIBS)).toThrow(ONLY_BASE);
    const inline: RunPlan = { ...base, scenarios: [{ id: "B", rateSpec: { kind: "base" } }, { id: "U", rateSpec: { kind: "parallel", shockBp: 1 } }] };
    expect(isOnlyBase(inline, 0, LIBS)).toBe(true);
    expect(() => removeScenario(inline, 0, LIBS)).toThrow(ONLY_BASE);
  });
  it("with two bases either can be removed; a non-base and an unknown ref are never guarded", () => {
    const two: RunPlan = { ...base, scenarios: [{ ref: "regulatory-grid-v1#S0" }, { id: "B2", rateSpec: { kind: "base" } }, { ref: "nope-v1#X" }] };
    expect(isOnlyBase(two, 0, LIBS)).toBe(false);
    expect(isOnlyBase(two, 1, LIBS)).toBe(false);
    expect(removeScenario(two, 0, LIBS).scenarios).toEqual([{ id: "B2", rateSpec: { kind: "base" } }, { ref: "nope-v1#X" }]);
    expect(isOnlyBase(two, 2, LIBS)).toBe(false);
    expect(isOnlyBase(withOwn, 1, LIBS)).toBe(false);
  });
  it("the restated title text", () => {
    expect(ONLY_BASE).toBe("A run needs one base scenario");
  });
});
