import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PlanDoc } from "../plan/planGraph";
import {
  addView, canAddView, groupByText, nextViewId, removeView, viewDimensionOptions,
} from "../plan/planViews";

const EXAMPLE = fileURLToPath(new URL("../../../../docs/harness/example-plan.json", import.meta.url));
const load = () => JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;

const FIXTURE_TAXONOMY = {
  schemaVersion: "1.0.0",
  id: "t",
  label: "t",
  dimensions: [
    { id: "region", label: "Region" },
    { id: "channels", label: "Channels", multiValued: true },
    { id: "behavioralClasses", label: "Classes", multiValued: true },
  ],
};

describe("viewDimensionOptions", () => {
  it("offers only the derived productFamily and side when the book declares no taxonomy", () => {
    expect(viewDimensionOptions(undefined)).toEqual([
      { id: "productFamily", label: "Product family (derived)", derived: true },
      { id: "side", label: "Side (derived)", derived: true },
    ]);
  });

  it("drops multi-valued tags (P2) and behavioralClasses, and appends the derived ids not declared", () => {
    expect(viewDimensionOptions(FIXTURE_TAXONOMY).map((o) => o.id)).toEqual(["region", "productFamily", "side"]);
  });

  it("labels a declared id with its def label and marks only undeclared derived ids derived", () => {
    const opts = viewDimensionOptions(FIXTURE_TAXONOMY);
    expect(opts[0]).toEqual({ id: "region", label: "Region", derived: false });
    expect(opts[1]!.derived).toBe(true);
  });

  it("keeps a declared derived id in declared order and not derived", () => {
    const tax = { ...FIXTURE_TAXONOMY, dimensions: [{ id: "side", label: "Book side" }, { id: "region", label: "Region" }] };
    expect(viewDimensionOptions(tax)).toEqual([
      { id: "side", label: "Book side", derived: false },
      { id: "region", label: "Region", derived: false },
      { id: "productFamily", label: "Product family (derived)", derived: true },
    ]);
  });
});

describe("nextViewId", () => {
  it("gives the lowest free view-N", () => {
    expect(nextViewId(load())).toBe("view-1");
    const p = { ...load(), views: [{ id: "view-1", label: "a", groupBy: ["side"] }, { id: "view-3", label: "b", groupBy: ["side"] }] };
    expect(nextViewId(p)).toBe("view-2");
    expect(nextViewId({ ...load(), views: [{ id: "a", label: "a", groupBy: ["side"] }] })).toBe("view-1");
  });
});

describe("addView / removeView", () => {
  it("addView trims the label, appends views last, and leaves the input untouched", () => {
    const p = load();
    const snapshot = structuredClone(p);
    const after = addView(p, "  By side  ", ["side"]);
    expect(after.views).toEqual([{ id: "view-1", label: "By side", groupBy: ["side"] }]);
    expect(Object.keys(after)).toEqual([...Object.keys(p), "views"]);
    expect(p).toEqual(snapshot);
  });

  it("addView appends to an existing list with the next id", () => {
    const one = addView(load(), "A", ["side"]);
    const two = addView(one, "B", ["productFamily", "side"]);
    expect(two.views!.map((v) => v.id)).toEqual(["view-1", "view-2"]);
    expect(Object.keys(two)).toEqual(Object.keys(one));
  });

  it("addView refuses a blank label, no dimension, and a dimension picked twice", () => {
    expect(() => addView(load(), "  ", ["side"])).toThrow("view label must not be blank");
    expect(() => addView(load(), "x", [])).toThrow("a view groups by at least one dimension");
    expect(() => addView(load(), "x", ["side", "side"])).toThrow('dimension "side" is picked twice');
  });

  it("removeView drops the key when it removes the last view, and refuses an unknown id", () => {
    const p = addView(load(), "A", ["side"]);
    const after = removeView(p, "view-1");
    expect("views" in after).toBe(false);
    expect(() => removeView(p, "x")).toThrow(`no view "x" in plan ${p.planId}`);
  });

  it("removeView keeps the other views", () => {
    const p = addView(addView(load(), "A", ["side"]), "B", ["productFamily"]);
    expect(removeView(p, "view-1").views).toEqual([{ id: "view-2", label: "B", groupBy: ["productFamily"] }]);
  });
});

describe("canAddView and groupByText", () => {
  it("canAddView needs a label and distinct picks", () => {
    expect(canAddView("", ["side"])).toBe(false);
    expect(canAddView("x", [])).toBe(false);
    expect(canAddView("x", ["side", "side"])).toBe(false);
    expect(canAddView("x", ["side"])).toBe(true);
  });

  it("groupByText joins with then", () => {
    expect(groupByText(["a", "b"])).toBe("a then b");
  });
});
