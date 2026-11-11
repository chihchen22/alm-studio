// apps/studio/src/pages/plan/PlanCanvas.tsx
/**
 * The plan canvas (Studio S2): lane bands behind (inert background nodes, so
 * their labels pan and zoom with the stages), one node per stage, typed wires.
 * Pan and zoom only; nodes do not drag. A drag between ports of different
 * types is refused here. Clicking a stage opens its swap menu and marks it
 * selected (and clears any selected wire, so Delete on the menu removes
 * nothing behind it); clicking a wire selects it and Delete removes it. Nodes and edges
 * are controlled props, so xyflow applies no selection itself: the canvas keeps
 * the selected wire ids from onEdgesChange (cleared when the plan changes) and
 * the open stage, and passes both back as `selected` flags. Every edit goes back
 * to the page as a plan edit.
 */
import { useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Connection, type Edge, type EdgeChange, type Node } from "@xyflow/react";
// xyflow's base.css, vendored with its colour literals replaced by tokens (the design gate scans the bundle).
import "./xyflow-base.css";
import type { PluginCatalogReply } from "@alm/reader";
import { menuFor } from "../../plan/componentMenu";
import type { Paint } from "../../plan/gatePaint";
import { afterNodeClick, applyEdgeSelection, connectionAllowed, markSelected, wiresOf } from "../../plan/canvasState";
import type { PlanDoc, PlanGraph } from "../../plan/planGraph";
import { LAYOUT, laneNodes, stageIdOf, toFlow } from "../../plan/toFlow";
import { LaneNode } from "./LaneNode";
import { StageNode } from "./StageNode";
import { SwapMenu } from "./SwapMenu";

const NODE_TYPES = { stage: StageNode, lane: LaneNode };
const NONE: ReadonlySet<string> = new Set();
/** xyflow clamps fitView at minZoom (default 0.5), too close for a whole seeded plan; this lets the first fit show every stage. */
const MIN_ZOOM = 0.1;

export function PlanCanvas(props: {
  plan: PlanDoc;
  graph: PlanGraph;
  paint: Paint;
  catalog: PluginCatalogReply;
  edited: ReadonlySet<string>;
  onSwap(stageId: string, component: string): void;
  onConnect(from: string, to: string): void;
  onRemoveWire(from: string, to: string): void;
}) {
  const flow = useMemo(() => toFlow(props.graph, props.paint, props.catalog, props.edited), [props.graph, props.paint, props.catalog, props.edited]);
  const [open, setOpen] = useState<string | null>(null);
  const openStage = open === null ? undefined : props.plan.stages.find((s) => s.id === open);
  const nodes = useMemo<Node[]>(() => {
    const width = Math.max(0, ...flow.nodes.map((n) => n.position.x)) + LAYOUT.col;
    return [...laneNodes(flow.lanes, width), ...markSelected(flow.nodes, open === null ? NONE : new Set([open]))];
  }, [flow, open]);

  // Selected wire ids, keyed to the plan they were picked on: a new plan (an edit, a delete) starts with none.
  const [edgeSel, setEdgeSel] = useState<{ plan: PlanDoc; ids: ReadonlySet<string> }>({ plan: props.plan, ids: NONE });
  const selectedEdges = edgeSel.plan === props.plan ? edgeSel.ids : NONE;
  const edges = useMemo(() => markSelected(flow.edges, selectedEdges), [flow.edges, selectedEdges]);
  const onEdgesChange = (changes: EdgeChange[]) =>
    setEdgeSel((s) => ({ plan: props.plan, ids: applyEdgeSelection(s.plan === props.plan ? s.ids : NONE, changes) }));

  const valid = (c: Connection | Edge) => connectionAllowed(props.plan, c);

  return (
    <div className="plan-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable
        elementsSelectable
        deleteKeyCode={["Delete", "Backspace"]}
        isValidConnection={valid}
        onConnect={(c) => { if (valid(c)) props.onConnect(c.source, c.target); }}
        onEdgesChange={onEdgesChange}
        onEdgesDelete={(es) => {
          setEdgeSel({ plan: props.plan, ids: NONE });
          for (const w of wiresOf(es)) props.onRemoveWire(w.from, w.to);
        }}
        onNodesDelete={() => { /* stages are not removed in S2 */ }}
        onNodeClick={(_, n) => {
          const next = afterNodeClick(stageIdOf(n), { open, edges: selectedEdges });
          setOpen(next.open);
          setEdgeSel({ plan: props.plan, ids: next.edges });
        }}
        onPaneClick={() => setOpen(null)}
        fitView
        minZoom={MIN_ZOOM}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      {openStage !== undefined ? (
        <SwapMenu
          stageId={openStage.id}
          items={menuFor(props.catalog, openStage.kind, openStage.component)}
          onPick={(id) => { props.onSwap(openStage.id, id); setOpen(null); }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
