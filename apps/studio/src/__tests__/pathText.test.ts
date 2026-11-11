/**
 * One path notation in Studio (ALM Studio Polish 3 T3): an all-digit dotted segment of a stored path prints as a bracket index, as By kind, Edit a set and
 * the shock builder print it. The engine's diff path stays dotted. Expected texts are restated here.
 */
import { describe, expect, it } from "vitest";
import type { AssumptionDiff, AssumptionSet } from "@alm/engine";
import { byKindModel } from "../assumptions/byKindModel";
import { pathText } from "../assumptions/pathText";
import { deltaRows } from "../assumptions/stackModel";

describe("pathText", () => {
  it("prints a dotted array index in brackets", () => {
    expect(pathText("params.buckets.0.label")).toBe("params.buckets[0].label");
    expect(pathText("a.10")).toBe("a[10]");
  });
  it("leaves a path with no index, and one already in brackets, as it is", () => {
    expect(pathText("params.betaMax")).toBe("params.betaMax");
    expect(pathText("params.buckets[0].label")).toBe("params.buckets[0].label");
  });
  it("brackets a leading index and leaves the empty path empty", () => {
    expect(pathText("0.label")).toBe("[0].label");
    expect(pathText("")).toBe("");
  });
});

describe("the Stack diff prints the engine's dotted path in brackets, as By kind does", () => {
  const set = (id: string, share: number) =>
    ({
      schemaVersion: "1.0.0", id, label: id,
      bindings: [{ familyId: "dda", overlay: { kind: "nmd-decay", params: { buckets: [{ label: "small", share }] } }, modelVersion: "kernel-nmd-decay-1" }],
    }) as unknown as AssumptionSet;
  it("one leaf, one text on both pages", () => {
    const base = set("base", 1);
    const candidate = set("cand", 0.5);
    // The engine's diff path, dotted per its contract (AssumptionDelta.path).
    const diff: AssumptionDiff = { baseId: "base", deltas: [{ familyId: "dda", overlayKind: "nmd-decay", path: "params.buckets.0.share", from: 1, to: 0.5 }] };
    expect(deltaRows(diff, base, candidate)).toEqual([
      { familyId: "dda", kind: "nmd-decay", selector: "whole family", path: "params.buckets[0].share", change: "changed", from: { kind: "figure", text: "1", exact: "1" }, to: { kind: "figure", text: "0.5", exact: "0.5" } },
    ]);
    expect(byKindModel([base], ["nmd-decay"]).rows.map((r) => r.path)).toEqual(["params.buckets[0].label", "params.buckets[0].share"]);
  });
});
