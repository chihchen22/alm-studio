/**
 * Compile through the kernel: the producer set is the mounted
 * plugins' declares.produces, a stage with no mounted component refuses, a type
 * with no mounted producer refuses, and a patch layer that removes the
 * deterministic rate path takes the whole plan with it (second half).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PatchLayer, Plugin } from "@alm/harness";
import { BUILTIN_CATALOG } from "../../plugins/catalog";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { baseAssumptions, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { compilePlan, PlanNotExecutableError, PlanRejected, ScenarioNotExecutableError } from "../compile";
import { fixturePlan, loadPolicy } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

const STAMPS = {
  runId: "RUN-1",
  seed: "42",
  timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" },
};
const resolved = () => ({
  portfolio: twoSidedBook(),
  marketSnapshot: market,
  assumptionSets: [baseAssumptions()],
  policy: loadPolicy(),
  libraries: SHIPPED_LIBRARIES,
  catalog: BUILTIN_CATALOG,
});

describe("compilePlan through a mounted profile", () => {
  it("compiles the fixture plan on the default profile and stamps the profile hash", () => {
    const compiled = compilePlan(fixturePlan(), resolved(), STAMPS);
    expect(compiled.profileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compiled.request.scenarios.length).toBeGreaterThan(0);
    expect(compiled.compile.passed).toBe(true);
    compiled.harness.dispose();
  });

  it("writes the profile and the catalog into the run log before anything else", () => {
    const compiled = compilePlan(fixturePlan(), resolved(), STAMPS);
    expect(compiled.runLog[0]!.t).toBe("profile");
    expect(compiled.runLog.some((e) => e.t === "catalog" && e.pluginId === "engine.metric.nii")).toBe(true);
    expect(compiled.runLog.filter((e) => e.t === "gate").length).toBe(2);
    compiled.harness.dispose();
  });

  it("refuses a stage whose component no mounted plugin provides and whose output a metric reads", () => {
    const plan = fixturePlan();
    plan.stages.push({
      id: "st-hull-white",
      component: "alm-hull-white",
      kind: "term-structure",
      consumes: ["ZeroCurve"],
      produces: ["ClientRatePath"],
      dependsOn: ["st-curve"],
    });
    const metric = plan.stages.find((s) => s.kind === "metric")!;
    metric.consumes = [...metric.consumes, "ClientRatePath"];
    metric.dependsOn = [...(metric.dependsOn ?? []), "st-hull-white"];
    try {
      compilePlan(plan, resolved(), STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanNotExecutableError);
      const e = err as PlanNotExecutableError;
      expect(e.stageId).toBe("st-hull-white");
      expect(e.missing).toEqual({ kind: "component", component: "alm-hull-white" });
    }
  });

  it("refuses a consumed type no mounted plugin produces and no context supplies", () => {
    const plan = fixturePlan();
    const metric = plan.stages.find((s) => s.kind === "metric")!;
    // CapVolSurface IS context-supplied, so the case uses a type that is not:
    // ClientRatePath, which no mounted plugin declares and no stage produces.
    metric.consumes = [...metric.consumes, "ClientRatePath"];
    try {
      compilePlan(plan, resolved(), STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanNotExecutableError);
      expect((err as PlanNotExecutableError).missing).toEqual({ kind: "type", type: "ClientRatePath" });
    }
  });

  it("refuses a scenario naming a rate-path model no plugin registered", () => {
    const plan = fixturePlan();
    plan.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" } },
      { id: "SHW", label: "SHW", rateSpec: { kind: "parallel", shockBp: 100 }, ratePathModel: "hull-white" },
    ];
    try {
      compilePlan(plan, resolved(), STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioNotExecutableError);
      const e = err as ScenarioNotExecutableError;
      expect(e.scenarioId).toBe("SHW");
      expect(e.reason).toContain("hull-white");
      expect(e.reason).toContain("deterministic");
    }
  });

  it("refuses the plan when a patch layer disables the deterministic rate path", () => {
    // The row that carried the model also carried the component the plan's
    // term-structure stage names, so the refusal arrives one step earlier than
    // the scenario check: the stage has nothing to execute it.
    const patches: PatchLayer[] = [
      { label: "swap-the-path", patches: [{ disable: "rate-path.deterministic" }] },
    ];
    try {
      compilePlan(fixturePlan(), { ...resolved(), patches }, STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanNotExecutableError);
      const e = err as PlanNotExecutableError;
      expect(e.stageId).toBe("st-term");
      expect(e.missing).toEqual({ kind: "component", component: "engine.rate-path" });
    }
  });

  it("still refuses when the patch inserts a stub that registers nothing", () => {
    const stub: Plugin = {
      id: "acme.rate-path.stub",
      inject: ["ratePaths"],
      declares: { kind: "term-structure", produces: ["RatePath", "DiscountFactorPath"], consumes: ["ZeroCurve"] },
      apply() { /* registers no model: the row is present and the seam is still empty */ },
    };
    const catalog = new Map(BUILTIN_CATALOG).set(stub.id, stub);
    const patches: PatchLayer[] = [
      {
        label: "stub-the-path",
        patches: [
          { disable: "rate-path.deterministic" },
          { insert: { id: "rate-path.stub", plugin: "acme.rate-path.stub" } },
        ],
      },
    ];
    // The stage names the stub, so the type gate is satisfied: a row IS mounted
    // and it DOES declare the types. What is missing is the registration behind
    // the seam, which only the scenario check can see.
    const plan = fixturePlan();
    plan.stages.find((s) => s.id === "st-term")!.component = stub.id;
    try {
      compilePlan(plan, { ...resolved(), catalog, patches }, STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioNotExecutableError);
      expect((err as ScenarioNotExecutableError).reason).toContain("deterministic");
    }
  });

  it("names the plugin that owned the gate decision, not the built-in it replaced", () => {
    // A policy plugin that returns WITHOUT calling next owns the decision: the
    // built-in type gate never runs, so the log must not credit it.
    const policy: Plugin = {
      id: "acme.policy.standing-waiver",
      apply(ctx) {
        ctx.on(
          "plan/type-check",
          (_payload, value) => ({
            passed: true,
            failures: value.failures,
            checked: [...value.checked, "[acme.policy.standing-waiver] approved under the standing waiver"],
          }),
          { prepend: true },
        );
      },
    };
    const catalog = new Map(BUILTIN_CATALOG).set(policy.id, policy);
    const patches: PatchLayer[] = [
      { label: "bank-policy", patches: [{ insert: { id: "policy.standing-waiver", plugin: policy.id } }] },
    ];
    const compiled = compilePlan(fixturePlan(), { ...resolved(), catalog, patches }, STAMPS);
    const entry = compiled.runLog.find((e) => e.t === "gate" && e.event === "plan/type-check");
    expect(entry).toBeDefined();
    const gate = entry as Extract<typeof entry, { t: "gate" }>;
    expect(gate.listenerPluginId).toBe("acme.policy.standing-waiver");
    expect(gate.contributors).toEqual(["acme.policy.standing-waiver"]);
    // The routing gate ran normally, so it is still credited to the built-in.
    const routing = compiled.runLog.find((e) => e.t === "gate" && e.event === "plan/route") as Extract<typeof entry, { t: "gate" }>;
    expect(routing.listenerPluginId).toBe("engine.gate.routing");
    compiled.harness.dispose();
  });

  it("logs a catalog entry for the rows that actually mounted, and no others", () => {
    const patches: PatchLayer[] = [
      { label: "no-ftp", patches: [{ disable: "metric.ftp" }] },
    ];
    const compiled = compilePlan(fixturePlan(), { ...resolved(), patches }, STAMPS);
    const logged = compiled.runLog.filter((e) => e.t === "catalog").map((e) => (e as { pluginId: string }).pluginId);
    expect(logged).toEqual(compiled.harness.mountedPlugins().map((p) => p.id));
    expect(logged).not.toContain("engine.metric.ftp");
    compiled.harness.dispose();
  });

  it("still refuses both gates as a PlanRejected, with both reports", () => {
    const plan = fixturePlan();
    plan.asOf = "1999-01-01";
    try {
      compilePlan(plan, resolved(), STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRejected);
      expect((err as PlanRejected).type.failures.some((f) => f.rule === "T3")).toBe(true);
    }
  });
});

/**
 * What a refusal carries out with it. A caller rendering a compile refusal has
 * two gate-report slots to fill and no honest way to fill them from the
 * message alone, so compilePlan attaches the reports it actually produced —
 * and attaches NOTHING when the waterfalls never ran, so the caller says "not
 * run" instead of synthesizing a pass.
 */
describe("compile refusals carry their diagnostics", () => {
  it("attaches the real gate reports to a refusal raised after the waterfalls ran", () => {
    const plan = fixturePlan();
    // Mistyped AND unexecutable: the stage refusal is raised before compile
    // checks whether the gates passed, so without the attached reports a
    // caller would have no way to learn the type gate had failed too.
    plan.asOf = "1999-01-01";
    plan.stages.push({
      id: "st-hull-white",
      component: "alm-hull-white",
      kind: "term-structure",
      consumes: ["ZeroCurve"],
      produces: ["ClientRatePath"],
      dependsOn: ["st-curve"],
    });
    const metric = plan.stages.find((s) => s.kind === "metric")!;
    metric.consumes = [...metric.consumes, "ClientRatePath"];
    metric.dependsOn = [...(metric.dependsOn ?? []), "st-hull-white"];
    try {
      compilePlan(plan, resolved(), STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanNotExecutableError);
      const e = err as PlanNotExecutableError;
      expect(e.gates).toBeDefined();
      expect(e.gates!.type.passed).toBe(false);
      expect(e.gates!.type.failures.some((f) => f.rule === "T3")).toBe(true);
      expect(e.gates!.routing.passed).toBe(true);
      expect(e.runLog!.some((entry) => entry.t === "gate")).toBe(true);
    }
  });

  it("attaches NO gate reports, but does attach the log, when the profile will not mount", () => {
    const plan = fixturePlan();
    plan.profile = { rows: [{ id: "r-ghost", plugin: "acme.not.installed" }] };
    try {
      compilePlan(plan, resolved(), STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRejected);
      const e = err as PlanRejected;
      // The gates never ran; absent is how the caller knows.
      expect(e.gates).toBeUndefined();
      // The rows it tried and the kernel's word on them still come out.
      expect(e.runLog).toBeDefined();
      expect(e.runLog![0]!.t).toBe("profile");
      expect(
        e.runLog!.some((entry) => entry.t === "refuse" && entry.error.includes("acme.not.installed")),
      ).toBe(true);
    }
  });

  it("attaches the reports to a scenario refusal, which both gates preceded", () => {
    const plan = fixturePlan();
    plan.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" } },
      { id: "R200", label: "R200", rateSpec: { kind: "parallel", shockBp: 200 }, timing: { kind: "ramp", months: 12 } },
    ];
    try {
      compilePlan(plan, resolved(), STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioNotExecutableError);
      const e = err as ScenarioNotExecutableError;
      expect(e.gates!.type.passed).toBe(true);
      expect(e.gates!.routing.passed).toBe(true);
    }
  });
});
