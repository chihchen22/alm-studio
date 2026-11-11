/**
 * The plan as a graph (Studio S2). A pure function of the plan object, which
 * the canvas holds exactly as JSON.parse read it: nothing here reorders,
 * drops or adds a key, and node positions never enter the plan.
 */
import type { RunPlan } from "@alm/engine";

export type PlanDoc = RunPlan;

export type LaneId = "market" | "book" | "behavior" | "balance" | "scenarios" | "metrics" | "other";

export const LANES: ReadonlyArray<{ id: LaneId; label: string; kinds: readonly string[] }> = [
  { id: "market", label: "Market", kinds: ["market-data", "curve"] },
  { id: "book", label: "Book", kinds: ["contractual-cashflow"] },
  { id: "behavior", label: "Behavior", kinds: ["behavioral"] },
  { id: "balance", label: "Balance", kinds: ["balance-new-business"] },
  { id: "scenarios", label: "Scenarios", kinds: ["term-structure", "scenario"] },
  { id: "metrics", label: "Metrics", kinds: ["metric"] },
  { id: "other", label: "Other", kinds: [] },
];

export function laneOf(kind: string): LaneId {
  return LANES.find((l) => l.kinds.includes(kind))?.id ?? "other";
}

export interface GraphNode {
  stageId: string;
  component: string;
  kind: string;
  lane: LaneId;
  depth: number;
  order: number;
  consumes: string[];
  produces: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  types: string[];
}

export interface PlanGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lanes: LaneId[];
}

export function planGraph(plan: PlanDoc): PlanGraph {
  const byId = new Map(plan.stages.map((s) => [s.id, s]));
  const depthOf = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = depthOf.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // a cycle: the type gate reports it (T4); the drawing just stops
    visiting.add(id);
    const parents = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(depth));
    visiting.delete(id);
    depthOf.set(id, d);
    return d;
  };
  const nodes: GraphNode[] = plan.stages.map((s, order) => ({
    stageId: s.id,
    component: s.component,
    kind: s.kind,
    lane: laneOf(s.kind),
    depth: depth(s.id),
    order,
    consumes: [...s.consumes],
    produces: [...s.produces],
  }));
  const edges: GraphEdge[] = plan.stages.flatMap((s) =>
    (s.dependsOn ?? [])
      .filter((d) => byId.has(d))
      .map((d) => ({
        id: `${d}->${s.id}`,
        from: d,
        to: s.id,
        types: byId.get(d)!.produces.filter((t) => s.consumes.includes(t)),
      })),
  );
  const used = new Set(nodes.map((n) => n.lane));
  return { nodes, edges, lanes: LANES.map((l) => l.id).filter((id) => used.has(id)) };
}
