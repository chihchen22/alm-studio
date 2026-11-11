// packages/reader/src/__tests__/planDiff.test.ts
import { describe, expect, it } from "vitest";
import type { RunPlan } from "@alm/engine";
import { planDiff, planDiffIsEmpty, seededPlanIdFor } from "../planDiff";

type S = { id: string; component: string; dependsOn?: string[] };
const plan = (planId: string, stages: S[]) => ({ planId, stages }) as unknown as RunPlan;

const BASE = plan("plan-book", [
  { id: "st-curve", component: "alm-yield-curve" },
  { id: "st-cf", component: "engine.contractual", dependsOn: ["st-curve"] },
  { id: "st-ftp", component: "engine.metric.ftp", dependsOn: ["st-curve", "st-cf"] },
]);

describe("planDiff", () => {
  it("is empty for a structurally identical plan", () => {
    const d = planDiff(BASE, plan("plan-book-edit-1", BASE.stages as unknown as S[]));
    expect(planDiffIsEmpty(d)).toBe(true);
  });

  it("names a swapped component with from and to", () => {
    const edited = plan("x", [
      { id: "st-curve", component: "alm-yield-curve" },
      { id: "st-cf", component: "engine.contractual", dependsOn: ["st-curve"] },
      { id: "st-ftp", component: "alm-ftp", dependsOn: ["st-curve", "st-cf"] },
    ]);
    const d = planDiff(BASE, edited);
    expect(d.componentChanges).toEqual([{ stageId: "st-ftp", from: "engine.metric.ftp", to: "alm-ftp" }]);
    expect(d.wiresAdded).toEqual([]);
    expect(d.wiresRemoved).toEqual([]);
  });

  it("lists a removed and an added wire as edges from -> to", () => {
    const edited = plan("x", [
      { id: "st-curve", component: "alm-yield-curve" },
      { id: "st-cf", component: "engine.contractual" },
      { id: "st-ftp", component: "engine.metric.ftp", dependsOn: ["st-curve", "st-cf"] },
    ]);
    expect(planDiff(BASE, edited).wiresRemoved).toEqual([{ from: "st-curve", to: "st-cf" }]);
    expect(planDiff(edited, BASE).wiresAdded).toEqual([{ from: "st-curve", to: "st-cf" }]);
  });

  it("lists stages added and removed, with their wires", () => {
    const edited = plan("x", [
      { id: "st-curve", component: "alm-yield-curve" },
      { id: "st-cf", component: "engine.contractual", dependsOn: ["st-curve"] },
      { id: "st-gap", component: "alm-gap-analytics", dependsOn: ["st-cf"] },
    ]);
    const d = planDiff(BASE, edited);
    expect(d.stagesAdded).toEqual(["st-gap"]);
    expect(d.stagesRemoved).toEqual(["st-ftp"]);
    expect(d.wiresAdded).toEqual([{ from: "st-cf", to: "st-gap" }]);
    expect(d.wiresRemoved).toEqual([{ from: "st-curve", to: "st-ftp" }, { from: "st-cf", to: "st-ftp" }]);
    expect(d.componentChanges).toEqual([]);
  });

  it("names the seeded plan of a book by the seed convention", () => {
    expect(seededPlanIdFor("synthetic-2500-v1")).toBe("plan-synthetic-2500-v1");
    expect(seededPlanIdFor("vanilla-book-v1")).toBe("plan-vanilla-book-v1");
  });
});
