import type { GraphView, NodeRunView, ScopeCountsView } from "@loopy/contract";
import { elapsed } from "./format";
import type { GraphModel, GraphNode, GraphNodeModel } from "./graph";
import { isSettled, type Status } from "./status";

/** What the code view says about one node. A definition view passes marks without status. */
export type NodeMark = {
  title: string;
  /** Null when the node has no execution in what the page shows. */
  status: Status | null;
  /** The run finished without reaching this node, so its lines draw dimmed. */
  skipped: boolean;
  /** A short read-out beside the node's first line: "4/4", "try 2 of 3", "1.2s". */
  note: string | null;
  /** The first line of the node's error, printed under its last line. */
  error: string | null;
};

export function firstInside(graph: GraphView, mapId: string): GraphNode["id"] | null {
  const byId = new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node]));
  const map = byId.get(mapId);
  let id = map?.kind === "map" ? map.body : undefined;

  while (id !== undefined) {
    const node = byId.get(id);

    if (node === undefined || node.kind !== "join") {
      return node?.id ?? null;
    }

    id = graph.edges.find((edge) => edge.from === id && edge.kind === "next")?.to;
  }

  return null;
}

/** Whether a map still has items to start, from its rolled-up status. */
export function mapRunning(node: GraphNodeModel | undefined): boolean {
  return node?.state.kind === "ran" && !isSettled(node.state.status);
}

/**
 * A map's read-out. The daemon counts items once they have an execution, so the number is what
 * the run reached so far, never the length of the list being mapped.
 */
export function itemsStarted(total: number, running: boolean): string {
  const items = `${total.toLocaleString()} ${total === 1 ? "item" : "items"}`;

  return running ? `${items} started so far` : `${items} started`;
}

function note(node: GraphNodeModel, now: number): string | null {
  const { executions, state } = node;

  if (state.kind !== "ran") {
    return null;
  }

  const ran = executions.length - (state.counts.skipped ?? 0);

  if (executions.length > 1 && ran > 0) {
    return `${state.counts.succeeded ?? 0}/${ran}`;
  }

  const [only] = executions;

  if (!only) {
    return null;
  }

  if (only.attempt > 1) {
    return `try ${only.attempt} of ${only.maxAttempts}`;
  }

  return "endedAt" in only
    ? elapsed(Date.parse(only.endedAt) - Date.parse(only.startedAt))
    : elapsed(now - Date.parse(only.startedAt));
}

function firstError(executions: NodeRunView[]): string | null {
  const failed = executions.find(
    (execution) => execution.status === "failed" || execution.status === "retrying",
  );

  return failed && "error" in failed
    ? `${failed.error.code}: ${failed.error.message.split("\n")[0]}`
    : null;
}

/**
 * What the code view draws for each node. A node inside a map with no item open has no mark
 * status: the top level holds no execution for it, and saying "not run" would be false. A map
 * shows how many items started, from the root scope summaries.
 */
export function runMarks(options: {
  model: GraphModel;
  itemOpen: boolean;
  scopes: ScopeCountsView[];
  now: number;
}): Map<string, NodeMark> {
  const { model, itemOpen, scopes, now } = options;
  const marks = new Map<string, NodeMark>();

  for (const node of model.nodes) {
    const unknown = node.maps.length > 0 && !itemOpen;
    const map = scopes.find((scope) => scope.nodeId === node.id);
    const status = unknown || node.state.kind !== "ran" ? null : node.state.status;

    marks.set(node.id, {
      title: node.title,
      status,
      skipped: !unknown && node.state.kind === "idle" && node.state.reason === "not_run",
      note: map
        ? itemsStarted(map.total, mapRunning(node))
        : unknown
          ? "per item"
          : node.state.kind === "idle" && node.state.reason === "not_loaded"
            ? "not loaded"
            : note(node, now),
      error: unknown ? null : firstError(node.executions),
    });
  }

  return marks;
}

export function definitionMarks(model: GraphModel): Map<string, NodeMark> {
  return new Map(
    model.nodes.map((node) => [
      node.id,
      { title: node.title, status: null, skipped: false, note: null, error: null },
    ]),
  );
}
