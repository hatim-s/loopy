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

export class OwnershipError extends Error {
  constructor(runId: string) {
    super(`Run '${runId}' is not owned by this token. Claim the run before writing.`);
    this.name = "OwnershipError";
  }
}

export type WakeError = "not_found" | "owned_elsewhere" | "not_claimable";

export type WaitRecord = HookRecord & { executionKey: ExecutionKey; schema: OutSchema };

export type WaitResolution =
  | { kind: "resolved"; runId: string }
  | { kind: "rejected"; code: "unknown_hook" | "bad_request"; message: string };

export interface Store extends DashboardReader {
  getWaits(runId: string): Promise<WaitRecord[]>;
  getWait(token: string): Promise<WaitRecord | undefined>;
  resolveWait(options: { token: string; payload: Json; at: string }): Promise<WaitResolution>;
  wakeRun(runId: string, at: string): Promise<WakeError | undefined>;
  oldestEventSequence(): number | undefined;
  events(after: number, limit: number): Promise<RuntimeEvent[]>;
  epoch(): Promise<string>;
  eventCursor(): Promise<{ cursor: number; epoch: string }>;
  snapshotRun(id: string): Promise<RunSnapshot | undefined>;
  pruneEvents(now: string): Promise<number>;
  subscribe(listener: (events: RuntimeEvent[]) => void): () => void;
  acquireRateLimit(
    key: string,
    count: number,
    windowMs: number,
    now: string,
  ): Promise<RateLimitResult>;
  readonly leaseMs: number;
  createRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(filter?: { slug?: string; status?: RunStatus }): Promise<RunRecord[]>;
  claim(runId: string, token: string): Promise<RunRecord>;
  heartbeat(runId: string, token: string): Promise<boolean>;
  suspend(runId: string, token: string, wakeAt?: string): Promise<void>;
  finishRun(runId: string, token: string, outcome: RunOutcome): Promise<void>;
  release(runId: string, token: string): Promise<void>;
  getNodeRuns(runId: string): Promise<NodeRun[]>;
  apply(batch: { runId: string; token: string; effects: StoreEffect[] }): Promise<void>;
  getLogs(runId: string, after?: number, limit?: number): Promise<LogRecord[]>;
  dueRuns(now: string): Promise<RunRecord[]>;
  nextWakeAt(): Promise<string | undefined>;
  putSchedule(schedule: Omit<Schedule, "version">): Promise<Schedule>;
  setScheduleEnabled(
    options: Pick<Schedule, "workspace" | "slug" | "enabled"> & {
      nextFireAt?: string;
    },
  ): Promise<Schedule>;
  advanceSchedule(
    options: Pick<Schedule, "workspace" | "slug" | "version" | "nextFireAt">,
  ): Promise<boolean>;
  listSchedules(): Promise<Schedule[]>;
  deleteSchedule(workspace: string, slug: string): Promise<void>;
  fireSchedule(
    options: Pick<Schedule, "workspace" | "slug" | "version" | "nextFireAt"> & {
      fireKey: string;
      run: RunRecord;
    },
  ): Promise<boolean>;
}
