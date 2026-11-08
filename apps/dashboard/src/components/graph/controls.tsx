import { MiniMap, useReactFlow, useStore } from "@xyflow/react";
import { FIT_PADDING, type GraphLayout } from "../../lib/graph-layout";
import { statusTone, TONE_FILL } from "../../lib/status";
import type { FrameNode } from "./frame";
import type { FlowNode } from "./node";

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
function miniFill(node: FlowNode | FrameNode): string {
  if (node.type === "frame") {
    return "transparent";
  }

  const { state } = node.data.model;

  return state.kind === "ran" ? TONE_FILL[statusTone(state.status)] : "var(--line-strong)";
}

function miniStroke(node: FlowNode | FrameNode): string {
  return node.type === "frame" ? "var(--line-strong)" : "transparent";
}

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

export function ViewControls(props: { minimap: boolean; onMinimap: (shown: boolean) => void }) {
  const { minimap, onMinimap } = props;
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);

  return (
    <div className="float flex h-9 items-center gap-1 px-1 text-xs">
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
          onClick={() => void fitView({ padding: FIT_PADDING, maxZoom: 1, duration: 240 })}
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
