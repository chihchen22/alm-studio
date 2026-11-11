// apps/studio/src/__tests__/planCanvas.test.tsx
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { planGraph, type PlanDoc } from "../plan/planGraph";
import { paint } from "../plan/gatePaint";
import { menuFor } from "../plan/componentMenu";
import { LAYOUT, laneNodes, stageIdOf, toFlow } from "../plan/toFlow";
import { LaneNode } from "../pages/plan/LaneNode";
import { StageNode } from "../pages/plan/StageNode";
import { SwapMenu } from "../pages/plan/SwapMenu";
import { CATALOG, REPLY_T1, REPLY_TAG } from "./fixtures/plan";

const EXAMPLE = fileURLToPath(new URL("../../../../docs/harness/example-plan.json", import.meta.url));
const plan = () => JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;

describe("toFlow", () => {
  it("places nodes by rank within their lane across and by lane down, never dragged, and keys edges from->to", () => {
    const p = plan();
    const g = planGraph(p);
    const f = toFlow(g, paint(p.stages.map((s) => s.id), null), CATALOG, new Set());
    for (const laneId of g.lanes) {
      const inLane = g.nodes.filter((n) => n.lane === laneId).sort((a, b) => a.depth - b.depth || a.order - b.order);
      const xs = inLane.map((n) => f.nodes.find((x) => x.id === n.stageId)!.position.x);
      // One stage per column: the first at x 0, the next at LAYOUT.col, and so on.
      expect(xs).toEqual(inLane.map((_, i) => i * LAYOUT.col));
      expect(Math.max(...xs) - Math.min(...xs)).toBe((inLane.length - 1) * LAYOUT.col);
    }
    // A stage's x no longer follows its global depth: some lane starts deeper than depth 0.
    expect(g.nodes.some((n) => n.depth > 0 && f.nodes.find((x) => x.id === n.stageId)!.position.x === 0)).toBe(true);
    expect(f.nodes.every((n) => n.draggable === false && n.deletable === false)).toBe(true);
    expect(f.edges.find((e) => e.id === "st-term->st-cashflow")).toMatchObject({
      source: "st-term", target: "st-cashflow", sourceHandle: "out:RatePath", targetHandle: "in:RatePath",
    });
    expect(f.lanes.map((l) => l.id)).toEqual(g.lanes);
    const ys = f.lanes.map((l) => l.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("carries status, chip and edited mark into node data", () => {
    const p = plan();
    const g = planGraph(p);
    const f = toFlow(g, paint(p.stages.map((s) => s.id), REPLY_TAG), CATALOG, new Set(["st-draw"]));
    const draw = f.nodes.find((n) => n.id === "st-draw")!;
    expect(draw.data.edited).toBe(true);
    expect(draw.data.runs).toBe(false);
  });
});

describe("StageNode", () => {
  it("renders id, label, chip, ports and a worded status", () => {
    const p = plan();
    const g = planGraph(p);
    const f = toFlow(g, paint(p.stages.map((s) => s.id), REPLY_T1), CATALOG, new Set(["st-cashflow"]));
    const node = f.nodes.find((n) => n.id === "st-cashflow")!;
    const html = renderToStaticMarkup(
      <ReactFlowProvider>
        <StageNode {...({ id: node.id, data: node.data, type: "stage", selected: false, dragging: false, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0, deletable: false, selectable: true, draggable: false } as unknown as Parameters<typeof StageNode>[0])} />
      </ReactFlowProvider>,
    );
    expect(html).toContain("st-cashflow");
    expect(html).toContain("T1");
    expect(html).toContain("Refused");
    expect(html).toContain("Edited");
    expect(html).toContain("RatePath");
  });
});

describe("SwapMenu", () => {
  it("lists every item with a worded chip and marks the current one", () => {
    const html = renderToStaticMarkup(
      <SwapMenu items={menuFor(CATALOG, "behavioral", "alm-deposit-decay")} stageId="st-decay" onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("Competing-risks prepayment");
    expect(html).toContain("Catalog only");
    expect(html).toContain("Runs");
    expect(html).toContain("Current");
  });
});

describe("laneNodes", () => {
  it("draws one background node per non-empty lane, left of x = 0, under the stages, never selectable or deletable", () => {
    const p = plan();
    const g = planGraph(p);
    const f = toFlow(g, paint(p.stages.map((s) => s.id), null), CATALOG, new Set());
    const lanes = laneNodes(f.lanes, 1000);
    expect(lanes.map((n) => n.id)).toEqual(g.lanes.map((id) => `lane:${id}`));
    expect(lanes.map((n) => n.position.y)).toEqual(f.lanes.map((l) => l.y));
    expect(lanes.map((n) => n.data.label)).toEqual(f.lanes.map((l) => l.label));
    const lowestStage = Math.min(...f.nodes.map((n) => n.zIndex ?? 0));
    for (const n of lanes) {
      expect(n.type).toBe("lane");
      expect(n.position.x).toBe(-LAYOUT.col);
      expect(n.position.x).toBeLessThan(0);
      expect(n).toMatchObject({ draggable: false, selectable: false, connectable: false, deletable: false, focusable: false });
      expect(n.zIndex ?? 0).toBeLessThan(lowestStage);
    }
  });

  it("opens the swap menu for a stage node only, never for a lane", () => {
    const p = plan();
    const g = planGraph(p);
    const f = toFlow(g, paint(p.stages.map((s) => s.id), null), CATALOG, new Set());
    const [lane] = laneNodes(f.lanes, 1000);
    expect(stageIdOf(lane!)).toBeNull();
    expect(stageIdOf(f.nodes.find((n) => n.id === "st-curve")!)).toBe("st-curve");
  });

  it("renders the lane label", () => {
    const html = renderToStaticMarkup(
      <LaneNode {...({ id: "lane:market", data: { label: "Market" }, type: "lane", selected: false, dragging: false, zIndex: -1, isConnectable: false, positionAbsoluteX: -240, positionAbsoluteY: 0, deletable: false, selectable: false, draggable: false } as unknown as Parameters<typeof LaneNode>[0])} />,
    );
    expect(html).toContain("Market");
    expect(html).toContain("lane-node");
  });
});

describe("card fit", () => {
  it("keeps every card and its handles inside its lane band", () => {
    expect(LAYOUT.row).toBeGreaterThan(LAYOUT.card);
    const lastHandleBottom = LAYOUT.portTop + (LAYOUT.maxPorts - 1) * LAYOUT.portStep + LAYOUT.handle / 2;
    expect(lastHandleBottom).toBeLessThan(LAYOUT.card);
    const p = plan();
    const g = planGraph(p);
    const f = toFlow(g, paint(p.stages.map((s) => s.id), null), CATALOG, new Set());
    for (const n of f.nodes) {
      const lane = f.lanes.find((l) => l.id === g.nodes.find((x) => x.stageId === n.id)!.lane)!;
      expect(n.position.y).toBeGreaterThanOrEqual(lane.y);
      expect(n.position.y + LAYOUT.card).toBeLessThanOrEqual(lane.y + lane.height);
    }
  });

  it("draws the card at the layout height, so CSS and layout cannot drift", () => {
    const p = plan();
    const f = toFlow(planGraph(p), paint(p.stages.map((s) => s.id), null), CATALOG, new Set());
    const node = f.nodes[0]!;
    const html = renderToStaticMarkup(
      <ReactFlowProvider>
        <StageNode {...({ id: node.id, data: node.data, type: "stage", selected: false, dragging: false, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0, deletable: false, selectable: true, draggable: false } as unknown as Parameters<typeof StageNode>[0])} />
      </ReactFlowProvider>,
    );
    expect(html).toContain(`height:${LAYOUT.card}px`);
  });
});
