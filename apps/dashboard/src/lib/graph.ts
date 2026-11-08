import {
  executionKeyString,
  type GraphView,
  isTerminalRun,
  type NodeRun,
  type RunStatus,
} from "@loopy/contract";
import { kindDetail } from "./graph-text";
import { byUrgency, isInFlight, type NodeRunStatus } from "./status";
import type { ScopeTuple } from "./view-models";

export type GraphNode = GraphView["nodes"][number];

type GraphEdge = GraphView["edges"][number];

/**
 * What the graph knows about one node. `definition` has no run to compare against. An idle
 * node is known absent only when its scope was loaded completely; otherwise it is not loaded.
 */
export type NodeState =
  | { kind: "definition" }
  | { kind: "idle"; reason: "not_started" | "not_run" | "not_loaded" }
  | { kind: "ran"; status: NodeRunStatus; counts: Partial<Record<NodeRunStatus, number>> };

/**
 * How a node draws. Work runs author code or a command. Control routes into scoped arms. Wait
 * holds the run for a person or a timer. Value nodes compute inline. A junction merges arms back
 * together, and the end is the top-level join that carries the graph's output.
 */
export type NodeRole = "work" | "control" | "wait" | "value" | "fail" | "junction" | "end";

const ROLE = {
  code: "work",
  command: "work",
  branch: "control",
  switch: "control",
  map: "control",
  parallel: "control",
  finally: "control",
  rescue: "control",
  wait: "wait",
  sleep: "wait",
  fail: "fail",
  format: "value",
  log: "value",
  now: "value",
  uuid: "value",
  random: "value",
  join: "junction",
} satisfies Record<GraphNode["kind"], NodeRole>;

export type GraphNodeModel = {
  id: GraphNode["id"];
  node: GraphNode;
  /** The maps whose scopes hold this node, outermost first. A non-empty list runs per item. */
  maps: GraphNode["id"][];
  role: NodeRole;
  title: string;
  detail: string | null;
  executions: NodeRun[];
  state: NodeState;
};

export type GraphEdgeModel = {
  id: string;
  from: GraphEdge["from"];
  to: GraphEdge["to"];
  kind: GraphEdge["kind"];
  label: string | null;
  taken: boolean;
};

export type ExecutionCoverage = { scope: ScopeTuple; complete: boolean };

export type GraphModel = {
  historyIncomplete: boolean;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  /** Records whose node is absent from the graph, which means the graph is not the pinned one. */
  orphans: NodeRun[];
};

function nodeState(executions: NodeRun[], run: RunStatus | null, complete: boolean): NodeState {
  if (run === null) {
    return { kind: "definition" };
  }

  const [first, ...rest] = executions;

  if (first === undefined) {
    if (!complete) {
      return { kind: "idle", reason: "not_loaded" };
    }

    return { kind: "idle", reason: isTerminalRun(run) ? "not_run" : "not_started" };
  }

  const counts: Partial<Record<NodeRunStatus, number>> = { [first.status]: 1 };
  let status = first.status;

  for (const execution of rest) {
    counts[execution.status] = (counts[execution.status] ?? 0) + 1;
    status = byUrgency(execution.status, status) < 0 ? execution.status : status;
  }

  return { kind: "ran", status, counts };
}

function scopeId(execution: NodeRun): string {
  return JSON.stringify(execution.key.scope);
}

/**
 * Node runs record no incoming edge, so this infers one. A `next` edge counts when its source
 * succeeded and its target then ran, not skipped, in the same scope. The sequence engine walks
 * only `next` edges, which makes that exact for it. Control edges stay unmarked until branch,
 * switch and scope nodes record the arm they chose.
 */
function tookNext(edge: GraphEdge, byNode: Map<string, NodeRun[]>): boolean {
  if (edge.kind !== "next") {
    return false;
  }

  const reached = new Set(
    (byNode.get(edge.to) ?? [])
      .filter((execution) => execution.status !== "skipped")
      .map((execution) => scopeId(execution)),
  );

  return (byNode.get(edge.from) ?? []).some(
    (execution) => execution.status === "succeeded" && reached.has(scopeId(execution)),
  );
}

// Sequence and join edges say nothing a reader needs; control edges name the arm they enter.
function edgeLabel(edge: GraphEdge): string | null {
  switch (edge.kind) {
    case "next":
    case "join": {
      return null;
    }

    case "case": {
      return edge.label;
    }

    default: {
      return edge.kind;
    }
  }
}

/** Pass `run: null` to draw the definition alone. Executions keep the snapshot's order. */
export function graphModel(
  graph: GraphView,
  run: {
    status: RunStatus;
    nodeRuns: NodeRun[];
    coverage: ExecutionCoverage[];
    selectedExecutions?: NodeRun[];
  } | null,
): GraphModel {
  const records = new Map(
    (run?.nodeRuns ?? []).map((execution) => [executionKeyString(execution.key), execution]),
  );

  for (const execution of run?.selectedExecutions ?? []) {
    records.set(executionKeyString(execution.key), execution);
  }

  const byNode = new Map<string, NodeRun[]>();

  for (const execution of records.values()) {
    byNode.set(execution.key.nodeId, [...(byNode.get(execution.key.nodeId) ?? []), execution]);
  }

  const leaves = new Set<string>(graph.nodes.map((node) => node.id));

  for (const edge of graph.edges) {
    leaves.delete(edge.from);
  }

  const definitions = new Map(graph.nodes.map((node) => [node.id, node]));

  const nodes = graph.nodes.map((node): GraphNodeModel => {
    const executions = byNode.get(node.id) ?? [];
    const maps: GraphNode["id"][] = [];
    let parent = node.scope === null ? undefined : definitions.get(node.scope);

    while (parent) {
      if (parent.kind === "map") {
        maps.unshift(parent.id);
      }

      parent = parent.scope === null ? undefined : definitions.get(parent.scope);
    }

    const complete =
      run?.coverage.some(
        (page) =>
          page.complete &&
          page.scope.length === maps.length &&
          page.scope.every((part, index) => part.nodeId === maps[index]),
      ) ?? false;

    return {
      id: node.id,
      node,
      maps,
      role:
        node.kind === "join" && node.scope === null && leaves.has(node.id)
          ? "end"
          : ROLE[node.kind],
      title: node.label ?? node.kind,
      detail: kindDetail(node),
      executions,
      state: nodeState(executions, run?.status ?? null, complete),
    };
  });

  const known = new Set<string>(graph.nodes.map((node) => node.id));

  return {
    historyIncomplete: run?.coverage.some((page) => !page.complete) ?? false,
    nodes,
    edges: graph.edges.map((edge) => ({
      id: `${edge.from}->${edge.to}:${edge.kind === "case" ? `case:${edge.label}` : edge.kind}`,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edgeLabel(edge),
      taken: tookNext(edge, byNode),
    })),
    orphans: [...records.values()].filter((execution) => !known.has(execution.key.nodeId)),
  };
}

/**
 * The nodes to frame first when the whole graph is too big to read at once: where the run is
 * now, else where it failed, else the entry, so a reader lands on what matters. A control node
 * stays in flight while anything in its scope runs, so the work inside it wins.
 */
export function focusNodes(model: GraphModel, entry: string): string[] {
  const ran = (test: (status: NodeRunStatus) => boolean) =>
    model.nodes.filter((node) => node.state.kind === "ran" && test(node.state.status));

  const active = ran(isInFlight);
  const inner = active.filter((node) => node.role !== "control");
  const failed = ran((status) => status === "failed");
  const [first] = [inner, active, failed].filter((nodes) => nodes.length > 0);

  return first === undefined ? [entry] : first.map((node) => node.id);
}
