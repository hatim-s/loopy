import type { TraceEvent } from "@loopy/contracts";
import type {
  ArtifactRef,
  DebuggerEvent,
  DebuggerSnapshot,
  NodeAttempt,
  StudioStatus,
} from "../types.ts";

export interface DebuggerState {
  runId: string;
  status: StudioStatus;
  events: readonly DebuggerEvent[];
  attempts: readonly NodeAttempt[];
  artifacts: readonly ArtifactRef[];
  selectedNodeId?: string;
  selectedAttemptId?: string;
  selectedEventId?: string;
  reconnects: number;
  lastSequence: number;
  error?: string;
}

export type DebuggerAction =
  | { type: "snapshot"; snapshot: DebuggerSnapshot }
  | { type: "events"; events: readonly DebuggerEvent[]; reconnect?: boolean }
  | { type: "event"; event: DebuggerEvent; reconnect?: boolean }
  | { type: "select_node"; nodeId?: string }
  | { type: "select_attempt"; attemptId?: string }
  | { type: "select_event"; eventId?: string }
  | { type: "error"; error: string }
  | { type: "clear_error" };

const terminalStatuses = new Set<StudioStatus>(["failed", "completed"]);

function eventKey(event: DebuggerEvent): string {
  return (
    event.eventId ?? event.id ?? `${event.runId ?? "run"}:${event.sequence ?? "?"}:${event.type}`
  );
}

function compareEvents(left: DebuggerEvent, right: DebuggerEvent): number {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  const leftTime = left.occurredAt ?? "";
  const rightTime = right.occurredAt ?? "";
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
  return eventKey(left).localeCompare(eventKey(right));
}

/** Stable merge for SSE reconnects. Duplicate IDs are retained once, even if sequence order changes. */
export function mergeDebuggerEvents(
  existing: readonly DebuggerEvent[],
  incoming: readonly DebuggerEvent[],
): DebuggerEvent[] {
  const byId = new Map<string, DebuggerEvent>();
  for (const event of [...existing, ...incoming]) {
    const key = eventKey(event);
    const previous = byId.get(key);
    // Prefer the richer event received after a reconnect, while keeping event identity stable.
    if (!previous || Object.keys(event).length >= Object.keys(previous).length)
      byId.set(key, event);
  }
  return [...byId.values()].sort(compareEvents);
}

function statusFromEvents(
  events: readonly DebuggerEvent[],
  fallback: StudioStatus = "loading",
): StudioStatus {
  let status = fallback;
  for (const event of events) {
    switch (event.type) {
      case "run.created":
      case "run.started":
        status = "live";
        break;
      case "run.pause_requested":
      case "run.paused":
        status = "paused";
        break;
      case "run.resumed":
      case "run.cancelling":
        status = "live";
        break;
      case "run.completed":
        status = event.payload?.status === "failed" ? "failed" : "completed";
        break;
      case "runtime.recovery":
        if (event.payload?.action === "paused_run") status = "paused";
        break;
      case "run.failed":
        status = "failed";
        break;
    }
  }
  return status;
}

function attemptStatus(event: DebuggerEvent): NodeAttempt["status"] | undefined {
  const payload = event.payload;
  if (event.type === "attempt.created") return "pending";
  if (event.type === "node.ready") return "ready";
  if (event.type === "node.started") return "running";
  if (event.type === "node.completed") return "succeeded";
  if (event.type === "attempt.failed") return "failed";
  if (event.type === "attempt.cancelled") return "cancelled";
  if (event.type === "node.blocked" || event.type === "approval.requested")
    return "blocked_approval";
  if (event.type === "attempt.retrying") return "ready";
  if (
    payload?.status === "succeeded" ||
    payload?.status === "failed" ||
    payload?.status === "cancelled"
  ) {
    return payload.status;
  }
  return undefined;
}

function mergeAttempts(
  existing: readonly NodeAttempt[],
  events: readonly DebuggerEvent[],
): NodeAttempt[] {
  const byId = new Map(existing.map((attempt) => [attempt.attemptId, { ...attempt }]));
  for (const event of events) {
    if (!event.attemptId) continue;
    const current = byId.get(event.attemptId) ?? {
      attemptId: event.attemptId,
      nodeId: event.nodeId ?? "unknown",
      attempt: typeof event.payload?.attempt === "number" ? event.payload.attempt : 1,
      status: "pending",
    };
    const status = attemptStatus(event);
    const payload = event.payload ?? {};
    byId.set(event.attemptId, {
      ...current,
      nodeId: event.nodeId ?? current.nodeId,
      ...(status ? { status } : {}),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      ...(payload.input && typeof payload.input === "object"
        ? { input: payload.input as NodeAttempt["input"] }
        : {}),
      ...(payload.output && typeof payload.output === "object"
        ? { output: payload.output as NodeAttempt["output"] }
        : {}),
      ...(typeof event.occurredAt === "string" && status === "running"
        ? { startedAt: event.occurredAt }
        : {}),
      ...(typeof event.occurredAt === "string" &&
      ["succeeded", "failed", "cancelled"].includes(status ?? "")
        ? { endedAt: event.occurredAt }
        : {}),
    });
  }
  return [...byId.values()].sort(
    (left, right) => left.nodeId.localeCompare(right.nodeId) || left.attempt - right.attempt,
  );
}

function artifactsFromEvents(
  events: readonly DebuggerEvent[],
  existing: readonly ArtifactRef[],
): ArtifactRef[] {
  const byId = new Map(existing.map((artifact) => [artifact.id ?? artifact.name, artifact]));
  for (const event of events) {
    if (event.type !== "artifact.recorded" && event.type !== "workspace.diff_created") continue;
    const artifact = event.payload?.artifact;
    if (
      !artifact ||
      typeof artifact !== "object" ||
      typeof (artifact as { name?: unknown }).name !== "string"
    )
      continue;
    const value = artifact as Record<string, unknown>;
    const normalized: ArtifactRef = {
      name: value.name as string,
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
      ...(typeof value.sizeBytes === "number" ? { sizeBytes: value.sizeBytes } : {}),
      ...(typeof value.sourcePath === "string" ? { sourcePath: value.sourcePath } : {}),
    };
    byId.set(normalized.id ?? normalized.name, normalized);
  }
  return [...byId.values()];
}

function withEvents(
  state: DebuggerState,
  events: readonly DebuggerEvent[],
  reconnects = state.reconnects,
): DebuggerState {
  const merged = mergeDebuggerEvents(state.events, events);
  return {
    ...state,
    events: merged,
    attempts: mergeAttempts(state.attempts, events),
    artifacts: artifactsFromEvents(events, state.artifacts),
    status: statusFromEvents(merged, state.status),
    reconnects,
    lastSequence: merged.reduce((max, event) => Math.max(max, event.sequence ?? max), 0),
  };
}

export function createDebuggerState(runId: string): DebuggerState {
  return {
    runId,
    status: "loading",
    events: [],
    attempts: [],
    artifacts: [],
    reconnects: 0,
    lastSequence: 0,
  };
}

export function debuggerReducer(state: DebuggerState, action: DebuggerAction): DebuggerState {
  switch (action.type) {
    case "snapshot": {
      const next = createDebuggerState(action.snapshot.runId);
      const merged = withEvents(next, action.snapshot.events);
      return {
        ...merged,
        status: action.snapshot.status as StudioStatus,
        attempts: action.snapshot.attempts
          ? mergeAttempts(action.snapshot.attempts, action.snapshot.events)
          : merged.attempts,
        artifacts: action.snapshot.artifacts
          ? artifactsFromEvents(action.snapshot.events, action.snapshot.artifacts)
          : merged.artifacts,
        error: undefined,
      };
    }
    case "events":
      return withEvents(state, action.events, state.reconnects + (action.reconnect ? 1 : 0));
    case "event":
      return withEvents(state, [action.event], state.reconnects + (action.reconnect ? 1 : 0));
    case "select_node":
      return {
        ...state,
        selectedNodeId: action.nodeId,
        selectedAttemptId: undefined,
        selectedEventId: undefined,
      };
    case "select_attempt":
      return {
        ...state,
        selectedAttemptId: action.attemptId,
        selectedNodeId: state.selectedNodeId,
        selectedEventId: undefined,
      };
    case "select_event":
      return { ...state, selectedEventId: action.eventId };
    case "error":
      return { ...state, status: "error", error: action.error };
    case "clear_error":
      return {
        ...state,
        error: undefined,
        status: terminalStatuses.has(state.status) ? state.status : "live",
      };
  }
}

export function reconstructDebuggerState(snapshot: DebuggerSnapshot): DebuggerState {
  return debuggerReducer(createDebuggerState(snapshot.runId), { type: "snapshot", snapshot });
}

export function eventIdentity(event: DebuggerEvent): string {
  return eventKey(event);
}

export function asDebuggerEvent(event: TraceEvent | DebuggerEvent): DebuggerEvent {
  return event as DebuggerEvent;
}
