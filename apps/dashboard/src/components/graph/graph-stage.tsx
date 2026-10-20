import type { GraphRevisionView, LogRecord, NodeRunView, RunStatus } from "loopy/contract";
import { useEffect, useMemo, useState } from "react";
import { focusNodes, type GraphModel, graphModel, type NodeRunStatus } from "../../lib/graph.ts";
import { layoutGraph } from "../../lib/graph-layout.ts";
import { type CanvasFrame, CanvasMessage, px, SHELL } from "../canvas-page.tsx";
import { StatusDot } from "../status-badge.tsx";
import { GraphCanvas } from "./graph-canvas.tsx";
import { NodeInspector } from "./node-inspector.tsx";

export type GraphRun = {
  status: RunStatus;
  nodeRuns: NodeRunView[];
  logs: LogRecord[];
  /** The loopy's current save, or null when it is unknown or the loopy was removed. */
  latestRevision: string | null;
};

/** Node counts by state, folded into the control strip so the canvas stays clear. */
function Readout({ model, revision }: { model: GraphModel; revision: string }) {
  const ran = new Map<NodeRunStatus, number>();

  for (const { state } of model.nodes) {
    if (state.kind === "ran") {
      ran.set(state.status, (ran.get(state.status) ?? 0) + 1);
    }
  }

  return (
    <ul className="flex items-center gap-x-3 border-r border-line pr-3 pl-2 text-muted tabular-nums max-md:hidden">
      {[...ran].map(([status, count]) => (
        <li
          key={status}
          className="inline-flex items-center gap-1.5"
          title={`${count} ${status.replace("_", " ")}`}
        >
          <StatusDot status={status} />
          {count}
          <span className="sr-only">{status.replace("_", " ")}</span>
        </li>
      ))}
      <li>
        {model.nodes.length} {model.nodes.length === 1 ? "node" : "nodes"}
      </li>
      <li>
        <code className="font-mono" title={`Revision ${revision}`}>
          {revision.slice(0, 7)}
        </code>
      </li>
    </ul>
  );
}

function Notices({
  model,
  view,
  run,
}: {
  model: GraphModel;
  view: GraphRevisionView;
  run: GraphRun | null;
}) {
  const older = run !== null && run.latestRevision !== null && run.latestRevision !== view.revision;
  const { warnings } = view.graph;

  if (!older && model.orphans.length === 0 && warnings.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute top-[calc(var(--bar-h)+var(--gap)*2)] right-(--gap) left-[calc(var(--side-w)+var(--gap)*2)] z-10 flex flex-col items-center gap-1.5 max-md:hidden">
      {model.orphans.length > 0 && (
        <p role="alert" className="float pointer-events-auto px-3 py-1.5 text-xs text-danger">
          {model.orphans.length} node {model.orphans.length === 1 ? "record names" : "records name"}{" "}
          nodes missing from this revision, so this graph does not match the run.
        </p>
      )}
      {older && (
        <p
          className="float pointer-events-auto px-3 py-1.5 text-xs text-muted"
          title={`The loopy now saves revision ${run.latestRevision}`}
        >
          This run pinned an older revision than the current save.
        </p>
      )}
      {warnings.length > 0 && (
        <details className="float pointer-events-auto max-w-xl px-3 py-1.5 text-xs text-attention">
          <summary className="cursor-pointer">
            {warnings.length} compiler {warnings.length === 1 ? "warning" : "warnings"}
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {warnings.map((warning) => (
              <li key={`${warning.code}:${warning.nodeId}:${warning.message}`}>
                {warning.code}
                {warning.nodeId !== null && ` at ${warning.label ?? warning.nodeId}`}:{" "}
                {warning.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * One graph with its run state, filling the canvas page. `run` is null for a saved definition.
 * The graph must be the revision the run pinned, which the orphan notice makes visible when it
 * is not.
 */
export function GraphStage(props: {
  view: GraphRevisionView;
  run: GraphRun | null;
  now: number;
  frame: CanvasFrame;
}) {
  const { view, run, now, frame } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const status = run?.status;
  const nodeRuns = run?.nodeRuns;

  // The route builds `run` each render, so the model keys on the parts that change it.
  const model = useMemo(
    () =>
      graphModel(
        view.graph,
        status === undefined || nodeRuns === undefined ? null : { status, nodeRuns },
      ),
    [view.graph, status, nodeRuns],
  );

  const layout = useMemo(() => layoutGraph(graphModel(view.graph, null)), [view.graph]);
  const inspected = model.nodes.find((node) => node.id === selected);

  useEffect(() => {
    if (selected === null) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setSelected(null);
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  const padding = useMemo(
    () => ({
      ...frame.padding,
      ...(inspected && { right: px(SHELL.inspector + SHELL.gap * 3) }),
    }),
    [frame.padding, inspected],
  );

  const focus = useMemo(() => focusNodes(model, view.graph.entry), [model, view.graph.entry]);

  const readout = useMemo(
    () => <Readout model={model} revision={view.revision} />,
    [model, view.revision],
  );

  if (model.nodes.length === 0) {
    return <CanvasMessage>This revision has no nodes to draw.</CanvasMessage>;
  }

  return (
    <>
      <GraphCanvas
        key={view.revision}
        model={model}
        layout={layout}
        focus={focus}
        selected={selected}
        onSelect={setSelected}
        padding={padding}
        minimapAllowed={inspected === undefined}
        readout={readout}
      />
      <Notices model={model} view={view} run={run} />
      {inspected !== undefined && (
        <NodeInspector
          model={inspected}
          logs={run?.logs ?? []}
          now={now}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
