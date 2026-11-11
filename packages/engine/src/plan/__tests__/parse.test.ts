import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRunPlan, parseRoutingPolicy, PlanShapeError } from "../parse";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const examplePlan = () => JSON.parse(readFileSync(`${ROOT}docs/harness/example-plan.json`, "utf8"));
const modelMap = () => JSON.parse(readFileSync(`${ROOT}docs/harness/model-map.json`, "utf8"));

describe("parseRunPlan", () => {
  it("accepts the example plan verbatim", () => {
    const plan = parseRunPlan(examplePlan());
    expect(plan.planId).toBe("PLAN-EXAMPLE-IRRBB-1");
    expect(plan.stages.length).toBe(17);
    expect(plan.scenarios.length).toBe(5);
  });
  it("names the field on a shape failure", () => {
    const bad = { ...examplePlan(), stages: "nope" };
    expect(() => parseRunPlan(bad)).toThrow(PlanShapeError);
    expect(() => parseRunPlan(bad)).toThrow("stages");
  });
  it("refuses an unknown contract type name on a stage edge", () => {
    const p = examplePlan();
    p.stages[0].produces = ["Curve"];
    expect(() => parseRunPlan(p)).toThrow('stages[0].produces[0]: unknown contract type "Curve"');
  });
  it("refuses a schemaVersion other than 1.4.0", () => {
    expect(() => parseRunPlan({ ...examplePlan(), schemaVersion: "2.0.0" })).toThrow("schemaVersion");
  });
  it("keeps a { ref } scenario as a reference and drops nothing else onto it", () => {
    const p = examplePlan();
    p.scenarios[0] = { ref: "SCN-STD-UP-200" };
    const plan = parseRunPlan(p);
    expect(plan.scenarios[0]).toEqual({ ref: "SCN-STD-UP-200" });
  });
  it("refuses an inline scenario with no rateSpec", () => {
    const p = examplePlan();
    p.scenarios[1] = { id: "S-broken" };
    expect(() => parseRunPlan(p)).toThrow("scenarios[1].rateSpec");
  });
  it("refuses a ramp timing with months 0, naming the field", () => {
    const p = examplePlan();
    p.scenarios[1] = { id: "S-ramp", label: "Ramp", rateSpec: { kind: "parallel", shockBp: 200 }, timing: { kind: "ramp", months: 0 } };
    expect(() => parseRunPlan(p)).toThrow(PlanShapeError);
    expect(() => parseRunPlan(p)).toThrow("scenarios[1].timing.months");
  });
  it("keeps the inline scenario body of a non-ref entry", () => {
    const plan = parseRunPlan(examplePlan());
    expect(plan.scenarios[1]).toMatchObject({ id: "S100", rateSpec: { kind: "parallel", shockBp: 100 } });
  });
  it("accepts array-valued selector.productFamily and selector.behavioralClasses", () => {
    const p = examplePlan();
    p.stages[4].selector = {
      productFamily: ["Mortgages", "Fixed Loans"],
      behavioralClasses: ["prepayment", "client-rate-asset"],
      side: "Asset",
    };
    const plan = parseRunPlan(p);
    expect(plan.stages[4].selector).toEqual({
      productFamily: ["Mortgages", "Fixed Loans"],
      behavioralClasses: ["prepayment", "client-rate-asset"],
      side: "Asset",
    });
  });
  it("keeps the scalar selector forms scalar", () => {
    const plan = parseRunPlan(examplePlan());
    expect(plan.stages[4].selector).toEqual({ behavioralClasses: "prepayment", productFamily: "Fixed Loans" });
  });
  it("refuses an unknown behavioral class inside an array selector", () => {
    const p = examplePlan();
    p.stages[4].selector.behavioralClasses = ["prepayment", "vibes"];
    expect(() => parseRunPlan(p)).toThrow('stages[4].selector.behavioralClasses: unknown behavioral class "vibes"');
  });
  it("passes through balancePlan, assumptionSets and dimensionTaxonomy", () => {
    const p = examplePlan();
    p.balancePlan = "balance-plan-v1.json";
    p.inputs.assumptionSets = ["AS-BASE", "AS-STRESS"];
    const plan = parseRunPlan(p);
    expect(plan.balancePlan).toBe("balance-plan-v1.json");
    expect(plan.inputs.assumptionSets).toEqual(["AS-BASE", "AS-STRESS"]);
    // The cross-check names the book's taxonomy ID, not the file it lives in.
    expect(plan.inputs.dimensionTaxonomy).toBe("demo-dimensions-v1");
  });
  it("omits balancePlan and assumptionSets when the plan omits them", () => {
    const plan = parseRunPlan(examplePlan());
    expect(plan.balancePlan).toBeUndefined();
    expect(plan.inputs.assumptionSets).toBeUndefined();
  });
});

describe("parseRoutingPolicy", () => {
  it("accepts model-map.json and exposes classes by id", () => {
    const policy = parseRoutingPolicy(modelMap());
    expect(policy.classes.map((c) => c.id)).toContain("decay");
    expect(policy.classes.find((c) => c.id === "decay")!.routing.nii).toBe("none");
  });
  it("refuses a routing value outside M | A | none", () => {
    const m = modelMap();
    m.classes[0].routing.nii = "maybe";
    expect(() => parseRoutingPolicy(m)).toThrow("classes[0].routing.nii");
  });
});

describe("selector.dimensions", () => {
  it("parses a scalar and a list predicate", () => {
    const doc = examplePlan() as { stages: Array<Record<string, unknown>> };
    const stage = doc.stages.find((s) => s.id === "st-beta-hys")!;
    stage.selector = { behavioralClasses: "deposit-beta", dimensions: { segment: ["Rate shoppers", "Relationship"], rateType: "Administered" } };
    const plan = parseRunPlan(doc);
    expect(plan.stages.find((s) => s.id === "st-beta-hys")!.selector).toEqual({
      behavioralClasses: "deposit-beta",
      dimensions: { segment: ["Rate shoppers", "Relationship"], rateType: "Administered" },
    });
  });
  it("refuses a predicate value that is not a string or a string list", () => {
    const doc = examplePlan() as { stages: Array<Record<string, unknown>> };
    doc.stages.find((s) => s.id === "st-beta-hys")!.selector = { behavioralClasses: "deposit-beta", dimensions: { segment: 3 } };
    expect(() => parseRunPlan(doc)).toThrow(/selector\.dimensions\.segment/);
  });
});

describe("piece 2b: the plan's view list", () => {
  it("parses a views array onto the plan", () => {
    const raw = { ...examplePlan(), views: [{ id: "by-segment", label: "By segment", groupBy: ["segment"] }] };
    const plan = parseRunPlan(raw);
    expect(plan.views).toEqual([{ id: "by-segment", label: "By segment", groupBy: ["segment"] }]);
  });
  it("leaves views absent when the plan declares none", () => {
    expect(parseRunPlan(examplePlan()).views).toBeUndefined();
  });
  it("refuses a view with no groupBy, naming the field", () => {
    const raw = { ...examplePlan(), views: [{ id: "v", label: "V" }] };
    expect(() => parseRunPlan(raw)).toThrow(/views\[0\]\.groupBy/);
  });
  it("refuses a view whose id is not a non-empty string", () => {
    const raw = { ...examplePlan(), views: [{ id: "", label: "V", groupBy: ["segment"] }] };
    expect(() => parseRunPlan(raw)).toThrow(/views\[0\]\.id/);
  });
});
