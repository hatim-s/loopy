import type { Edge, Node } from "@xyflow/react";
import type {
  ApiMutationDescriptor,
  ApiQueryDescriptor,
  DebuggerEvent,
  NodeAttempt,
  StudioStatus,
} from "../types.ts";
import { type DebuggerState, eventIdentity } from "./reducer.ts";

export interface DebugNodeData extends Record<string, unknown> {
  nodeId: string;
  label: string;
  status: string;
  attemptCount: number;
  selected: boolean;
  kind?: string;
}

export type DebugFlowNode = Node<DebugNodeData, "debugger-node">;

export interface GraphInputNode {
  id: string;
  name?: string;
  label?: string;
  kind?: string;
}

export interface GraphInputEdge {
  id?: string;
  source: string;
  target: string;
  label?: string;
  branch?: string;
}

export interface DebuggerGraphModel {
  nodes: DebugFlowNode[];
  edges: Edge[];
}

export function buildDebuggerGraph(
  inputNodes: readonly GraphInputNode[],
  inputEdges: readonly GraphInputEdge[],
  attempts: readonly NodeAttempt[],
  selectedNodeId?: string,
): DebuggerGraphModel {
  const attemptsByNode = new Map<string, NodeAttempt[]>();
  for (const attempt of attempts)
    attemptsByNode.set(attempt.nodeId, [...(attemptsByNode.get(attempt.nodeId) ?? []), attempt]);
  const nodes = inputNodes.map((node, index) => {
    const nodeAttempts = attemptsByNode.get(node.id) ?? [];
    const current = nodeAttempts.at(-1);
    return {
      id: node.id,
      type: "debugger-node",
      position: { x: (index % 4) * 220, y: Math.floor(index / 4) * 120 },
      data: {
        nodeId: node.id,
        label: node.label ?? node.name ?? node.id,
        status: current?.status ?? "pending",
        attemptCount: nodeAttempts.length,
        selected: node.id === selectedNodeId,
        ...(node.kind ? { kind: node.kind } : {}),
      },
      ariaLabel: `${node.label ?? node.name ?? node.id}, ${current?.status ?? "pending"}`,
    } satisfies DebugFlowNode;
  });
  const edges = inputEdges.map((edge, index) => ({
    id: edge.id ?? `${edge.source}->${edge.target}:${index}`,
    source: edge.source,
    target: edge.target,
    label: edge.label ?? edge.branch,
    animated: false,
    type: "smoothstep",
  }));
  return { nodes, edges };
}

export interface TimelineItem {
  eventId: string;
  sequence?: number;
  type: string;
  label: string;
  nodeId?: string;
  attemptId?: string;
  occurredAt?: string;
  selected: boolean;
  kind: "run" | "node" | "attempt" | "provider" | "tool" | "artifact" | "warning" | "other";
}

function timelineKind(type: string): TimelineItem["kind"] {
  if (type.startsWith("run.")) return "run";
  if (type.startsWith("node.")) return "node";
  if (type.startsWith("attempt.")) return "attempt";
  if (type.startsWith("provider.")) return "provider";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("artifact.") || type.startsWith("workspace.")) return "artifact";
  if (type.includes("warning") || type.includes("failed")) return "warning";
  return "other";
}

export function buildTimeline(
  events: readonly DebuggerEvent[],
  selectedEventId?: string,
): TimelineItem[] {
  return [...events]
    .sort(
      (left, right) =>
        (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER),
    )
    .map((event) => ({
      eventId: eventIdentity(event),
      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
      type: event.type,
      label: event.type.replaceAll("_", " ").replaceAll(".", " / "),
      ...(event.nodeId ? { nodeId: event.nodeId } : {}),
      ...(event.attemptId ? { attemptId: event.attemptId } : {}),
      ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
      selected: eventIdentity(event) === selectedEventId,
      kind: timelineKind(event.type),
    }));
}

export interface SelectionModel {
  nodeId?: string;
  attemptId?: string;
  eventId?: string;
  event?: DebuggerEvent;
  attempt?: NodeAttempt;
}

export function selectDebuggerDetails(state: DebuggerState): SelectionModel {
  const event = state.selectedEventId
    ? state.events.find((item) => eventIdentity(item) === state.selectedEventId)
    : undefined;
  const attempt = state.selectedAttemptId
    ? state.attempts.find((item) => item.attemptId === state.selectedAttemptId)
    : state.selectedNodeId
      ? state.attempts.filter((item) => item.nodeId === state.selectedNodeId).at(-1)
      : undefined;
  return {
    nodeId: state.selectedNodeId,
    attemptId: state.selectedAttemptId,
    eventId: state.selectedEventId,
    event,
    attempt,
  };
}

export interface ControlState {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  retryFailedNode: boolean;
  replay: boolean;
  fork: boolean;
}

export function legalControls(status: StudioStatus, selectedAttempt?: NodeAttempt): ControlState {
  const active = status === "live";
  const failedAttempt = selectedAttempt?.status === "failed";
  return {
    pause: active,
    resume: status === "paused",
    cancel: active || status === "paused",
    retryFailedNode:
      (status === "failed" || status === "completed" || status === "paused") && failedAttempt,
    replay: status === "completed" || status === "failed" || status === "paused",
    fork:
      Boolean(selectedAttempt) &&
      (status === "completed" || status === "failed" || status === "paused"),
  };
}

export type RunCommand = "pause" | "resume" | "cancel" | "retry" | "replay" | "fork";

export function runQuery(runId: string): ApiQueryDescriptor {
  return { kind: "query", key: ["run", runId], endpoint: `/api/runs/${encodeURIComponent(runId)}` };
}

export function eventsQuery(runId: string): ApiQueryDescriptor {
  return {
    kind: "query",
    key: ["run", runId, "events"],
    endpoint: `/api/runs/${encodeURIComponent(runId)}/events`,
  };
}

export function runMutation(
  runId: string,
  command: RunCommand,
  body: Record<string, unknown> = {},
): ApiMutationDescriptor<Record<string, unknown>, unknown> {
  const endpoint =
    command === "retry"
      ? `/api/runs/${encodeURIComponent(runId)}/retry`
      : `/api/runs/${encodeURIComponent(runId)}/${command}`;
  return { kind: "mutation", key: `${command}:${runId}`, method: "POST", endpoint, body };
}

export function retryNodeMutation(
  runId: string,
  nodeId: string,
): ApiMutationDescriptor<{ nodeId: string }, unknown> {
  return runMutation(runId, "retry", { nodeId }) as ApiMutationDescriptor<
    { nodeId: string },
    unknown
  >;
}

export function forkCheckpointMutation(
  runId: string,
  checkpointEventId: string,
): ApiMutationDescriptor<{ checkpointEventId: string }, unknown> {
  return runMutation(runId, "fork", { checkpointEventId }) as ApiMutationDescriptor<
    { checkpointEventId: string },
    unknown
  >;
}

/** Replay is deliberately local event playback: this function has no API seam and never executes a provider. */
export async function replayEvents(
  events: readonly DebuggerEvent[],
  onEvent: (event: DebuggerEvent, index: number) => void | Promise<void>,
  options: { delayMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const ordered = [...events].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  let played = 0;
  for (const [index, event] of ordered.entries()) {
    if (options.signal?.aborted) break;
    await onEvent(event, index);
    played += 1;
    if (options.delayMs && index < ordered.length - 1)
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  return played;
}

export interface ReplayController {
  readonly events: readonly DebuggerEvent[];
  play(onEvent: (event: DebuggerEvent, index: number) => void | Promise<void>): Promise<number>;
  stop(): void;
}

export function createReplayController(
  events: readonly DebuggerEvent[],
  delayMs = 0,
): ReplayController {
  let controller: AbortController | undefined;
  return {
    events,
    play(onEvent) {
      controller?.abort();
      controller = new AbortController();
      return replayEvents(events, onEvent, { delayMs, signal: controller.signal });
    },
    stop() {
      controller?.abort();
    },
  };
}
