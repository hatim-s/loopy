import type { GraphView, NodeRunView } from "loopy/contract";
import type { NodeMark } from "../components/code/code-view.tsx";
import { elapsed } from "./format.ts";
import type { GraphModel, GraphNodeModel } from "./graph.ts";
import type { ScopeSummary } from "./view-models.ts";

type GraphNode = GraphView["nodes"][number];

/**
 * Nodes that execute once per map item. Their executions carry a scope tuple, so the run's top
 * level says nothing about them until a reader opens one item.
 */
export function perItemNodes(graph: GraphView): Set<string> {
  const byId = new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node]));
  const inside = new Set<string>();

  for (const node of graph.nodes) {
    let parent = node.scope === null ? undefined : byId.get(node.scope);

    while (parent) {
      if (parent.kind === "map") {
        inside.add(node.id);
        break;
      }

      parent = parent.scope === null ? undefined : byId.get(parent.scope);
    }
  }

  return inside;
}

/** The innermost map that owns a node through its scope chain, if any. */
export function owningMap(graph: GraphView, nodeId: string): GraphNode["id"] | null {
  const byId = new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node]));
  let parent = byId.get(nodeId)?.scope ?? null;

  while (parent !== null) {
    const node = byId.get(parent);

    if (node?.kind === "map") {
      return node.id;
    }

    parent = node?.scope ?? null;
  }

  return null;
}

/** The first node of a map's body that does work, skipping joins that only merge arms. */
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

const SETTLED = new Set<NodeRunView["status"]>(["succeeded", "failed", "cancelled", "skipped"]);

/**
 * A map's read-out. The daemon counts items once they have an execution, so the number is what
 * the run reached so far, never the length of the list being mapped.
 */
function mapNote(node: GraphNodeModel, summary: ScopeSummary): string {
  const done = node.state.kind === "ran" && SETTLED.has(node.state.status);
  const items = `${summary.total.toLocaleString()} ${summary.total === 1 ? "item" : "items"}`;

  return done ? `${items} started` : `${items} started so far`;
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
  perItem: Set<string>;
  itemOpen: boolean;
  scopes: ScopeSummary[];
  now: number;
}): Map<string, NodeMark> {
  const { model, perItem, itemOpen, scopes, now } = options;
  const marks = new Map<string, NodeMark>();

  for (const node of model.nodes) {
    const unknown = perItem.has(node.id) && !itemOpen;
    const map = scopes.find((scope) => scope.nodeId === node.id);
    const status = unknown || node.state.kind !== "ran" ? null : node.state.status;

    marks.set(node.id, {
      title: node.title,
      status,
      skipped: !unknown && node.state.kind === "idle" && node.state.reason === "not_run",
      note: map
        ? mapNote(node, map)
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

/** Marks for a saved definition: titles only, nothing claims a run. */
export function definitionMarks(model: GraphModel): Map<string, NodeMark> {
  return new Map(
    model.nodes.map((node) => [
      node.id,
      { title: node.title, status: null, skipped: false, note: null, error: null },
    ]),
  );
}
