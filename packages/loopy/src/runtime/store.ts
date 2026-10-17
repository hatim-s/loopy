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
  StepRecord,
  WaitingHookStep,
} from "../core/index.js";

import type { RateLimitResult } from "./rate-limit.js";

export class OwnershipError extends Error {
  constructor(runId: string) {
    super(`Run '${runId}' is not owned by this token. Claim the run before writing.`);
    this.name = "OwnershipError";
  }
}

export interface RunStore {
  oldestEventSequence(): number | undefined;
  events(after: number, limit: number): Promise<RuntimeEvent[]>;
  epoch(): Promise<string>;
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
  createHook(runId: string, token: string, step: WaitingHookStep): Promise<void>;
  resolveHook(token: string, payload: Json): Promise<boolean>;
  listHooks(runId: string): Promise<HookRecord[]>;
  listPendingHooks(runId: string, seqs: number[]): Promise<HookRecord[]>;
  // Expiry fences signals while the owner queues its terminal step write.
  expireHook(runId: string, token: string, seq: number): Promise<string | undefined>;
  createRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(filter?: { slug?: string; status?: RunStatus }): Promise<RunRecord[]>;
  claim(runId: string, token: string): Promise<RunRecord>;
  heartbeat(runId: string, token: string): Promise<boolean>;
  suspend(runId: string, token: string, wakeAt?: string): Promise<void>;
  finishRun(runId: string, token: string, outcome: RunOutcome): Promise<void>;
  release(runId: string, token: string): Promise<void>;
  getSteps(runId: string): Promise<StepRecord[]>;
  putStep(runId: string, token: string, step: StepRecord): Promise<void>;
  appendLog(runId: string, token: string, log: LogRecord): Promise<void>;
  getLogs(runId: string, after?: number): Promise<LogRecord[]>;
  dueRuns(now: string): Promise<RunRecord[]>;
  nextWakeAt(): Promise<string | undefined>;
  putSchedule(schedule: Schedule): Promise<void>;
  listSchedules(): Promise<Schedule[]>;
  deleteSchedule(workspace: string, slug: string): Promise<void>;
  fireSchedule(
    workspace: string,
    slug: string,
    fireKey: string,
    run: RunRecord,
    nextFireAt: string,
  ): Promise<boolean>;
}
