import "@xyflow/react/dist/base.css";
import "./graph.css";
import {
  Background,
  BackgroundVariant,
  type FitViewOptions,
  type NodeMouseHandler,
  Panel,
  ReactFlow,
} from "@xyflow/react";
import { memo, type ReactNode, useCallback, useId, useMemo, useState } from "react";
import type { GraphModel } from "../../lib/graph.ts";
import { type FitPadding, type GraphLayout, nodeSize } from "../../lib/graph-layout.ts";
import { GraphMinimap, ViewControls } from "./graph-controls.tsx";
import { type FlowEdge, TrackEdge } from "./graph-edge.tsx";
import { type FrameNode, GraphFrame } from "./graph-frame.tsx";
import { type FlowNode, GraphNode } from "./graph-node.tsx";

const NODE_TYPES = { loopy: GraphNode, frame: GraphFrame };

const EDGE_TYPES = { track: TrackEdge };

// The minimap earns its corner only once a graph no longer fits a glance.
const MINIMAP_FROM = 12;

// Below this zoom node titles stop being legible, so the first view frames the focus instead.
const READABLE_ZOOM = 0.7;

// The most a large graph zooms in on its focus, so a lone node keeps its neighbours in view.
const FOCUS_ZOOM = 0.9;

/**
 * The first view. The pane less its padding is the room there is. A graph that fits it at a
 * readable zoom is fitted whole; a larger one opens on its focus nodes at reading zoom, and the
 * fit button still shows all of it.
 */
function firstView(
  layout: GraphLayout,
  focus: string[],
  padding: FitPadding,
  pane: { width: number; height: number },
): FitViewOptions {
  const room = {
    width: pane.width - Number.parseFloat(padding.left) - Number.parseFloat(padding.right),
    height: pane.height - Number.parseFloat(padding.top) - Number.parseFloat(padding.bottom),
  };

  const zoom = Math.min(room.width / layout.size.width, room.height / layout.size.height);

  return zoom >= READABLE_ZOOM
    ? { padding, maxZoom: 1 }
    : { padding, nodes: focus.map((id) => ({ id })), minZoom: READABLE_ZOOM, maxZoom: FOCUS_ZOOM };
}

function flowEdges(model: GraphModel, layout: GraphLayout): FlowEdge[] {
  const running = new Set(
    model.nodes
      .filter((node) => node.state.kind === "ran" && node.state.status === "running")
      .map((node) => node.id),
  );

  return model.edges.map((edge) => {
    const route = layout.edges.get(edge.id);

    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "track",
      data: {
        model: edge,
        points: route?.points ?? [],
        label: route?.label ?? null,
        live: edge.taken && running.has(edge.to),
      },
      // XYFlow names every edge "Edge from a to b". The kind and the taken mark say more.
      ariaLabel: `${edge.label ?? edge.kind} edge from ${edge.from} to ${edge.to}${edge.taken ? ", taken" : ""}`,
      focusable: false,
      selectable: false,
    };
  });
}

function frameNodes(model: GraphModel, layout: GraphLayout): FrameNode[] {
  const kinds = new Map(model.nodes.map((node) => [String(node.id), node.node.kind]));

  return layout.groups.map((group) => ({
    id: group.id,
    type: "frame",
    position: { x: group.box.x, y: group.box.y },
    width: group.box.width,
    height: group.box.height,
    data: {
      group,
      ownerKind: group.kind === "scope" ? (kinds.get(group.owner) ?? null) : null,
    },
    // Below the edge layer, deeper frames above their parents.
    zIndex: -10 + group.depth,
    draggable: false,
    selectable: false,
    focusable: false,
    connectable: false,
  }));
}

type GraphCanvasProps = {
  model: GraphModel;
  /** Laid out from the graph alone, so live status updates never move a node. */
  layout: GraphLayout;
  /** What to frame first when the whole graph cannot be read at once. */
  focus: string[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Room kept clear on each side when the graph is framed. */
  padding: FitPadding;
  /** The pane's size when the canvas mounts, which decides the first view. */
  pane: { width: number; height: number };
  /** The minimap gives way while the inspector holds the right edge. */
  minimapAllowed: boolean;
  /** Read-outs drawn into the control strip, before the zoom buttons. */
  readout: ReactNode;
};

/**
 * Memoized so the inspector's one-second clock does not redraw every node. Mount it once per
 * revision: `fitView` frames the graph only on mount, so live updates keep the user's pan.
 */
export const GraphCanvas = memo(function GraphCanvas(props: GraphCanvasProps) {
  const { model, layout, focus, selected, onSelect, padding, pane, minimapAllowed, readout } =
    props;

  const help = useId();
  // Decided once on mount, so live updates and panel toggles never move the user's view.
  const [initial] = useState(() => firstView(layout, focus, padding, pane));
  const [minimap, setMinimap] = useState(model.nodes.length >= MINIMAP_FROM);

  const nodes = useMemo(
    () => [
      ...frameNodes(model, layout),
      ...model.nodes.map(
        (node): FlowNode => ({
          id: node.id,
          type: "loopy",
          position: layout.nodes.get(node.id) ?? { x: 0, y: 0 },
          // Fixed sizes up front: XYFlow measures into its own store, and these nodes are
          // controlled without change handlers, so the minimap reads the size from here.
          ...nodeSize(node),
          data: { model: node },
          selected: node.id === selected,
          draggable: false,
          connectable: false,
        }),
      ),
    ],
    [model, layout, selected],
  );

  const edges = useMemo(() => flowEdges(model, layout), [model, layout]);

  // XYFlow gives a node pointer events only when it has a click handler, is selectable or is
  // draggable, so this handler is what lets the mouse reach the node's button. A key press on
  // the focused button clicks it, and that click bubbles here too. Frames act as the pane.
  const onNodeClick = useCallback<NodeMouseHandler<FlowNode | FrameNode>>(
    (...[, node]) => onSelect(node.type === "frame" || node.id === selected ? null : node.id),
    [onSelect, selected],
  );

  const onPaneClick = useCallback(() => onSelect(null), [onSelect]);

  return (
    <div className="loopy-graph h-full w-full">
      <p id={help} className="sr-only">
        Read-only graph. Tab moves between nodes. Enter or Space opens or closes a node's details.
        Escape closes them.
      </p>
      <ReactFlow
        aria-label={`Graph, ${model.nodes.length} ${model.nodes.length === 1 ? "node" : "nodes"}`}
        aria-describedby={help}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        // Drops XYFlow's arrow-key move handlers and its "move or delete the node" description,
        // neither of which applies to a read-only graph.
        disableKeyboardA11y
        fitView
        fitViewOptions={initial}
        // Long graphs are panned more than zoomed: scrolling pans, a pinch or a held Cmd zooms.
        panOnScroll
        zoomOnScroll={false}
        minZoom={0.15}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
        {minimap && minimapAllowed && <GraphMinimap layout={layout} />}
        <Panel position="bottom-right" className="loopy-view">
          <ViewControls padding={padding} minimap={minimap} onMinimap={setMinimap}>
            {readout}
          </ViewControls>
        </Panel>
      </ReactFlow>
    </div>
  );
});
