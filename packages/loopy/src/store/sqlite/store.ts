import type {
  LogRecord,
  NodeRun,
  RateLimit,
  RateLimitResult,
  RunRecord,
  RunSnapshot,
  RunStatus,
  RuntimeEvent,
  Schedule,
  Store,
  WakeError,
} from "../../core/index.js";
import { EventListeners } from "../event-outbox.js";
import type { StoreContext } from "./context.js";
import * as events from "./events.js";
import * as nodes from "./nodes.js";
import { openDatabase } from "./open.js";
import { acquireRateLimit } from "./rate-limits.js";
import * as runs from "./runs.js";
import * as schedules from "./schedules.js";

export class SqliteRunStore implements Store {
  private readonly context: StoreContext;
  constructor(file: string, now: () => number = Date.now, options: { leaseMs?: number } = {}) {
    this.context = {
      db: openDatabase(file),
      now,
      leaseMs: options.leaseMs ?? 60000,
      listeners: new EventListeners(),
    };
  }
  get leaseMs() {
    return this.context.leaseMs;
  }
  dataVersion(): number {
    return events.dataVersion(this.context);
  }
  oldestEventSequence(): number | undefined {
    return events.oldestEventSequence(this.context);
  }
  subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    return events.subscribe(this.context, listener);
  }
  events(after: number, limit: number): Promise<RuntimeEvent[]> {
    return events.events(this.context, after, limit);
  }
  transactionEvents(txn: string, after: number): Promise<RuntimeEvent[]> {
    return events.transactionEvents(this.context, txn, after);
  }
  epoch(): Promise<string> {
    return events.epoch(this.context);
  }
  eventCursor(): Promise<{ cursor: number; epoch: string }> {
    return events.eventCursor(this.context);
  }
  pruneEvents(now: string): Promise<number> {
    return events.pruneEvents(this.context, now);
  }
  close(): void {
    return events.close(this.context);
  }
  acquireRateLimit(rule: RateLimit, now: string): Promise<RateLimitResult> {
    return acquireRateLimit(this.context.db, rule, now);
  }
  createRun(run: RunRecord): Promise<void> {
    return runs.createRun(this.context, run);
  }
  getRun(id: string): Promise<RunRecord | undefined> {
    return runs.getRun(this.context, id);
  }
  listRuns(filter: { slug?: string; status?: RunStatus } = {}): Promise<RunRecord[]> {
    return runs.listRuns(this.context, filter);
  }
  claim(runId: string, token: string): Promise<RunRecord> {
    return runs.claim(this.context, runId, token);
  }
  wakeRun(id: string, at: string): Promise<WakeError | undefined> {
    return runs.wakeRun(this.context, id, at);
  }
  heartbeat(runId: string, token: string): Promise<boolean> {
    return runs.heartbeat(this.context, runId, token);
  }
  release(runId: string, token: string): Promise<void> {
    return runs.release(this.context, runId, token);
  }
  dueRuns(now: string): Promise<RunRecord[]> {
    return runs.dueRuns(this.context, now);
  }
  nextWakeAt(): Promise<string | undefined> {
    return runs.nextWakeAt(this.context);
  }
  getNodeRuns(runId: string): Promise<NodeRun[]> {
    return nodes.getNodeRuns(this.context, runId);
  }
  apply(batch: Parameters<Store["apply"]>[0]): Promise<void> {
    return nodes.apply(this.context, batch);
  }
  getLogs(runId: string, after = 0): Promise<LogRecord[]> {
    return nodes.getLogs(this.context, runId, after);
  }
  snapshotRun(id: string): Promise<RunSnapshot | undefined> {
    return nodes.snapshotRun(this.context, id);
  }
  putSchedule(schedule: Omit<Schedule, "version">): Promise<Schedule> {
    return schedules.putSchedule(this.context, schedule);
  }
  setScheduleEnabled({
    workspace,
    slug,
    enabled,
    nextFireAt,
  }: Parameters<Store["setScheduleEnabled"]>[0]): Promise<Schedule> {
    return schedules.setScheduleEnabled(this.context, {
      workspace,
      slug,
      enabled,
      nextFireAt,
    });
  }
  advanceSchedule(options: Parameters<Store["advanceSchedule"]>[0]): Promise<boolean> {
    return schedules.advanceSchedule(this.context, options);
  }
  listSchedules(): Promise<Schedule[]> {
    return schedules.listSchedules(this.context);
  }
  deleteSchedule(workspace: string, slug: string): Promise<void> {
    return schedules.deleteSchedule(this.context, workspace, slug);
  }
  fireSchedule(options: Parameters<Store["fireSchedule"]>[0]): Promise<boolean> {
    return schedules.fireSchedule(this.context, options);
  }
}
