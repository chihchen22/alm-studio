import { describe, expect, it } from "vitest";
import { regulatoryScenarios } from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { ScenarioNotExecutableError } from "../compile";
import { resolveScenarios, ScenarioRefError } from "../resolveScenarios";
import { fixturePlan } from "./fixtures";

const STATIC = () => ({ mode: "static" as const, rules: [] });
const HORIZON = 360;

describe("resolveScenarios", () => {
  it("resolves the regulatory grid refs to exactly the fixture scenarios", () => {
    const { scenarios, notImplemented } = resolveScenarios(fixturePlan().scenarios, SHIPPED_LIBRARIES, STATIC, "AS-BASE", HORIZON);
    expect(scenarios).toEqual(regulatoryScenarios());
    expect(notImplemented).toEqual([]);
  });
  it("refuses an unknown ref, naming it", () => {
    expect(() => resolveScenarios([{ ref: "nope#S0" }], SHIPPED_LIBRARIES, STATIC, "AS-BASE", HORIZON)).toThrow(ScenarioRefError);
    expect(() => resolveScenarios([{ ref: "nope#S0" }], SHIPPED_LIBRARIES, STATIC, "AS-BASE", HORIZON)).toThrow("nope#S0");
  });
  // Round-2 ruling 12 replaced both tags below with refusals: a scenario that
  // cannot run as declared produces no numbers, so nothing downstream sees an
  // immediate shock standing in for a ramp.
  it("refuses a ramp scenario, naming it", () => {
    expect(() => resolveScenarios([{ ref: "regulatory-grid-v1#S0" }, { ref: "ramp-200-12m-v1#R200" }], SHIPPED_LIBRARIES, STATIC, "AS-BASE", HORIZON))
      .toThrow(ScenarioNotExecutableError);
    try {
      resolveScenarios([{ ref: "ramp-200-12m-v1#R200" }], SHIPPED_LIBRARIES, STATIC, "AS-BASE", HORIZON);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioNotExecutableError);
      expect((err as ScenarioNotExecutableError).scenarioId).toBe("R200");
      expect((err as ScenarioNotExecutableError).reason).toContain("ramp timing over 12 months");
    }
  });
  it("refuses an environment block", () => {
    expect(() => resolveScenarios(
      [{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", environment: { housePriceIndexPath: [1, 1, 1] } }],
      SHIPPED_LIBRARIES, STATIC, "AS-BASE", HORIZON,
    )).toThrow(ScenarioNotExecutableError);
  });
  it("an inline definition without newBusiness takes the default", () => {
    const { scenarios } = resolveScenarios([{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE" }], SHIPPED_LIBRARIES, () => ({ mode: "dynamic", rules: [{ familyId: "FIXED", reinvest: "flat" }] }), "AS-BASE", HORIZON);
    expect(scenarios[0]!.newBusiness).toEqual({ mode: "dynamic", rules: [{ familyId: "FIXED", reinvest: "flat" }] });
  });
  it("ships four libraries with the documented ids", () => {
    expect(SHIPPED_LIBRARIES.map((l) => l.id)).toEqual(["regulatory-grid-v1", "steepener-v1", "flattener-v1", "ramp-200-12m-v1"]);
  });
});
