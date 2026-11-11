// apps/studio/src/pages/plan/StageNode.tsx
/** One plan stage on the canvas. Every status carries an icon and a word, never color alone. */
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { LAYOUT, type StageNodeData } from "../../plan/toFlow";
import type { NodeStatus } from "../../plan/gatePaint";

/** A port handle's box: its offset from the card top and its size, both from the layout. */
const handleAt = (i: number) => ({ top: LAYOUT.portTop + i * LAYOUT.portStep, width: LAYOUT.handle, height: LAYOUT.handle });

const STATUS: Record<NodeStatus["kind"], { cls: string; icon: string; word: string }> = {
  refused: { cls: "status status-breach", icon: "✕", word: "Refused" },
  "not-implemented": { cls: "status status-unobs", icon: "○", word: "Not implemented" },
  pass: { cls: "status status-pass", icon: "✓", word: "Gates pass" },
  unchecked: { cls: "status status-stale", icon: "…", word: "Unchecked" },
};

export function StageNode(props: NodeProps<Node<StageNodeData>>) {
  const d = props.data;
  const s = STATUS[d.status.kind];
  return (
    <div className={`stage-node${d.runs ? "" : " stage-node-catalog"}${props.selected ? " is-selected" : ""}`} style={{ height: LAYOUT.card }}>
      {d.consumes.map((t, i) => (
        <Handle key={`in:${t}`} id={`in:${t}`} type="target" position={Position.Left} style={handleAt(i)} title={t} />
      ))}
      <div className="stage-head">
        <span className="stage-id mono">{d.stageId}</span>
        {d.edited ? <span className="chip chip-edited">✎ Edited</span> : null}
      </div>
      <div className="stage-label" title={d.label}>{d.label}</div>
      <div className="stage-meta">
        <span className={d.runs ? "chip chip-runs" : "chip chip-catalog"}>{d.runs ? "Runs" : "Catalog only"}</span>
        {d.pluginId !== null ? <span className="stage-plugin mono muted" title={d.pluginId}>{d.pluginId}</span> : null}
      </div>
      <div className="stage-ports mono muted">
        <span title={d.consumes.join(", ")}>{d.consumes.join(", ")}</span>
        <span title={d.produces.join(", ")}>→ {d.produces.join(", ")}</span>
      </div>
      <div className={s.cls} title={"message" in d.status ? d.status.message : undefined}>
        <span aria-hidden="true">{s.icon}</span> {s.word}
        {d.status.kind === "refused" ? <span className="mono"> {d.status.code}</span> : null}
      </div>
      {d.produces.map((t, i) => (
        <Handle key={`out:${t}`} id={`out:${t}`} type="source" position={Position.Right} style={handleAt(i)} title={t} />
      ))}
    </div>
  );
}
