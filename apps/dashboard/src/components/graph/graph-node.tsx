import {
  Handle,
  type Node,
  type NodeProps,
  Position,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react";
import type { FocusEvent } from "react";
import { type GraphNodeModel, isInFlight, type NodeState } from "../../lib/graph.ts";
import { NODE_SIZE, nodeSize } from "../../lib/graph-layout.ts";
import { KindGlyph } from "./kind-glyph.tsx";

export type FlowNode = Node<{ model: GraphNodeModel }, "loopy">;

const IDLE_TEXT = {
  not_started: "not started",
  not_run: "not run",
} satisfies Record<Extract<NodeState, { kind: "idle" }>["reason"], string>;

function stateName(state: NodeState): string {
  return state.kind === "ran" ? state.status : state.kind;
}

function spokenState(state: NodeState): string {
  if (state.kind === "idle") {
    return IDLE_TEXT[state.reason];
  }

  return state.kind === "ran" ? state.status.replace("_", " ") : "saved definition";
}

/**
 * The short read-out at the end of a node. In-flight work names its state. Settled work in a
 * map counts the executions that passed out of those that ran, leaving skipped arms out.
 */
function StateMark({ model }: { model: GraphNodeModel }) {
  const { state, executions } = model;

  if (state.kind !== "ran") {
    return null;
  }

  const ran = executions.length - (state.counts.skipped ?? 0);
  const latest = executions.at(-1);

  if (!isInFlight(state.status) && executions.length > 1 && ran > 0) {
    return (
      <span className="node-mark tabular-nums">
        {state.counts.succeeded ?? 0}/{ran}
      </span>
    );
  }

  if (executions.length === 1 && latest !== undefined && latest.attempt > 1) {
    return (
      <span className="node-mark tabular-nums">
        try {latest.attempt}/{latest.maxAttempts}
      </span>
    );
  }

  return <span className="node-mark">{state.status.replace("_", " ")}</span>;
}

const PLATE_W = NODE_SIZE.control.width;

const PLATE_H = NODE_SIZE.control.height;

const PLATE = `M8 .75H${PLATE_W - 15}L${PLATE_W - 0.75} ${PLATE_H / 2}L${PLATE_W - 15} ${PLATE_H - 0.75}H8Q.75 ${PLATE_H - 0.75} .75 ${PLATE_H - 8}V8Q.75 .75 8 .75Z`;

/** Control nodes draw as a signpost plate pointing down the line, so they never read as work. */
function Plate() {
  return (
    <svg className="node-plate" viewBox={`0 0 ${PLATE_W} ${PLATE_H}`} aria-hidden="true">
      <path d={PLATE} />
    </svg>
  );
}

function NodeBody({ model }: { model: GraphNodeModel }) {
  const { role, node, title, detail } = model;

  if (role === "junction" || role === "end") {
    return null;
  }

  if (role === "work") {
    return (
      <>
        <span className="node-lamp" aria-hidden="true" />
        <span className="node-line">
          <KindGlyph kind={node.kind} className="node-glyph" />
          <span className="node-title">{title}</span>
          <StateMark model={model} />
        </span>
        <span className="node-detail">{detail}</span>
      </>
    );
  }

  if (role === "control" || role === "wait") {
    return (
      <>
        {role === "control" && <Plate />}
        <span className="node-badge" aria-hidden="true">
          <KindGlyph kind={node.kind} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="node-line">
            <span className="node-title">{title}</span>
            <StateMark model={model} />
          </span>
          <span className="node-detail">{detail}</span>
        </span>
      </>
    );
  }

  return (
    <>
      <KindGlyph kind={node.kind} className="node-glyph" />
      <span className="node-title shrink-0">{title}</span>
      <span className="node-detail min-w-0 flex-1">{detail}</span>
      <StateMark model={model} />
    </>
  );
}

/**
 * XYFlow pans to a focused node only when the node wrapper itself is focusable. The canvas
 * focuses the button inside instead, so this follows XYFlow's NodeWrapper focus handler: a
 * keyboard focus centres the node at the current zoom. XYFlow skips nodes that are partly in
 * view; this pans unless the whole node is, so a keyboard user sees what they will activate.
 */
function useRevealOnFocus(model: GraphNodeModel, x: number, y: number) {
  const store = useStoreApi<FlowNode>();
  const { setCenter } = useReactFlow<FlowNode>();

  return (event: FocusEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.matches(":focus-visible")) {
      return;
    }

    const { transform, width, height } = store.getState();
    const [panX, panY, zoom] = transform;
    const size = nodeSize(model);
    const left = x * zoom + panX;
    const top = y * zoom + panY;

    if (
      left < 0 ||
      top < 0 ||
      left + size.width * zoom > width ||
      top + size.height * zoom > height
    ) {
      void setCenter(x + size.width / 2, y + size.height / 2, { zoom });
    }
  };
}

/** A button so keyboard users can inspect the node. Its click reaches the canvas's onNodeClick. */
export function GraphNode(props: NodeProps<FlowNode>) {
  const {
    data: { model },
    selected,
    positionAbsoluteX,
    positionAbsoluteY,
  } = props;

  const reveal = useRevealOnFocus(model, positionAbsoluteX, positionAbsoluteY);
  const { state } = model;
  const named = model.role === "end" ? "output" : `${model.node.kind} ${model.title}`;

  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className={`loopy-node node-${model.role}`}
        data-state={stateName(state)}
        data-reason={state.kind === "idle" ? state.reason : undefined}
        aria-pressed={selected}
        aria-label={`${named}, ${spokenState(state)}`}
        title={model.detail === null ? model.id : `${model.id}: ${model.detail}`}
        style={nodeSize(model)}
        onFocus={reveal}
      >
        <NodeBody model={model} />
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}
