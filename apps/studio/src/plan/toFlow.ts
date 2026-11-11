// apps/studio/src/plan/toFlow.ts
/**
 * Graph to xyflow nodes and edges (Studio S2). Positions are computed here
 * and live only in the canvas; they never enter the plan. Down: one band per
 * lane. Across: a stage's rank within its lane (the lane's stages sorted by
 * depth, then plan order), one stage per column, so a lane is only as wide as
 * its own stage count and the first fit is not bound by the deepest chain.
 * Nodes do not drag. Lanes are background nodes of their own type, so their
 * labels pan and zoom with the stages.
 */
import type { Edge, Node } from "@xyflow/react";
import type { PluginCatalogReply } from "@alm/reader";
import { componentLabel, resolvePlugin } from "./componentMenu";
import type { NodeStatus, Paint } from "./gatePaint";
import { LANES, type LaneId, type PlanGraph } from "./planGraph";

export interface StageNodeData {
  stageId: string;
  label: string;
  component: string;
  runs: boolean;
  pluginId: string | null;
  consumes: string[];
  produces: string[];
  status: NodeStatus;
  edited: boolean;
  [key: string]: unknown;
}

export interface LaneNodeData {
  label: string;
  [key: string]: unknown;
}

export type LaneBand = { id: LaneId; label: string; y: number; height: number };

/**
 * Canvas geometry in px. `card` is the stage card's fixed height (StageNode sets
 * it inline, so CSS cannot drift from the layout); `row` is a lane band's height
 * and leaves a gap under the card so it never leaves its lane. Handles sit at
 * portTop + i * portStep, and up to maxPorts of them fit inside the card.
 */
export const LAYOUT = { col: 240, row: 192, laneGap: 40, card: 168, portTop: 28, portStep: 16, maxPorts: 6, handle: 8 } as const;

/** Stage nodes sit at xyflow's default z (0); lane bands sit under them and under the wires. */
export const LANE_Z = -1;

/**
 * One background node per lane: a band from one column left of x = 0 (where the
 * label sits) across `width`. Inert: it never drags, selects, connects, deletes
 * or takes focus.
 */
export function laneNodes(lanes: readonly LaneBand[], width: number): Node<LaneNodeData>[] {
  return lanes.map((l) => ({
    id: `lane:${l.id}`,
    type: "lane",
    position: { x: -LAYOUT.col, y: l.y },
    width: width + LAYOUT.col,
    height: l.height,
    zIndex: LANE_Z,
    draggable: false,
    selectable: false,
    connectable: false,
    deletable: false,
    focusable: false,
    data: { label: l.label },
  }));
}

/** The stage a clicked node stands for, or null for a lane band. */
export function stageIdOf(node: Pick<Node, "id" | "type">): string | null {
  return node.type === "stage" ? node.id : null;
}

export function toFlow(
  graph: PlanGraph,
  paint: Paint,
  cat: PluginCatalogReply,
  edited: ReadonlySet<string>,
): { nodes: Node<StageNodeData>[]; edges: Edge[]; lanes: LaneBand[] } {
  const lanes: LaneBand[] = [];
  const nodes: Node<StageNodeData>[] = [];
  let y = 0;
  for (const laneId of graph.lanes) {
    const inLane = graph.nodes.filter((n) => n.lane === laneId).sort((a, b) => a.depth - b.depth || a.order - b.order);
    inLane.forEach((n, rank) => {
      const pluginId = resolvePlugin(cat, n.component);
      nodes.push({
        id: n.stageId,
        type: "stage",
        position: { x: rank * LAYOUT.col, y },
        draggable: false,
        deletable: false,
        data: {
          stageId: n.stageId,
          label: componentLabel(cat, n.component),
          component: n.component,
          runs: pluginId !== null,
          pluginId,
          consumes: n.consumes,
          produces: n.produces,
          status: paint.byStage[n.stageId] ?? { kind: "unchecked" },
          edited: edited.has(n.stageId),
        },
      });
    });
    const height = LAYOUT.row;
    lanes.push({ id: laneId, label: LANES.find((l) => l.id === laneId)!.label, y, height });
    y += height + LAYOUT.laneGap;
  }
  const edges: Edge[] = graph.edges.map((e) => {
    const t = e.types[0];
    return t === undefined
      ? { id: e.id, source: e.from, target: e.to, className: "edge-untyped", label: "no shared type", data: { from: e.from, to: e.to } }
      : { id: e.id, source: e.from, target: e.to, sourceHandle: `out:${t}`, targetHandle: `in:${t}`, label: e.types.join(", "), data: { from: e.from, to: e.to } };
  });
  return { nodes, edges, lanes };
}
