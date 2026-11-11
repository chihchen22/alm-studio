// apps/studio/src/__tests__/guidedSetup.test.ts
/**
 * The guided run setup and its step edits (S2a spec points 6, 7, 8 and 9). Expected values are written out by hand:
 * the scenario lists name their library references literally, and the six standardized shocks are checked at chosen
 * tenors against the published formulas (short shock 300 bp times exp(-t/4); steepener -0.65 short + 0.9 long, the long
 * shock 225 bp times (1 - exp(-t/4))), never against the engine's own function.
 */
import { describe, expect, it } from "vitest";
import type { RunSetup } from "@alm/reader";
import {
  baseSlate, choiceOf, guidedSetupBody, nextVersion, scenarioCount, scenariosOf, simulationOf, simulationProblems, stochasticRunBody,
  withBasis, withInstrumentResults, withScenarios, withSimulation, withView,
} from "../guided/setup";

describe("the guided setup", () => {
  it("starts from the maturing-balances answer and nothing else chosen for the user", () => {
    expect(guidedSetupBody({ kind: "runoff" }).nii.basis).toEqual({ kind: "runoff" });
    expect(guidedSetupBody({ kind: "flat" }).nii.basis).toEqual({ kind: "flat", termMonths: 60, spreadOverIndexBp: 0 });
    expect(guidedSetupBody({ kind: "custom", balancePlanId: "bp-x" }).nii.basis).toEqual({ kind: "custom", balancePlanId: "bp-x" });
    const s = guidedSetupBody({ kind: "runoff" });
    expect(s.name).toBe("Guided analysis");
    expect(s.inputs).toEqual({ book: { role: "base" }, market: { role: "base" }, assumptionSetIds: { kind: "block-default" } });
    expect(s.eve.path).toBe("single");
    expect(s.eve.stochastic).toBeUndefined();
    expect(s.instrumentResults.save).toBe(false);
  });
  it("a new version supersedes the current document and drops its id", () => {
    const current: RunSetup = { id: "rs-abc", ...guidedSetupBody({ kind: "runoff" }) };
    const next = nextVersion(current, (b) => withBasis(b, { kind: "flat" }));
    expect("id" in next).toBe(false);
    expect(next.supersedes).toBe("rs-abc");
    expect(next.nii.basis.kind).toBe("flat");
  });
});

describe("scenario presets", () => {
  it("the parallel grid alone is the library list with the base first", () => {
    expect(scenariosOf({ presets: ["parallel"], custom: [] })).toEqual({
      kind: "library",
      refs: ["regulatory-grid-v1#S0", "regulatory-grid-v1#S100", "regulatory-grid-v1#S-100", "regulatory-grid-v1#S200", "regulatory-grid-v1#S-200"],
    });
  });
  it("twists add the steepener and flattener; nothing chosen still runs the base", () => {
    expect(scenariosOf({ presets: ["twists"], custom: [] })).toEqual({ kind: "library", refs: ["regulatory-grid-v1#S0", "steepener-v1#STEEP100", "flattener-v1#FLAT100"] });
    expect(scenariosOf({ presets: [], custom: [] })).toEqual({ kind: "library", refs: ["regulatory-grid-v1#S0"] });
  });
  it("the six standardized shocks are inline tenor-knot definitions at the published sizes", () => {
    const sc = scenariosOf({ presets: ["regulatory-six"], custom: [] });
    expect(sc.kind).toBe("plan-scenarios");
    if (sc.kind !== "plan-scenarios") return;
    expect(sc.items[0]).toEqual({ ref: "regulatory-grid-v1#S0" });
    const defs = sc.items.slice(1) as Array<{ id: string; rateSpec: { kind: string; shocks: Array<{ tenorYears: number; shockBp: number }> } }>;
    expect(defs.map((d) => d.id)).toEqual(["SRP-PUP", "SRP-PDN", "SRP-SUP", "SRP-SDN", "SRP-STEEP", "SRP-FLAT"]);
    const at = (id: string, t: number) => defs.find((d) => d.id === id)!.rateSpec.shocks.find((k) => k.tenorYears === t)!.shockBp;
    expect(at("SRP-PUP", 10)).toBe(200);
    expect(at("SRP-PDN", 0.25)).toBe(-200);
    expect(at("SRP-SUP", 1)).toBeCloseTo(300 * Math.exp(-1 / 4), 9); // 233.64 bp
    const s10 = Math.exp(-10 / 4);
    expect(at("SRP-STEEP", 10)).toBeCloseTo(-0.65 * 300 * s10 + 0.9 * 225 * (1 - s10), 9); // 169.87 bp
    expect(at("SRP-FLAT", 10)).toBeCloseTo(0.8 * 300 * s10 - 0.6 * 225 * (1 - s10), 9);
    expect(defs.every((d) => !("assumptionSetId" in d))).toBe(true);
  });
  it("a custom tenor shock is saved into the setup beside the presets", () => {
    const choice = { presets: ["parallel" as const], custom: [{ id: "MY-TWIST", label: "My twist", knots: [{ tenorYears: 1, shockBp: 50 }, { tenorYears: 10, shockBp: -25 }] }] };
    const sc = scenariosOf(choice);
    expect(sc.kind).toBe("plan-scenarios");
    if (sc.kind !== "plan-scenarios") return;
    expect(sc.items).toHaveLength(6);
    expect(sc.items[5]).toEqual({ id: "MY-TWIST", label: "My twist", rateSpec: { kind: "custom", shocks: [{ tenorYears: 1, shockBp: 50 }, { tenorYears: 10, shockBp: -25 }] } });
    expect(scenarioCount(choice)).toBe(6);
    const s = withScenarios(guidedSetupBody({ kind: "runoff" }), choice);
    expect(choiceOf(s.scenarios)).toEqual(choice);
  });
  it("reads every preset combination back, and refuses to read a list it did not write", () => {
    const all = { presets: ["parallel" as const, "regulatory-six" as const, "twists" as const], custom: [] };
    expect(choiceOf(scenariosOf(all))).toEqual(all);
    expect(scenarioCount(all)).toBe(1 + 4 + 2 + 6);
    expect(choiceOf({ kind: "library", refs: ["ramp-200-12m-v1#R200"] })).toBeNull();
    expect(choiceOf({ kind: "slate", slateId: "s", include: "all" })).toBeNull();
  });
  it("never offers a ramp", () => {
    const sc = scenariosOf({ presets: ["parallel", "regulatory-six", "twists"], custom: [] });
    expect(JSON.stringify(sc)).not.toMatch(/ramp/);
  });
});

describe("simulation", () => {
  const body = () => guidedSetupBody({ kind: "runoff" });
  it("a stochastic choice is stored beside the one-path EVE settings, and taken out again", () => {
    const st = withSimulation(body(), { kind: "stochastic", model: "bgm-lmm-2f", nPaths: 64, seed: "7" });
    expect(st.eve.path).toBe("single");
    expect(st.eve.stochastic).toEqual({ nPaths: 64, seed: "7", model: "bgm-lmm-2f" });
    expect(simulationOf(st)).toEqual({ kind: "stochastic", model: "bgm-lmm-2f", nPaths: 64, seed: "7" });
    const back = withSimulation(st, { kind: "deterministic" });
    expect(back.eve).toEqual(body().eve);
    expect(simulationOf(back)).toEqual({ kind: "deterministic" });
  });
  it("checks paths and seed in words", () => {
    expect(simulationProblems("64", "42")).toEqual([]);
    expect(simulationProblems("10", "42")).toEqual(["Use from 20 to 256 paths."]);
    expect(simulationProblems("65", "42")).toEqual(["Use an even number of paths: they run in mirrored pairs."]);
    expect(simulationProblems("x", "y")).toEqual(["Type the number of paths as a whole number.", "Type the seed as a whole number."]);
  });
  it("builds the existing stochastic run request and a base-only slate", () => {
    expect(stochasticRunBody({ portfolioId: "b", marketId: "m", slateId: "sl", assumptionSetId: "set", choice: { kind: "stochastic", model: "hull-white-1f", nPaths: 64, seed: "42" }, label: "L" })).toEqual({
      portfolioId: "b", marketId: "m", scenarioSlateId: "sl", assumptionSetIds: ["set"], seed: "42", mode: "stochastic", stochastic: { nPaths: 64, model: "hull-white-1f" }, label: "L",
    });
    expect(baseSlate("sl", "set").scenarios).toEqual([{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "set", newBusiness: { mode: "static", rules: [] } }]);
  });
});

describe("report re-run extras", () => {
  it("per-position results and a view by one dimension, each added once", () => {
    const s = withInstrumentResults(guidedSetupBody({ kind: "runoff" }), ["assets-root", "liabilities-root"]);
    // The platform refuses save: true with no node; the book's top-level nodes reach every leaf.
    expect(s.instrumentResults).toEqual({ save: true, coaNodeIds: ["assets-root", "liabilities-root"] });
    const v = withView(withView(s, "segment", "By segment"), "segment", "By segment");
    expect(v.plan.views).toEqual([{ id: "by-segment", label: "By segment", groupBy: ["segment"] }]);
  });
});
