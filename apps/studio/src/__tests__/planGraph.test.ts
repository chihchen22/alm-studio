import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { laneOf, planGraph, type PlanDoc } from "../plan/planGraph";
import { serializePlan } from "../plan/planEdits";

const EXAMPLE = fileURLToPath(new URL("../../../../docs/harness/example-plan.json", import.meta.url));

describe("planGraph", () => {
  it("round-trips example-plan.json to its canonical JSON form, byte for byte", () => {
    const text = readFileSync(EXAMPLE, "utf8");
    const plan = JSON.parse(text) as PlanDoc;
    planGraph(plan); // drawing never mutates
    expect(serializePlan(plan)).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  it("puts each stage kind in its lane, unknown kinds in Other", () => {
    expect(laneOf("curve")).toBe("market");
    expect(laneOf("market-data")).toBe("market");
    expect(laneOf("contractual-cashflow")).toBe("book");
    expect(laneOf("behavioral")).toBe("behavior");
    expect(laneOf("balance-new-business")).toBe("balance");
    expect(laneOf("term-structure")).toBe("scenarios");
    expect(laneOf("metric")).toBe("metrics");
    expect(laneOf("calibration")).toBe("other");
  });

  it("draws one node per stage and one edge per resolved dependsOn entry, typed by the shared types", () => {
    const plan = JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;
    const g = planGraph(plan);
    expect(g.nodes.map((n) => n.stageId)).toEqual(plan.stages.map((s) => s.id));
    const e = g.edges.find((x) => x.from === "st-term" && x.to === "st-cashflow")!;
    expect(e.id).toBe("st-term->st-cashflow");
    expect(e.types).toEqual(["RatePath"]);
    const resolved = plan.stages.flatMap((s) => (s.dependsOn ?? []).filter((d) => plan.stages.some((x) => x.id === d)));
    expect(g.edges).toHaveLength(resolved.length);
  });

  it("gives depth 0 to roots and 1 + max(parent depth) otherwise, ignoring unresolved ids", () => {
    const plan = JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;
    plan.stages.find((s) => s.id === "st-term")!.dependsOn = ["st-curve", "st-nowhere"];
    const g = planGraph(plan);
    const depth = (id: string) => g.nodes.find((n) => n.stageId === id)!.depth;
    expect(depth("st-curve")).toBe(0);
    expect(depth("st-term")).toBe(1);
    expect(depth("st-tlp")).toBe(1);
  });

  it("survives a dependsOn cycle without looping", () => {
    const plan = JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;
    plan.stages.find((s) => s.id === "st-curve")!.dependsOn = ["st-term"];
    const g = planGraph(plan);
    expect(g.nodes).toHaveLength(plan.stages.length);
  });

  it("lists only lanes that hold a node, in lane order", () => {
    const plan = JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;
    expect(planGraph(plan).lanes).toEqual(["market", "book", "behavior", "balance", "scenarios", "metrics"]);
  });
});
