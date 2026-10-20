import type { Node, NodeProps } from "@xyflow/react";
import type { GraphNodeModel } from "../../lib/graph.ts";
import type { GraphGroup } from "../../lib/graph-layout.ts";
import { KindGlyph } from "./kind-glyph.tsx";

export type FrameNode = Node<
  { group: GraphGroup; ownerKind: GraphNodeModel["node"]["kind"] | null },
  "frame"
>;

/**
 * The area behind a control node and its scope, or behind one subgraph call. Scope frames carry
 * no caption since their control node names them; a subgraph frame names the subgraph.
 */
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
