import { MiniMap, useReactFlow, useStore } from "@xyflow/react";
import type { ReactNode } from "react";
import type { NodeRunStatus } from "../../lib/graph.ts";
import type { GraphLayout } from "../../lib/graph-layout.ts";
import type { CanvasFrame } from "../canvas-page.tsx";
import type { FrameNode } from "./graph-frame.tsx";
import type { FlowNode } from "./graph-node.tsx";

const MINIMAP_WIDTH = 240;

/** Long graphs are wide and short, so the minimap takes their shape instead of a fixed box. */
function minimapSize(layout: GraphLayout) {
  const ratio = layout.size.height / Math.max(layout.size.width, 1);

  return {
    width: MINIMAP_WIDTH,
    height: Math.round(Math.min(Math.max(MINIMAP_WIDTH * ratio, 72), 180)),
  };
}

// XYFlow paints minimap nodes with an inline fill, so colours go in as values, not classes.
const MINI_FILL = {
  definition: "var(--line-strong)",
  idle: "var(--line-strong)",
  succeeded: "var(--success)",
  failed: "var(--danger)",
  running: "var(--lamp)",
  queued: "var(--lamp)",
  retrying: "var(--attention)",
  rate_limited: "var(--attention)",
  waiting: "var(--attention)",
  sleeping: "var(--attention)",
  cancelled: "var(--neutral)",
  skipped: "var(--neutral)",
} satisfies Record<NodeRunStatus | "definition" | "idle", string>;

function miniFill(node: FlowNode | FrameNode): string {
  if (node.type === "frame") {
    return "transparent";
  }

  const { state } = node.data.model;

  return MINI_FILL[state.kind === "ran" ? state.status : state.kind];
}

function miniStroke(node: FlowNode | FrameNode): string {
  return node.type === "frame" ? "var(--line-strong)" : "transparent";
}

/** The minimap in the bottom-right corner, above the view controls. */
export function GraphMinimap({ layout }: { layout: GraphLayout }) {
  return (
    <MiniMap<FlowNode | FrameNode>
      pannable
      zoomable
      position="bottom-right"
      ariaLabel="Minimap"
      nodeBorderRadius={3}
      nodeColor={miniFill}
      nodeStrokeColor={miniStroke}
      nodeStrokeWidth={6}
      className="loopy-minimap float"
      style={minimapSize(layout)}
    />
  );
}

function ControlIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

/** Zoom, fit and the minimap switch, in one strip with whatever the page puts beside them. */
export function ViewControls(props: {
  padding: CanvasFrame["padding"];
  minimap: boolean;
  onMinimap: (shown: boolean) => void;
  children: ReactNode;
}) {
  const { padding, minimap, onMinimap, children } = props;
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);

  return (
    <div className="float flex h-9 items-center gap-1 px-1 text-xs">
      {children}
      <span className="flex items-center">
        <button
          type="button"
          className="icon-button"
          onClick={() => void zoomOut({ duration: 160 })}
          aria-label="Zoom out"
        >
          <ControlIcon d="M3.5 8h9" />
        </button>
        <span className="w-10 text-center font-mono text-muted tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={() => void zoomIn({ duration: 160 })}
          aria-label="Zoom in"
        >
          <ControlIcon d="M3.5 8h9M8 3.5v9" />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => void fitView({ padding, maxZoom: 1, duration: 240 })}
          aria-label="Fit the graph to the view"
          title="Fit to view"
        >
          <ControlIcon d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-pressed={minimap}
          onClick={() => onMinimap(!minimap)}
          aria-label={minimap ? "Hide the minimap" : "Show the minimap"}
          title="Minimap"
        >
          <ControlIcon d="M2.5 3.5h11v9h-11zM8.5 7.5h3v3h-3z" />
        </button>
      </span>
    </div>
  );
}
