/**
 * The run log renders as a tree. The grouping is presentation only: every line
 * is the server's own entry, and nothing here derives a number or a verdict.
 */
import { describe, expect, it } from "vitest";
import type { RunLogEntry } from "@alm/engine";
import { runLogTree } from "../format";

const entries: RunLogEntry[] = [
  { t: "profile", profileHash: "abc", rows: [{ id: "metric.nii", plugin: "engine.metric.nii", configHash: "0", state: "active" }] },
  { t: "catalog", pluginId: "engine.metric.nii", source: "builtin" },
  { t: "catalog", pluginId: "acme.behavioral.burnout", source: { path: "var/plugins/burnout.mjs", sha256: "def" } },
  { t: "gate", event: "plan/type-check", listenerPluginId: "engine.gate.type", contributors: ["engine.gate.type"], passed: true, failures: [] },
  { t: "resolve", key: "metrics", pluginId: "engine.metric.nii", scope: { scenarioId: "S0", metricId: "nii" } },
  { t: "resolve", key: "metrics", pluginId: "engine.metric.eve", scope: { scenarioId: "S0", metricId: "eve" } },
  { t: "resolve", key: "curves", pluginId: "engine.curve.bootstrap", scope: {} },
  { t: "refuse", error: "ftp.seasoned-book", ids: { scenarioId: "S0" } },
];

describe("runLogTree", () => {
  it("groups into profile, catalog, gates, run and refusals, in that order", () => {
    expect(runLogTree(entries).map((n) => n.label)).toEqual([
      "Profile",
      "Catalog",
      "Gates",
      "Run",
      "Refusals",
    ]);
  });

  it("puts every scenario-scoped resolve under its scenario", () => {
    const run = runLogTree(entries).find((n) => n.label === "Run")!;
    const s0 = run.children.find((c) => c.label === "S0")!;
    expect(s0.children.map((c) => c.label)).toEqual([
      "metrics: engine.metric.nii (nii)",
      "metrics: engine.metric.eve (eve)",
    ]);
  });

  it("puts an unscoped resolve under the run node directly", () => {
    const run = runLogTree(entries).find((n) => n.label === "Run")!;
    expect(run.children.some((c) => c.label === "curves: engine.curve.bootstrap")).toBe(true);
  });

  it("shows an operator plugin's file and hash on its catalog line", () => {
    const catalog = runLogTree(entries).find((n) => n.label === "Catalog")!;
    const line = catalog.children.find((c) => c.label.includes("acme.behavioral.burnout"))!;
    expect(line.label).toContain("var/plugins/burnout.mjs");
    expect(line.label).toContain("def");
  });

  it("returns no node for a group with no entries", () => {
    const tree = runLogTree([{ t: "catalog", pluginId: "engine.metric.nii", source: "builtin" }]);
    expect(tree.map((n) => n.label)).toEqual(["Catalog"]);
  });

  it("names a failing gate's failures under it", () => {
    const tree = runLogTree([
      {
        t: "gate",
        event: "plan/route",
        listenerPluginId: "engine.gate.routing",
        contributors: ["engine.gate.routing"],
        passed: false,
        failures: [{ gate: "routing", rule: "R1", stageId: "st-decay", detail: "class \"decay\" may not feed metric \"nii\"" }],
      },
    ]);
    const gates = tree.find((n) => n.label === "Gates")!;
    expect(gates.children[0]!.label).toBe("plan/route by engine.gate.routing: 1 failure(s)");
    expect(gates.children[0]!.children.map((c) => c.label)).toEqual([
      'R1@st-decay: class "decay" may not feed metric "nii"',
    ]);
  });

  it("groups license entries under Licenses by stage, after Stages and before Catalog, and never under Other entries", () => {
    const tree = runLogTree([
      { t: "stage", stageId: "st-decay", pluginId: "alm-deposit-decay", kind: "behavioral", consumed: [], produced: [] },
      { t: "catalog", pluginId: "engine.metric.nii", source: "builtin" },
      {
        t: "license",
        stageId: "st-decay",
        assumptionSetId: "AS-SEGMENTED",
        familyId: "DDA",
        kind: "decay",
        bindingIndex: 3,
        selector: '{"segment":["relationship"]}',
        positionsMatched: 2,
      },
      {
        t: "license",
        stageId: "st-decay",
        assumptionSetId: "AS-SEGMENTED",
        familyId: "DDA",
        kind: "decay",
        bindingIndex: 1,
        positionsMatched: 3,
      },
    ]);
    expect(tree.map((n) => n.label)).toEqual(["Stages", "Licenses", "Catalog"]);
    const licenses = tree.find((n) => n.label === "Licenses")!;
    expect(licenses.children.map((c) => c.label)).toEqual(["st-decay"]);
    expect(licenses.children[0]!.children.map((c) => c.label)).toEqual([
      'AS-SEGMENTED bindings[3]: DDA / decay on {"segment":["relationship"]}, 2 position(s)',
      "AS-SEGMENTED bindings[1]: DDA / decay on whole family, 3 position(s)",
    ]);
    expect(tree.some((n) => n.label === "Other entries")).toBe(false);
  });

  it("lists a stage's bindings after its consumes and produces, and leaves a stage without bindings unchanged", () => {
    const withBindings: RunLogEntry = {
      t: "stage",
      stageId: "st-decay",
      pluginId: "alm-deposit-decay",
      kind: "behavioral",
      consumed: [{ type: "Position", scope: "run", producerStageId: "st-book" }],
      produced: [{ type: "Position", scope: "run" }],
      bindings: [
        { assumptionSetId: "AS-SEGMENTED", bindingIndex: 1, positionsMatched: 3 },
        { assumptionSetId: "AS-SEGMENTED", bindingIndex: 3, positionsMatched: 2 },
      ],
    };
    const stage = runLogTree([withBindings]).find((n) => n.label === "Stages")!.children[0]!;
    expect(stage.children.map((c) => c.label)).toEqual([
      "consumes Position@run from st-book",
      "produces Position@run",
      "applies AS-SEGMENTED bindings[1] to 3 position(s)",
      "applies AS-SEGMENTED bindings[3] to 2 position(s)",
    ]);
    const { bindings: _dropped, ...without } = withBindings;
    const plain = runLogTree([without as RunLogEntry]).find((n) => n.label === "Stages")!.children[0]!;
    expect(plain.children.map((c) => c.label)).toEqual([
      "consumes Position@run from st-book",
      "produces Position@run",
    ]);
  });
});

describe("the plan and stage arms", () => {
  const walked: RunLogEntry[] = [
    { t: "plan", derived: false, planId: "PLAN-1", stageIds: ["st-curve", "st-nii"] },
    {
      t: "stage",
      stageId: "st-curve",
      pluginId: "engine.curve.bootstrap",
      kind: "curve",
      consumed: [],
      produced: [{ type: "ZeroCurve", scope: "run" }],
    },
    {
      t: "stage",
      stageId: "st-nii",
      pluginId: "engine.metric.nii",
      kind: "metric",
      consumed: [{ type: "Cashflow", scope: "scenario", producerStageId: "st-cashflow" }],
      produced: [{ type: "NiiResult", scope: "run" }],
    },
    {
      t: "stage",
      stageId: "st-draw",
      pluginId: "alm-draw-rate-model",
      kind: "behavioral",
      consumed: [],
      produced: [],
      skipped: "not-executable",
    },
  ];

  it("renders the plan as its own root, before the stages", () => {
    expect(runLogTree(walked).map((n) => n.label)).toEqual(["Plan PLAN-1", "Stages"]);
  });

  it("says a derived plan is derived and carries no id", () => {
    const tree = runLogTree([{ t: "plan", derived: true, stageIds: ["st-curve"] }]);
    expect(tree[0]!.label).toBe("Plan (derived from the request)");
    expect(tree[0]!.children.map((c) => c.label)).toEqual(["1 stage: st-curve"]);
  });

  it("lists each stage's plugin, consumed and produced artifacts", () => {
    const stages = runLogTree(walked).find((n) => n.label === "Stages")!;
    expect(stages.children.map((c) => c.label)).toEqual([
      "st-curve (curve) by engine.curve.bootstrap",
      "st-nii (metric) by engine.metric.nii",
      "st-draw (behavioral) by alm-draw-rate-model: skipped, not-executable",
    ]);
    const nii = stages.children[1]!;
    expect(nii.children.map((c) => c.label)).toEqual([
      "consumes Cashflow@scenario from st-cashflow",
      "produces NiiResult@run",
    ]);
  });

  it("renders an entry of an unknown kind as a raw-JSON leaf rather than dropping it", () => {
    const unknown = { t: "future-arm", note: "not yet a case here" } as unknown as RunLogEntry;
    const tree = runLogTree([unknown]);
    const other = tree.find((n) => n.label === "Other entries")!;
    expect(other.children[0]!.label).toContain("future-arm");
    expect(other.children[0]!.label).toContain("not yet a case here");
  });
});
