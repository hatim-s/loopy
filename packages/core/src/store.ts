import type { Effect } from "effect";
import { Data } from "effect";
import type { StoreEffect } from "./effects";
import type { ExecutionKey, NodeRun } from "./graph";
import type { Json } from "./json";
import type { LogRecord, RunRecord, RuntimeEvent, Schedule, WaitRecord } from "./model";
import type { RateLimitResult } from "./rate-limit";

// Every page and snapshot list shares this cap, so a full list can be told from a truncated one.
export const PAGE_LIMIT = 200;

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: string;
  readonly reason: "unavailable" | "corrupt" | "rejected";
  readonly cause: unknown;
}> {
  override get message(): string {
    const detail =
      this.cause instanceof Error ? this.cause.message : "Inspect the cause before retrying.";

    return `Storage operation '${this.operation}' failed: ${detail}`;
  }
}

export class OwnershipError extends Data.TaggedError("OwnershipError")<{ readonly runId: string }> {
  constructor(runId: string) {
    super({ runId });
  }
  override get message(): string {
    return `Run '${this.runId}' is not owned by this token. Claim the run before writing.`;
  }
}

export type WakeError = "not_found" | "owned_elsewhere" | "not_claimable";

export type WaitResolution =
  | { kind: "resolved"; runId: string }
  | { kind: "rejected"; code: "unknown_hook" | "bad_request"; message: string };

export type ScheduleRef = Pick<Schedule, "workspace" | "slug" | "version">;

export type ScheduleFailure = Pick<Schedule, "workspace" | "slug"> & {
  error: string;
  retryAt: string | null;
};

export interface Store {
  getWaits(runId: string): Effect.Effect<WaitRecord[], StorageError>;
  resolveWait(options: {
    token: string;
    payload: Json;
    at: string;
  }): Effect.Effect<WaitResolution, StorageError>;
  wakeRun(runId: string, at: string): Effect.Effect<WakeError | undefined, StorageError>;
  oldestEventSequence(): Effect.Effect<number | undefined, StorageError>;
  transactionEvents(txn: string, after: number): Effect.Effect<RuntimeEvent[], StorageError>;
  events(after: number, limit: number): Effect.Effect<RuntimeEvent[], StorageError>;
  epoch(): Effect.Effect<string, StorageError>;
  eventCursor(): Effect.Effect<{ cursor: number; epoch: string }, StorageError>;
  pruneEvents(now: string): Effect.Effect<number, StorageError>;
  subscribe(listener: (events: RuntimeEvent[]) => void): () => void;
  acquireRateLimit(
    key: string,
    count: number,
    windowMs: number,
    now: string,
  ): Effect.Effect<RateLimitResult, StorageError>;
  readonly leaseMs: number;
  createRun(run: RunRecord): Effect.Effect<void, StorageError>;
  getRun(id: string): Effect.Effect<RunRecord | undefined, StorageError>;
  claim(runId: string, token: string): Effect.Effect<RunRecord, StorageError | OwnershipError>;
  heartbeat(runId: string, token: string): Effect.Effect<boolean, StorageError>;
  release(runId: string, token: string): Effect.Effect<void, StorageError | OwnershipError>;
  getNodeRun(key: ExecutionKey): Effect.Effect<NodeRun | undefined, StorageError>;
  getNodeRuns(runId: string): Effect.Effect<NodeRun[], StorageError>;
  apply(batch: {
    runId: string;
    token: string;
    effects: StoreEffect[];
  }): Effect.Effect<void, StorageError | OwnershipError>;
  getLogs(runId: string, after?: number, limit?: number): Effect.Effect<LogRecord[], StorageError>;
  dueRuns(now: string): Effect.Effect<RunRecord[], StorageError>;
  nextWakeAt(): Effect.Effect<string | undefined, StorageError>;
  nextScheduleAt(): Effect.Effect<string | undefined, StorageError>;
  putSchedule(schedule: Omit<Schedule, "version">): Effect.Effect<Schedule, StorageError>;
  setScheduleEnabled(
    options: Pick<Schedule, "workspace" | "slug" | "enabled"> & {
      nextFireAt?: string;
    },
  ): Effect.Effect<Schedule, StorageError>;
  listSchedules(): Effect.Effect<Schedule[], StorageError>;
  deleteSchedule(workspace: string, slug: string): Effect.Effect<void, StorageError>;
  dueSchedules(now: string, limit: number): Effect.Effect<Schedule[], StorageError>;
  /** Fences on the observed slot; the store derives the fire key from it. */
  fireSchedule(options: {
    schedule: ScheduleRef & Pick<Schedule, "nextFireAt">;
    next: string;
    run: RunRecord;
  }): Effect.Effect<boolean, StorageError>;
  /** A null retry disables the schedule; either way the error stays readable until it fires. */
  failSchedule(options: {
    schedule: ScheduleRef;
    error: string;
    retryAt: string | null;
  }): Effect.Effect<boolean, StorageError>;
  scheduleFailures(limit: number): Effect.Effect<ScheduleFailure[], StorageError>;
}

export type DurableTurn = {
  runId: string;
  cursor: string | null;
  owner: { token: string; heartbeatAt: string | null } | null;
};

/** Bounded activation turns of a durable host, with their persisted backoff deadlines. */
export interface DurableTurnStore {
  strandedTurns(now: string, limit: number): Effect.Effect<DurableTurn[], StorageError>;
  dueTurns(now: string, concurrency: number): Effect.Effect<DurableTurn[], StorageError>;
  saveTurn(turn: {
    runId: string;
    nextAt: string;
    cursor: string | null;
    error: string | null;
  }): Effect.Effect<void, StorageError>;
  nextTurnAt(concurrency: number): Effect.Effect<string | undefined, StorageError>;
  turnErrors(limit: number): Effect.Effect<{ runId: string; error: string }[], StorageError>;
}
