import type { Node, NodeProps } from "@xyflow/react";
import type { GraphNodeModel } from "../../lib/graph";
import type { GraphGroup } from "../../lib/graph-layout";
import { KindGlyph } from "./kind-glyph";

export type FrameNode = Node<
  { group: GraphGroup; ownerKind: GraphNodeModel["node"]["kind"] | null },
  "frame"
>;

// Scope frames carry no caption since their control node names them.
export function GraphFrame(props: NodeProps<FrameNode>) {
  const { group, ownerKind } = props.data;

  return (
    <div
      className={`loopy-frame frame-${group.kind} size-full`}
      data-owner={ownerKind ?? undefined}
      data-depth={group.depth}
    >
      {group.kind === "subgraph" && (
        <span className="frame-caption">
          <KindGlyph kind="subgraph" />
          {group.owner.split("/").at(-1)}
        </span>
      )}
    </div>
  );
}
