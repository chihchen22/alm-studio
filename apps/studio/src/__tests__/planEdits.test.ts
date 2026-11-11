import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PlanDoc } from "../plan/planGraph";
import {
  addWire, canConnect, editCount, editedStageIds, editsText, nextEditId, planEditSummary, removeWire, serializePlan, swapComponent, withPlanId,
} from "../plan/planEdits";
import { withBook } from "../plan/planBook";
import { withMarket } from "../plan/planMarket";
import { runButton } from "../pages/plan/PlanPage";
import { addView, removeView } from "../plan/planViews";

const EXAMPLE = fileURLToPath(new URL("../../../../docs/harness/example-plan.json", import.meta.url));
const load = () => JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;

/** Every serialized line that differs between a and b. */
function changedLines(a: PlanDoc, b: PlanDoc): string[] {
  const x = serializePlan(a).split("\n");
  const y = serializePlan(b).split("\n");
  expect(y).toHaveLength(x.length);
  return y.filter((line, i) => line !== x[i]);
}

describe("planEdits", () => {
  it("swapComponent changes only that stage's component and leaves the input untouched", () => {
    const before = load();
    const snapshot = serializePlan(before);
    const after = swapComponent(before, "st-decay-nmd", "alm-competing-risks-prepay");
    expect(serializePlan(before)).toBe(snapshot);
    expect(changedLines(before, after)).toEqual(['      "component": "alm-competing-risks-prepay",']);
  });

  it("swapComponent refuses an unknown stage", () => {
    expect(() => swapComponent(load(), "st-nowhere", "x")).toThrow(/st-nowhere/);
  });

  it("removeWire drops one dependsOn entry and nothing else", () => {
    const before = load();
    const after = removeWire(before, "st-term", "st-cashflow");
    expect(after.stages.find((s) => s.id === "st-cashflow")!.dependsOn).toEqual(["st-early-withdrawal"]);
    const others = (p: PlanDoc) => serializePlan({ ...p, stages: p.stages.filter((s) => s.id !== "st-cashflow") });
    expect(others(after)).toBe(others(before));
  });

  it("removeWire keeps an emptied dependsOn as []", () => {
    const after = removeWire(load(), "st-curve", "st-term");
    expect(after.stages.find((s) => s.id === "st-term")!.dependsOn).toEqual([]);
  });

  it("addWire appends the upstream id once, and appends a dependsOn key when the stage had none", () => {
    const p = load();
    const once = addWire(p, "st-curve", "st-cashflow");
    expect(once.stages.find((s) => s.id === "st-cashflow")!.dependsOn).toEqual(["st-early-withdrawal", "st-term", "st-curve"]);
    expect(addWire(once, "st-curve", "st-cashflow")).toEqual(once);
    const root = addWire(p, "st-term", "st-curve");
    const stage = root.stages.find((s) => s.id === "st-curve")!;
    expect(Object.keys(stage).at(-1)).toBe("dependsOn");
    expect(stage.dependsOn).toEqual(["st-term"]);
  });

  it("canConnect needs a produced type on one side, the same consumed type on the other, and two stages", () => {
    const p = load();
    expect(canConnect(p, "st-term", "st-cashflow", "RatePath")).toBe(true);
    expect(canConnect(p, "st-curve", "st-cashflow", "RatePath")).toBe(false);
    expect(canConnect(p, "st-term", "st-term", "ZeroCurve")).toBe(false);
  });

  it("nextEditId takes the first free -edit-N and strips an existing suffix", () => {
    expect(nextEditId("plan-a", new Set())).toBe("plan-a-edit-1");
    expect(nextEditId("plan-a", new Set(["plan-a-edit-1"]))).toBe("plan-a-edit-2");
    expect(nextEditId("plan-a-edit-2", new Set(["plan-a-edit-1", "plan-a-edit-2"]))).toBe("plan-a-edit-3");
    expect(nextEditId("x".repeat(64), new Set())).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  it("withPlanId replaces planId in place", () => {
    const p = withPlanId(load(), "plan-new");
    expect(p.planId).toBe("plan-new");
    expect(Object.keys(p)).toEqual(Object.keys(load()));
  });

  it("editedStageIds names the stages whose serialized form differs", () => {
    const p = load();
    const q = removeWire(swapComponent(p, "st-draw", "alm-revolving-facility"), "st-term", "st-cashflow");
    expect([...editedStageIds(p, q)].sort()).toEqual(["st-cashflow", "st-draw"]);
  });
});

describe("planEditSummary", () => {
  const withTaxonomy = (): PlanDoc => {
    const p = load();
    return { ...p, inputs: { ...p.inputs, dimensionTaxonomy: "tax-v1" } };
  };

  it("an untouched plan has no edits", () => {
    const p = load();
    const s = planEditSummary(p, p);
    expect(s.stageIds.size).toBe(0);
    expect(s.views).toBe(false);
    expect(s.book).toBe(false);
    expect(s.market).toBe(false);
    expect(s.taxonomyDropped).toBe(false);
    expect(editCount(s)).toBe(0);
    expect(editsText(s)).toBe("No edits");
  });

  it("counts a swapped stage", () => {
    const p = load();
    const s = planEditSummary(p, swapComponent(p, "st-decay-nmd", "alm-competing-risks-prepay"));
    expect(editCount(s)).toBe(1);
    expect(editsText(s)).toBe("1 stage edited");
  });

  it("counts a view change as one edit", () => {
    const p = load();
    const s = planEditSummary(p, addView(p, "By side", ["side"]));
    expect(s.views).toBe(true);
    expect(editCount(s)).toBe(1);
    expect(editsText(s)).toBe("views changed");
  });

  it("notes the dropped taxonomy cross-check when the book changes", () => {
    const p = withTaxonomy();
    const s = planEditSummary(p, withBook(p, p, "another-book"));
    expect(s.book).toBe(true);
    expect(s.taxonomyDropped).toBe(true);
    expect(editCount(s)).toBe(1);
    expect(editsText(s)).toBe("book changed, taxonomy cross-check dropped");
  });

  it("counts a market change as one edit of its own, not a book change, and keeps Run behind Save as", () => {
    const p = load();
    const q = withMarket(p, p, "tlp-shock-demo-v1");
    const s = planEditSummary(p, q);
    expect(s.market).toBe(true);
    expect(s.book).toBe(false);
    expect(editCount(s)).toBe(1);
    expect(editsText(s)).toBe("market changed");
    expect(runButton(editCount(s))).toEqual({ disabled: true, title: "Save as first" });
  });

  it("switching the market back gives the loaded plan exactly and no edits", () => {
    const p = load();
    const back = withMarket(withMarket(p, p, "tlp-shock-demo-v1"), p, p.inputs.marketSnapshot);
    expect(serializePlan(back)).toBe(serializePlan(p));
    expect(editsText(planEditSummary(p, back))).toBe("No edits");
  });

  it("a book change plus a market change reads both, and switching the book back keeps the market", () => {
    const { dimensionTaxonomy: _t, ...inputs } = load().inputs;
    const p: PlanDoc = { ...load(), inputs };
    const q = withMarket(withBook(p, p, "another-book"), p, "tlp-shock-demo-v1");
    const s = planEditSummary(p, q);
    expect(s.book).toBe(true);
    expect(s.market).toBe(true);
    expect(editCount(s)).toBe(2);
    expect(editsText(s)).toBe("book changed; market changed");
    const back = withBook(q, p, p.inputs.positionBook);
    expect(back.inputs.marketSnapshot).toBe("tlp-shock-demo-v1");
    expect(back.inputs.positionBook).toBe(p.inputs.positionBook);
    expect(editsText(planEditSummary(p, back))).toBe("market changed");
  });

  it("joins the parts and sums the count", () => {
    const { dimensionTaxonomy: _t, ...inputs } = load().inputs;
    const p: PlanDoc = { ...load(), inputs };
    let q = swapComponent(p, "st-decay-nmd", "alm-competing-risks-prepay");
    q = swapComponent(q, "st-term", "alm-competing-risks-prepay");
    q = addView(q, "By side", ["side"]);
    q = withBook(q, p, "another-book");
    const s = planEditSummary(p, q);
    expect(s.stageIds.size).toBe(2);
    expect(editCount(s)).toBe(4);
    expect(editsText(s)).toBe("2 stages edited; views changed; book changed");
  });

  it("an added then removed view on a plan with none is no edit", () => {
    const p = load();
    const s = planEditSummary(p, removeView(addView(p, "By side", ["side"]), "view-1"));
    expect(s.views).toBe(false);
    expect(editsText(s)).toBe("No edits");
  });
});
