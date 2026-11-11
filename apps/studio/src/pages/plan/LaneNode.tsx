/** One lane band behind the stages: the lane's name on a token-coloured band. It is inert. */
import type { Node, NodeProps } from "@xyflow/react";
import type { LaneNodeData } from "../../plan/toFlow";

export function LaneNode(props: NodeProps<Node<LaneNodeData>>) {
  return (
    <div className="lane-node">
      <span className="lane-label">{props.data.label}</span>
    </div>
  );
}
