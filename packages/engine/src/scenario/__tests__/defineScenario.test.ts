/**
 * defineScenario tests. It is a pure builder: it copies a validated spec into a
 * Scenario and performs no side effect and no mutation.
 */
import { describe, expect, it } from "vitest";
import type { ScenarioSpec } from "../../contracts/tools";
import { defineScenario, ScenarioSpecError } from "../defineScenario";
import { CustomShockError } from "../rateEnvironment";

function spec(): ScenarioSpec {
  return {
    id: "sc-up200",
    label: "+200 parallel",
    rateSpec: { kind: "parallel", shockBp: 200 },
    assumptionSetId: "as-base",
    newBusiness: { mode: "static", rules: [] },
  };
}

describe("defineScenario", () => {
  it("copies the spec fields into a Scenario", () => {
    const s = defineScenario(spec());
    expect(s).toEqual({
      id: "sc-up200",
      label: "+200 parallel",
      rateSpec: { kind: "parallel", shockBp: 200 },
      assumptionSetId: "as-base",
      newBusiness: { mode: "static", rules: [] },
    });
  });

  it("does not mutate or alias the input rateSpec", () => {
    const input = spec();
    const s = defineScenario(input);
    expect(s.rateSpec).not.toBe(input.rateSpec);
    (s.rateSpec as { shockBp: number }).shockBp = 999;
    expect((input.rateSpec as { shockBp: number }).shockBp).toBe(200);
  });

  it("accepts a twist rate spec", () => {
    const s = defineScenario({
      ...spec(),
      rateSpec: { kind: "twist", shortBp: -100, longBp: 100, pivotYears: 5 },
    });
    expect(s.rateSpec.kind).toBe("twist");
  });

  it("rejects a non-positive twist pivot", () => {
    expect(() =>
      defineScenario({
        ...spec(),
        rateSpec: { kind: "twist", shortBp: -100, longBp: 100, pivotYears: 0 },
      }),
    ).toThrow(ScenarioSpecError);
  });

  it("rejects a non-finite parallel shock", () => {
    expect(() =>
      defineScenario({ ...spec(), rateSpec: { kind: "parallel", shockBp: Number.POSITIVE_INFINITY } }),
    ).toThrow(ScenarioSpecError);
  });

  it("rejects an empty id", () => {
    expect(() => defineScenario({ ...spec(), id: "" })).toThrow(ScenarioSpecError);
  });

  it("accepts a custom rate spec and deep-copies the shock vector", () => {
    const input: ScenarioSpec = {
      ...spec(),
      rateSpec: {
        kind: "custom",
        shocks: [
          { tenorYears: 0.25, shockBp: -50 },
          { tenorYears: 10, shockBp: 120 },
        ],
      },
    };
    const s = defineScenario(input);
    expect(s.rateSpec).toEqual(input.rateSpec);
    // No aliasing at either level: mutating the output leaves the input intact.
    const outSpec = s.rateSpec as { kind: "custom"; shocks: { tenorYears: number; shockBp: number }[] };
    const inSpec = input.rateSpec as { kind: "custom"; shocks: { tenorYears: number; shockBp: number }[] };
    expect(outSpec.shocks).not.toBe(inSpec.shocks);
    expect(outSpec.shocks[0]).not.toBe(inSpec.shocks[0]);
    outSpec.shocks[0].shockBp = 999;
    expect(inSpec.shocks[0].shockBp).toBe(-50);
  });

  it("REFUSES a malformed spec SHAPE with a typed error naming the field", () => {
    // Direct callers (scripts, not the platform route) get the same typed
    // refusal contract: field path + expected + found, never a raw TypeError.
    const cases: { input: unknown; field: string }[] = [
      { input: undefined, field: "spec" },
      { input: null, field: "spec" },
      { input: "sc-up200", field: "spec" },
      { input: [spec()], field: "spec" },
      { input: { ...spec(), rateSpec: undefined }, field: "rateSpec" },
      { input: { ...spec(), rateSpec: "parallel" }, field: "rateSpec" },
      { input: { ...spec(), newBusiness: undefined }, field: "newBusiness" },
      { input: { ...spec(), newBusiness: [] }, field: "newBusiness" },
      { input: { ...spec(), newBusiness: { mode: "static" } }, field: "newBusiness.rules" },
      { input: { ...spec(), newBusiness: { mode: "static", rules: {} } }, field: "newBusiness.rules" },
    ];
    for (const c of cases) {
      try {
        defineScenario(c.input as ScenarioSpec);
        throw new Error(`expected throw for field ${c.field}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ScenarioSpecError);
        expect((e as ScenarioSpecError).field).toBe(c.field);
        expect((e as ScenarioSpecError).message).toContain(
          c.field === "newBusiness.rules" ? "expected an array" : "expected an object",
        );
        expect((e as ScenarioSpecError).message).not.toContain("Cannot read properties");
        expect((e as ScenarioSpecError).message).not.toContain("is not a function");
      }
    }
    // The rules gate names what it expected and what it found.
    expect(() =>
      defineScenario({ ...spec(), newBusiness: { mode: "static", rules: {} } } as unknown as ScenarioSpec),
    ).toThrow("expected an array, got object");
  });

  it("still round-trips a valid spec unchanged after the shape gate", () => {
    const input: ScenarioSpec = {
      ...spec(),
      newBusiness: {
        mode: "dynamic",
        rules: [{ familyId: "loans.fixed", reinvest: "flat", termMonths: 60 }],
      },
    };
    const s = defineScenario(input);
    expect(s).toEqual(input);
  });

  it("REFUSES a malformed custom vector with a typed error naming the offending tenor", () => {
    // The platform's `validated` wrapper turns this throw into a 422 with the
    // message verbatim, so the field path and tenor must be in the message.
    const bad: ScenarioSpec = {
      ...spec(),
      rateSpec: {
        kind: "custom",
        shocks: [
          { tenorYears: 5, shockBp: 10 },
          { tenorYears: 3, shockBp: 20 },
        ],
      },
    };
    try {
      defineScenario(bad);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomShockError);
      expect((e as CustomShockError).field).toBe("rateSpec.shocks[1].tenorYears");
      expect((e as CustomShockError).message).toContain("3y");
      expect((e as CustomShockError).message).toContain("5y");
    }
    expect(() =>
      defineScenario({ ...spec(), rateSpec: { kind: "custom", shocks: [] } }),
    ).toThrow(CustomShockError);
  });
});
