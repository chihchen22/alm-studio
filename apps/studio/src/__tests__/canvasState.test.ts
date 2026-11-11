import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EdgeChange } from "@xyflow/react";
import { planGraph, type PlanDoc } from "../plan/planGraph";
import { paint } from "../plan/gatePaint";
import { toFlow } from "../plan/toFlow";
import { afterNodeClick, applyEdgeSelection, connectionAllowed, markSelected, wiresOf } from "../plan/canvasState";
import { CATALOG } from "./fixtures/plan";

const EXAMPLE = fileURLToPath(new URL("../../../../docs/harness/example-plan.json", import.meta.url));
const plan = () => JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;

describe("connectionAllowed", () => {
  const conn = (source: string, target: string, out: string, inp: string) => ({ source, target, sourceHandle: `out:${out}`, targetHandle: `in:${inp}` });

  it("allows a same-type wire from a producer to a consumer", () => {
    expect(connectionAllowed(plan(), conn("st-term", "st-cashflow", "RatePath", "RatePath"))).toBe(true);
  });

  it("refuses ports of different types", () => {
    expect(connectionAllowed(plan(), conn("st-term", "st-cashflow", "RatePath", "Position"))).toBe(false);
  });

  it("refuses a stage wired to itself, even where it both consumes and produces the type", () => {
    // st-decay-nmd consumes and produces Position, so only the self check can refuse this.
    expect(connectionAllowed(plan(), conn("st-decay-nmd", "st-decay-nmd", "Position", "Position"))).toBe(false);
  });

  it("refuses a handle without its direction prefix", () => {
    expect(connectionAllowed(plan(), { source: "st-term", target: "st-cashflow", sourceHandle: "RatePath", targetHandle: "in:RatePath" })).toBe(false);
    expect(connectionAllowed(plan(), { source: "st-term", target: "st-cashflow", sourceHandle: null, targetHandle: null })).toBe(false);
  });
});

describe("delete path", () => {
  const edges = () => {
    const p = plan();
    return toFlow(planGraph(p), paint(p.stages.map((s) => s.id), null), CATALOG, new Set()).edges;
  };

  it("tracks selection from xyflow's select and remove changes", () => {
    const id = "st-term->st-cashflow";
    let sel = applyEdgeSelection(new Set(), [{ type: "select", id, selected: true }] as EdgeChange[]);
    expect([...sel]).toEqual([id]);
    sel = applyEdgeSelection(sel, [{ type: "select", id, selected: false }] as EdgeChange[]);
    expect(sel.size).toBe(0);
    sel = applyEdgeSelection(new Set([id]), [{ type: "remove", id }] as EdgeChange[]);
    expect(sel.size).toBe(0);
  });

  it("hands xyflow every edge with an explicit selected flag, true only for the selected ids", () => {
    const id = "st-term->st-cashflow";
    const marked = markSelected(edges(), new Set([id]));
    expect(marked.filter((e) => e.selected === true).map((e) => e.id)).toEqual([id]);
    expect(marked.every((e) => typeof e.selected === "boolean")).toBe(true);
  });

  it("maps deleted edges back to (from, to) wires for onRemoveWire", () => {
    const id = "st-term->st-cashflow";
    const deleted = markSelected(edges(), new Set([id])).filter((e) => e.selected);
    expect(wiresOf(deleted)).toEqual([{ from: "st-term", to: "st-cashflow" }]);
  });
});

describe("afterNodeClick", () => {
  it("opens the stage's swap menu and clears any selected wire, so Delete on the menu removes nothing", () => {
    const next = afterNodeClick("st-decay", { open: null, edges: new Set(["st-term->st-cashflow"]) });
    expect(next.open).toBe("st-decay");
    expect(next.edges.size).toBe(0);
  });

  it("leaves the state alone for a lane band click", () => {
    const s = { open: "st-term", edges: new Set(["st-term->st-cashflow"]) };
    expect(afterNodeClick(null, s)).toBe(s);
  });
});
