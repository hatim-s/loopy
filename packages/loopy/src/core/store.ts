import type { Effect } from "effect";
import { Context, Data } from "effect";
import type { StoreEffect } from "./effects.js";
import type { ExecutionKey, NodeRun, OutSchema } from "./graph.js";
import type {
  HookRecord,
  Json,
  LogRecord,
  RunOutcome,
  RunRecord,
  RunSnapshot,
  RunStatus,
  RuntimeEvent,
  Schedule,
} from "./model.js";
import type { DashboardReader } from "./queries.js";
import type { RateLimitResult } from "./rate-limit.js";

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

export type WaitRecord = HookRecord & { executionKey: ExecutionKey; schema: OutSchema };

export type WaitResolution =
  | { kind: "resolved"; runId: string }
  | { kind: "rejected"; code: "unknown_hook" | "bad_request"; message: string };

export interface Store extends DashboardReader {
  getWaits(runId: string): Effect.Effect<WaitRecord[], StorageError>;
  getWait(token: string): Effect.Effect<WaitRecord | undefined, StorageError>;
  resolveWait(options: {
    token: string;
    payload: Json;
    at: string;
  }): Effect.Effect<WaitResolution, StorageError>;
  wakeRun(runId: string, at: string): Effect.Effect<WakeError | undefined, StorageError>;
  oldestEventSequence(): Effect.Effect<number | undefined, StorageError>;
  transactionEvents(txn: string, after: number): Effect.Effect<RuntimeEvent[], StorageError>;
  dataVersion?(): Effect.Effect<number, StorageError>;
  events(after: number, limit: number): Effect.Effect<RuntimeEvent[], StorageError>;
  epoch(): Effect.Effect<string, StorageError>;
  eventCursor(): Effect.Effect<{ cursor: number; epoch: string }, StorageError>;
  snapshotRun(id: string): Effect.Effect<RunSnapshot | undefined, StorageError>;
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
  listRuns(filter?: {
    slug?: string;
    status?: RunStatus;
  }): Effect.Effect<RunRecord[], StorageError>;
  claim(runId: string, token: string): Effect.Effect<RunRecord, StorageError | OwnershipError>;
  heartbeat(runId: string, token: string): Effect.Effect<boolean, StorageError>;
  suspend(
    runId: string,
    token: string,
    wakeAt?: string,
  ): Effect.Effect<void, StorageError | OwnershipError>;
  finishRun(
    runId: string,
    token: string,
    outcome: RunOutcome,
  ): Effect.Effect<void, StorageError | OwnershipError>;
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
  putSchedule(schedule: Omit<Schedule, "version">): Effect.Effect<Schedule, StorageError>;
  setScheduleEnabled(
    options: Pick<Schedule, "workspace" | "slug" | "enabled"> & {
      nextFireAt?: string;
    },
  ): Effect.Effect<Schedule, StorageError>;
  advanceSchedule(
    options: Pick<Schedule, "workspace" | "slug" | "version" | "nextFireAt">,
  ): Effect.Effect<boolean, StorageError>;
  listSchedules(): Effect.Effect<Schedule[], StorageError>;
  deleteSchedule(workspace: string, slug: string): Effect.Effect<void, StorageError>;
  fireSchedule(
    options: Pick<Schedule, "workspace" | "slug" | "version" | "nextFireAt"> & {
      fireKey: string;
      run: RunRecord;
    },
  ): Effect.Effect<boolean, StorageError>;
}

export class StoreService extends Context.Service<StoreService, Store>()("loopy/Store") {}
