/**
 * SRP31 shock library. The six prescribed shocks
 * (srp31_shock in the v5 build): S(t) = exp(-t/4), short 300, long 225, parallel 200. The expected values below
 * are restated by hand from those formulas, never imported from the code under test.
 */
import { describe, expect, it } from "vitest";
import { defineScenario } from "../defineScenario";
import { SHIPPED_LIBRARIES, SRP31_TENORS, SRP31_USD, srp31Scenario, srp31ShockBp, type Srp31Name } from "../library";
import { customShiftBp } from "../rateEnvironment";

const NAMES: Srp31Name[] = ["parallel_up", "parallel_down", "short_up", "short_down", "steepener", "flattener"];
const IDS = ["SRP-PUP", "SRP-PDN", "SRP-SUP", "SRP-SDN", "SRP-STEEP", "SRP-FLAT"];

describe("srp31ShockBp", () => {
  it("short_up at 1Y is 300 exp(-1/4) = 233.6bp", () => {
    expect(srp31ShockBp("short_up", 1)).toBeCloseTo(233.6, 1);
    expect(srp31ShockBp("short_up", 1)).toBeCloseTo(300 * Math.exp(-0.25), 9);
  });

  it("parallel_down at 30Y is -200bp and parallel_up is +200bp at every tenor", () => {
    expect(srp31ShockBp("parallel_down", 30)).toBe(-200);
    for (const t of SRP31_TENORS) expect(srp31ShockBp("parallel_up", t)).toBe(200);
  });

  it("steepener at the front is -0.65 x 300 = -195bp, and at 10Y follows -0.65 x 300 S + 0.90 x 225 (1 - S)", () => {
    expect(srp31ShockBp("steepener", 0)).toBeCloseTo(-195, 9);
    const s = Math.exp(-10 / 4);
    const hand = -0.65 * 300 * s + 0.9 * 225 * (1 - s);
    expect(srp31ShockBp("steepener", 10)).toBeCloseTo(hand, 9);
    // Hand-checked value of the book formula at 10Y (the plan text prints 186.5, which the formula does not give; see the task notes).
    expect(srp31ShockBp("steepener", 10)).toBeCloseTo(169.87, 2);
  });

  it("flattener at the front is +0.80 x 300 = +240bp, and at 10Y follows 0.80 x 300 S - 0.60 x 225 (1 - S)", () => {
    expect(srp31ShockBp("flattener", 0)).toBeCloseTo(240, 9);
    const s = Math.exp(-10 / 4);
    const hand = 0.8 * 300 * s - 0.6 * 225 * (1 - s);
    expect(srp31ShockBp("flattener", 10)).toBeCloseTo(hand, 9);
    expect(srp31ShockBp("flattener", 10)).toBeCloseTo(-104.22, 2);
  });

  it("short_down mirrors short_up", () => {
    for (const t of SRP31_TENORS) expect(srp31ShockBp("short_down", t)).toBeCloseTo(-srp31ShockBp("short_up", t), 12);
  });

  it("refuses an unknown name and a negative or non-finite tenor with a sentence naming the argument", () => {
    expect(() => srp31ShockBp("sideways" as Srp31Name, 1)).toThrow(/SRP31 shock name/);
    expect(() => srp31ShockBp("short_up", -1)).toThrow(/tenor/);
    expect(() => srp31ShockBp("short_up", Number.NaN)).toThrow(/tenor/);
  });
});

describe("SRP31_TENORS", () => {
  it("is the eleven curve node tenors, strictly ascending", () => {
    expect([...SRP31_TENORS]).toEqual([0.083333, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30]);
    for (let i = 1; i < SRP31_TENORS.length; i++) expect(SRP31_TENORS[i]).toBeGreaterThan(SRP31_TENORS[i - 1]);
  });
});

describe("srp31Scenario", () => {
  it.each(NAMES.map((n, i) => [n, IDS[i]] as const))("%s has id %s and custom knots at the eleven tenors", (name, id) => {
    const sc = srp31Scenario(name, "example-behavioral-v1");
    expect(sc.id).toBe(id);
    expect(sc.assumptionSetId).toBe("example-behavioral-v1");
    expect(sc.rateSpec.kind).toBe("custom");
    if (sc.rateSpec.kind !== "custom") throw new Error("unreachable");
    expect(sc.rateSpec.shocks.map((k) => k.tenorYears)).toEqual([...SRP31_TENORS]);
    for (const k of sc.rateSpec.shocks) expect(k.shockBp).toBeCloseTo(srp31ShockBp(name, k.tenorYears), 12);
  });

  it.each(NAMES)("%s passes the structural gate of defineScenario", (name) => {
    const sc = srp31Scenario(name, "set-x");
    const built = defineScenario({
      id: sc.id,
      label: sc.label ?? sc.id,
      rateSpec: sc.rateSpec,
      assumptionSetId: "set-x",
      newBusiness: { mode: "static", rules: [] },
    });
    expect(built.rateSpec.kind).toBe("custom");
  });

  it("the custom shift read back at a knot tenor equals the formula at that tenor", () => {
    const sc = srp31Scenario("steepener", "set-x");
    if (sc.rateSpec.kind !== "custom") throw new Error("unreachable");
    expect(customShiftBp(10, sc.rateSpec.shocks)).toBeCloseTo(srp31ShockBp("steepener", 10), 9);
  });

  it("returns fresh objects each call (no shared knot array)", () => {
    const a = srp31Scenario("short_up", "s");
    const b = srp31Scenario("short_up", "s");
    expect(a).not.toBe(b);
    if (a.rateSpec.kind !== "custom" || b.rateSpec.kind !== "custom") throw new Error("unreachable");
    expect(a.rateSpec.shocks).not.toBe(b.rateSpec.shocks);
  });
});

describe("SRP31_USD", () => {
  it("is a library of the six prescribed scenarios and no base", () => {
    expect(SRP31_USD.schemaVersion).toBe("1.0.0");
    expect(SRP31_USD.scenarios.map((s) => s.id)).toEqual(IDS);
    expect(SRP31_USD.scenarios.some((s) => s.rateSpec.kind === "base")).toBe(false);
    expect(SRP31_USD.scenarios.every((s) => s.rateSpec.kind === "custom")).toBe(true);
  });

  it("is not added to SHIPPED_LIBRARIES, so the default scenario listing is unchanged", () => {
    expect(SHIPPED_LIBRARIES.map((l) => l.id)).not.toContain(SRP31_USD.id);
  });
});
