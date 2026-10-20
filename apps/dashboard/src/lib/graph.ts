import {
  executionKeyString,
  type GraphView,
  isTerminalRun,
  type LogRecord,
  type NodeRunView,
  type RunStatus,
} from "loopy/contract";
import { kindDetail } from "./graph-text.ts";

type GraphNode = GraphView["nodes"][number];

type GraphEdge = GraphView["edges"][number];

export type NodeRunStatus = NodeRunView["status"];

/**
 * What the graph knows about one node. `definition` has no run to compare against; `idle`
 * means the run holds no record for the node, so nothing claims it executed.
 */
export type NodeState =
  | { kind: "definition" }
  | { kind: "idle"; reason: "not_started" | "not_run" }
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
  role: NodeRole;
  title: string;
  detail: string | null;
  executions: NodeRunView[];
  state: NodeState;
};

export type GraphEdgeModel = {
  id: string;
  from: GraphEdge["from"];
  to: GraphEdge["to"];
  kind: GraphEdge["kind"];
  label: string | null;
  /** The run moved along this edge, as far as its records show. See `tookNext`. */
  taken: boolean;
};

export type GraphModel = {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  /** Records whose node is absent from the graph, which means the graph is not the pinned one. */
  orphans: NodeRunView[];
};

// The lowest rank wins, so a node with many executions shows its most urgent one.
const URGENCY = {
  failed: 0,
  running: 1,
  retrying: 2,
  rate_limited: 3,
  waiting: 4,
  sleeping: 5,
  queued: 6,
  cancelled: 7,
  succeeded: 8,
  skipped: 9,
} satisfies Record<NodeRunStatus, number>;

function nodeState(executions: NodeRunView[], run: RunStatus | null): NodeState {
  if (run === null) {
    return { kind: "definition" };
  }

  const [first, ...rest] = executions;

  if (first === undefined) {
    return { kind: "idle", reason: isTerminalRun(run) ? "not_run" : "not_started" };
  }

  const counts: Partial<Record<NodeRunStatus, number>> = { [first.status]: 1 };
  let status = first.status;

  for (const execution of rest) {
    counts[execution.status] = (counts[execution.status] ?? 0) + 1;
    status = URGENCY[execution.status] < URGENCY[status] ? execution.status : status;
  }

  return { kind: "ran", status, counts };
}

function scopeId(execution: NodeRunView): string {
  return JSON.stringify(execution.key.scope);
}

/**
 * Node runs record no incoming edge, so this infers one. A `next` edge counts when its source
 * succeeded and its target then ran, not skipped, in the same scope. The sequence engine walks
 * only `next` edges, which makes that exact for it. Control edges stay unmarked until branch,
 * switch and scope nodes record the arm they chose.
 */
function tookNext(edge: GraphEdge, byNode: Map<string, NodeRunView[]>): boolean {
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

/** Sequence and join edges say nothing a reader needs; control edges name the arm they enter. */
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

/**
 * Joins a graph with the node runs recorded against it. Pass `run: null` to draw the
 * definition alone. Executions keep the order the snapshot holds them in.
 */
export function graphModel(
  graph: GraphView,
  run: { status: RunStatus; nodeRuns: NodeRunView[] } | null,
): GraphModel {
  const byNode = new Map<string, NodeRunView[]>();

  for (const execution of run?.nodeRuns ?? []) {
    byNode.set(execution.key.nodeId, [...(byNode.get(execution.key.nodeId) ?? []), execution]);
  }

  const leaves = new Set<string>(graph.nodes.map((node) => node.id));

  for (const edge of graph.edges) {
    leaves.delete(edge.from);
  }

  const nodes = graph.nodes.map((node): GraphNodeModel => {
    const executions = byNode.get(node.id) ?? [];

    return {
      id: node.id,
      node,
      role:
        node.kind === "join" && node.scope === null && leaves.has(node.id)
          ? "end"
          : ROLE[node.kind],
      title: node.label ?? node.kind,
      detail: kindDetail(node),
      executions,
      state: nodeState(executions, run?.status ?? null),
    };
  });

  const known = new Set<string>(graph.nodes.map((node) => node.id));

  return {
    nodes,
    edges: graph.edges.map((edge) => ({
      id: `${edge.from}->${edge.to}:${edge.kind === "case" ? `case:${edge.label}` : edge.kind}`,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edgeLabel(edge),
      taken: tookNext(edge, byNode),
    })),
    orphans: (run?.nodeRuns ?? []).filter((execution) => !known.has(execution.key.nodeId)),
  };
}

const IN_FLIGHT = new Set<NodeRunStatus>([
  "running",
  "retrying",
  "rate_limited",
  "waiting",
  "sleeping",
  "queued",
]);

/** Work that has started and not settled: running, retrying, or held for a person or a clock. */
export function isInFlight(status: NodeRunStatus): boolean {
  return IN_FLIGHT.has(status);
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

/** Where an execution sits inside maps and other scopes, or `null` at the top level. */
export function scopeText(execution: NodeRunView): string | null {
  return execution.key.scope.length === 0
    ? null
    : execution.key.scope.map(({ nodeId, index }) => `${nodeId}[${index}]`).join(" / ");
}

export type AttemptLogs = { attempt: number; logs: LogRecord[] };

/**
 * Logs written by one execution, grouped by the attempt that wrote them in write order. The
 * store keeps one record per execution key, so earlier attempts survive only in their logs.
 */
export function executionLogs(logs: LogRecord[], execution: NodeRunView): AttemptLogs[] {
  const key = executionKeyString(execution.key);
  const groups: AttemptLogs[] = [];

  for (const log of logs) {
    if (log.position.kind !== "node" || log.position.executionKey !== key) {
      continue;
    }

    const last = groups.at(-1);

    if (last?.attempt === log.position.attempt) {
      last.logs.push(log);
    } else {
      groups.push({ attempt: log.position.attempt, logs: [log] });
    }
  }

  return groups;
}
