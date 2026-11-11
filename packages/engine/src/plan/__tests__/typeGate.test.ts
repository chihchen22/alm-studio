import { afterAll, describe, expect, it } from "vitest";
import { mountProfile } from "@alm/harness";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { AS_OF } from "../../run/__tests__/fixtures";
import { registryProducers } from "../compile";
import { stageExecutability, typeGate } from "../typeGate";
import { fixturePlan } from "./fixtures";

/** The producer set of the shipped default profile: what the gate checks against. */
const profileCtx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
const PRODUCERS = registryProducers(profileCtx);
afterAll(() => profileCtx.dispose());

const rules = (r: ReturnType<typeof typeGate>) => r.failures.map((f) => `${f.rule}:${f.stageId}`);

describe("typeGate", () => {
  it("passes the fixture plan and lists every check it ran", () => {
    const r = typeGate(fixturePlan(), AS_OF, PRODUCERS);
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.checked.some((c) => c.startsWith("T1"))).toBe(true);
    expect(r.checked.some((c) => c.startsWith("T5"))).toBe(true);
  });
  it("T1: a consumed type with no producer and no context supply fails, naming the type", () => {
    const p = fixturePlan();
    const nii = p.stages.find((s) => s.id === "st-nii")!;
    nii.consumes = ["Cashflow", "ClientRatePath"];
    const r = typeGate(p, AS_OF, PRODUCERS);
    expect(rules(r)).toContain("T1:st-nii");
    expect(r.failures.some((f) => f.detail.includes("ClientRatePath"))).toBe(true);
  });
  it("T1: a context-supplied type needs no producer", () => {
    expect(typeGate(fixturePlan(), AS_OF, PRODUCERS).failures.filter((f) => f.rule === "T1")).toEqual([]);
  });
  it("T2: a curve stage without a dayCount param fails", () => {
    const p = fixturePlan();
    delete p.stages.find((s) => s.id === "st-curve")!.params;
    expect(rules(typeGate(p, AS_OF, PRODUCERS))).toContain("T2:st-curve");
  });
  it("T3: an asOf mismatch with the portfolio fails plan-wide", () => {
    const r = typeGate(fixturePlan(), "2025-12-31", PRODUCERS);
    expect(rules(r)).toContain("T3:null");
  });
  it("T3: a horizon outside 1..360 fails", () => {
    const p = fixturePlan();
    p.grid.horizonMonths = 361;
    expect(rules(typeGate(p, AS_OF, PRODUCERS))).toContain("T3:null");
  });
  it("T4: an unresolved dependsOn fails on the stage", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-term")!.dependsOn = ["st-missing"];
    expect(rules(typeGate(p, AS_OF, PRODUCERS))).toContain("T4:st-term");
  });
  it("T4: a cycle fails plan-wide", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-curve")!.dependsOn = ["st-term"];
    expect(rules(typeGate(p, AS_OF, PRODUCERS))).toContain("T4:null");
  });
  it("T5: a stage that reaches no metric fails", () => {
    const p = fixturePlan();
    p.stages.push({ id: "st-orphan", component: "alm-loan-client-rate", kind: "behavioral", consumes: ["RatePath"], produces: ["ClientRatePath"], dependsOn: ["st-term"] });
    expect(rules(typeGate(p, AS_OF, PRODUCERS))).toContain("T5:st-orphan");
  });
  it("T3: a stage horizon that differs from the grid fails on the stage", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-cashflow")!.params = { horizonMonths: 120 };
    const f = typeGate(p, AS_OF, PRODUCERS).failures.find((x) => x.rule === "T3" && x.stageId === "st-cashflow");
    expect(f).toBeDefined();
    expect(f!.detail).toContain("120");
  });
  /**
   * Final fix wave, finding 4. Two stages the profile cannot execute, both
   * declaring the same type, do not excuse each other. A cover has to be a
   * stage the profile actually mounts, or the plan would compile with nothing
   * computing the value the metric reads.
   */
  it("T1: two unexecutable stages producing the same consumed type are BOTH refused", () => {
    const p = fixturePlan();
    const unmounted = (id: string, component: string): (typeof p.stages)[number] => ({
      id, component, kind: "behavioral",
      consumes: ["RatePath"], produces: ["ClientRatePath"], dependsOn: ["st-term"],
      selector: { productFamily: "MORTGAGE", behavioralClasses: "client-rate-asset" },
      disposition: "M", tier: "Tier 1", feeds: ["nii"],
    });
    p.stages.push(unmounted("st-cr-a", "alm-loan-client-rate"));
    p.stages.push(unmounted("st-cr-b", "alm-draw-rate-model"));
    const nii = p.stages.find((s) => s.id === "st-nii")!;
    nii.consumes = [...nii.consumes, "ClientRatePath"];
    nii.dependsOn = [...(nii.dependsOn ?? []), "st-cr-a", "st-cr-b"];

    const gaps = stageExecutability(p, PRODUCERS);
    const refusedComponents = gaps.refusals
      .filter((g) => g.missing.kind === "component")
      .map((g) => g.stageId);
    expect(refusedComponents).toContain("st-cr-a");
    expect(refusedComponents).toContain("st-cr-b");
    expect(gaps.tolerated.map((t) => t.stageId)).not.toContain("st-cr-a");
    expect(gaps.tolerated.map((t) => t.stageId)).not.toContain("st-cr-b");

    // And the gate says so: sole-producer refusals on both stages.
    expect(rules(typeGate(p, AS_OF, PRODUCERS))).toEqual(
      expect.arrayContaining(["T1:st-cr-a", "T1:st-cr-b"]),
    );
  });

  /** The other half: a MOUNTED co-producer still covers, so nothing over-refuses. */
  it("T1: a mounted co-producer covers an unexecutable stage, which stays tolerated", () => {
    const p = fixturePlan();
    // engine.rate-path is mounted and already produces RatePath, so this stage
    // is not the sole producer of anything the plan reads.
    p.stages.push({
      id: "st-hw", component: "alm-hull-white", kind: "term-structure",
      consumes: ["ZeroCurve"], produces: ["RatePath"], dependsOn: ["st-curve"],
    });
    p.stages.find((s) => s.id === "st-cashflow")!.dependsOn = ["st-term", "st-hw"];
    const gaps = stageExecutability(p, PRODUCERS);
    expect(gaps.tolerated.map((t) => t.stageId)).toContain("st-hw");
    expect(gaps.refusals.map((g) => g.stageId)).not.toContain("st-hw");
  });

  it("T5: a stage reachable from no context input fails, isolated from every other rule", () => {
    const p = fixturePlan();
    p.stages.push({ id: "st-detached", component: "alm-seg", kind: "metric", consumes: [], produces: ["NiiResult"], dependsOn: [] });
    const r = typeGate(p, AS_OF, PRODUCERS);
    const f = r.failures.find((x) => x.rule === "T5" && x.stageId === "st-detached");
    expect(f).toBeDefined();
    expect(f!.detail).toBe("not reachable from any context input");
    expect(r.failures).toHaveLength(1);
  });
});
