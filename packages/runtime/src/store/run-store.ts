import type {
  DashboardReader,
  EventPageQuery,
  LogPageQuery,
  NodePageQuery,
  OverviewQuery,
  RunPageQuery,
  ScopeItemsQuery,
} from "@loopy/contract";
import {
  type DurableTurnStore,
  type ExecutionKey,
  executionKeyString,
  type Json,
  PAGE_LIMIT,
  type RunRecord,
  type RuntimeEvent,
  type Schedule,
  type Store,
  type StoreEffect,
} from "@loopy/core";
import { Clock, Effect } from "effect";
import { applyBatch } from "./apply";
import type { SqlContext, SqlWrite } from "./context";
import type { SqlDriver } from "./driver";
import { EventListeners } from "./event-outbox";
import {
  pruneEvents,
  readEpoch,
  readEvent,
  readEventCursor,
  readEvents,
  readOldestEventSequence,
  readTransactionEvents,
} from "./events";
import { readLog, readLogs, readNode, readNodes } from "./nodes";
import { ownedStorageOperation, storageOperation } from "./operation";
import type { SqlStoreOptions } from "./owner-policy";
import { readEventPage, readLogPage } from "./query/feeds";
import {
  readDashboardSnapshot,
  readExecution,
  readNodePage,
  readScopeCounts,
  readScopeItems,
} from "./query/nodes";
import {
  queryRuns,
  readOverview,
  readPendingHooks,
  readRunCountsByDefinition,
  readRunningCount,
  readRunReference,
  readRunWorkspaces,
} from "./query/runs";
import { acquireRateLimit } from "./rate-limits";
import { rowToRun } from "./rows";
import {
  claimRun,
  heartbeatRun,
  insertRun,
  readDueRuns,
  readNextWakeAt,
  readRun,
  releaseRun,
  wakeRun,
} from "./runs";
import {
  deleteSchedule,
  failSchedule,
  fireSchedule,
  putSchedule,
  readDueSchedules,
  readNextScheduleAt,
  readScheduleFailures,
  readScheduleOverview,
  readSchedules,
  setScheduleEnabled,
  skipSchedule,
} from "./schedules";
import { initializeSchema } from "./schema/fresh";
import { utc } from "./timestamps";
import { readDueTurns, readNextTurnAt, readStrandedTurns, readTurnErrors, saveTurn } from "./turns";
import { readWaits, resolveWait } from "./waits";

const DEFAULT_LEASE_MS = 60_000;

/** The caller owns the connection, including Durable Object eviction and disposal. */
export class SqlRunStore implements Store, DurableTurnStore, DashboardReader {
  readonly leaseMs: number;
  private readonly ctx: SqlContext;
  private readonly listeners = new EventListeners();

  constructor(db: SqlDriver, options: SqlStoreOptions) {
    initializeSchema(db);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.ctx = { db, owner: options.owner, leaseMs: this.leaseMs };
  }

  private query<A>(operation: string, body: (ctx: SqlContext) => A) {
    return storageOperation(operation, () => body(this.ctx));
  }

  private snapshot<A>(operation: string, body: (ctx: SqlContext) => A) {
    return storageOperation(operation, () =>
      this.ctx.db.transaction(() => body(this.ctx), "deferred"),
    );
  }

  private commit<A>(now: number, body: (write: SqlWrite) => A): A {
    const write: SqlWrite = {
      ...this.ctx,
      txn: crypto.randomUUID(),
      now,
      at: utc(now),
      events: [],
    };

    const result = this.ctx.db.transaction(() => body(write), "immediate");

    this.listeners.publish(write.events);

    return result;
  }

  private write<A>(operation: string, body: (write: SqlWrite) => A) {
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      storageOperation(operation, () => this.commit(now, body)),
    );
  }

  private ownedWrite<A>(operation: string, body: (write: SqlWrite) => A) {
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      ownedStorageOperation(operation, () => this.commit(now, body)),
    );
  }

  subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    return this.listeners.subscribe(listener);
  }

  close() {
    return storageOperation("close", () => this.ctx.db.close?.());
  }

  oldestEventSequence() {
    return this.query("oldestEventSequence", readOldestEventSequence);
  }

  events(after: number, limit: number) {
    return this.query("events", (ctx) => readEvents(ctx, after, limit));
  }

  transactionEvents(txn: string, after: number) {
    return this.query("transactionEvents", (ctx) => readTransactionEvents(ctx, txn, after));
  }

  epoch() {
    return this.query("epoch", readEpoch);
  }

  eventCursor() {
    return this.snapshot("eventCursor", readEventCursor);
  }

  pruneEvents(now: string) {
    return this.query("pruneEvents", (ctx) => pruneEvents(ctx, now));
  }

  acquireRateLimit(key: string, count: number, windowMs: number, now: string) {
    return this.write("acquireRateLimit", (write) =>
      acquireRateLimit(write, { key, count, windowMs, now }),
    );
  }

  createRun(run: RunRecord) {
    return this.write("createRun", (write) => insertRun(write, run));
  }

  getRun(id: string) {
    return this.query("getRun", (ctx) => {
      const row = readRun(ctx, id);

      return row ? rowToRun(row) : undefined;
    });
  }

  claim(runId: string, token: string) {
    return this.ownedWrite("claim", (write) => claimRun(write, runId, token));
  }

  wakeRun(runId: string, at: string) {
    return this.write("wakeRun", (write) => wakeRun(write, runId, at));
  }

  heartbeat(runId: string, token: string) {
    return this.write("heartbeat", (write) => heartbeatRun(write, runId, token));
  }

  release(runId: string, token: string) {
    return this.ownedWrite("release", (write) => releaseRun(write, runId, token));
  }

  dueRuns(now: string) {
    return this.query("dueRuns", (ctx) => readDueRuns(ctx, now));
  }

  nextWakeAt() {
    return this.query("nextWakeAt", readNextWakeAt);
  }

  getNodeRun(key: ExecutionKey) {
    return this.query("getNodeRun", (ctx) => readNode(ctx, key.runId, executionKeyString(key)));
  }

  getNodeRuns(runId: string) {
    return this.query("getNodeRuns", (ctx) => readNodes(ctx, runId));
  }

  apply(batch: { runId: string; token: string; effects: StoreEffect[] }) {
    return this.ownedWrite("apply", (write) => applyBatch(write, batch));
  }

  getLogs(runId: string, after = 0, limit = PAGE_LIMIT) {
    return this.query("getLogs", (ctx) => readLogs(ctx, runId, after, limit));
  }

  getWaits(runId: string) {
    return this.query("getWaits", (ctx) => readWaits(ctx, runId));
  }

  resolveWait(options: { token: string; payload: Json; at: string }) {
    return this.write("resolveWait", (write) => resolveWait(write, options));
  }

  putSchedule(schedule: Omit<Schedule, "version">) {
    return this.write("putSchedule", (write) => putSchedule(write, schedule));
  }

  setScheduleEnabled(options: Parameters<Store["setScheduleEnabled"]>[0]) {
    return this.write("setScheduleEnabled", (write) => setScheduleEnabled(write, options));
  }

  listSchedules() {
    return this.query("listSchedules", readSchedules);
  }

  nextScheduleAt() {
    return this.query("nextScheduleAt", readNextScheduleAt);
  }

  deleteSchedule(workspace: string, slug: string) {
    return this.write("deleteSchedule", (write) => deleteSchedule(write, { workspace, slug }));
  }

  dueSchedules(now: string, limit: number) {
    return this.query("dueSchedules", (ctx) => readDueSchedules(ctx, now, limit));
  }

  fireSchedule(options: Parameters<Store["fireSchedule"]>[0]) {
    return this.write("fireSchedule", (write) => fireSchedule(write, options));
  }

  skipSchedule(options: Parameters<Store["skipSchedule"]>[0]) {
    return this.write("skipSchedule", (write) => skipSchedule(write, options));
  }

  failSchedule(options: Parameters<Store["failSchedule"]>[0]) {
    return this.write("failSchedule", (write) => failSchedule(write, options));
  }

  scheduleFailures(limit: number) {
    return this.query("scheduleFailures", (ctx) => readScheduleFailures(ctx, limit));
  }

  strandedTurns(now: string, limit: number) {
    return this.query("strandedTurns", (ctx) => readStrandedTurns(ctx, now, limit));
  }

  dueTurns(now: string, concurrency: number) {
    return this.snapshot("dueTurns", (ctx) => readDueTurns(ctx, now, concurrency));
  }

  saveTurn(turn: Parameters<DurableTurnStore["saveTurn"]>[0]) {
    return this.write("saveTurn", (write) => saveTurn(write, turn));
  }

  nextTurnAt(concurrency: number) {
    return this.query("nextTurnAt", (ctx) => readNextTurnAt(ctx, concurrency));
  }

  turnErrors(limit: number) {
    return this.query("turnErrors", (ctx) => readTurnErrors(ctx, limit));
  }

  scheduleOverview() {
    return this.snapshot("scheduleOverview", readScheduleOverview);
  }

  dashboardSnapshot(id: string) {
    return this.snapshot("dashboardSnapshot", (ctx) => readDashboardSnapshot(ctx, id));
  }

  runReference(id: string) {
    return this.query("runReference", (ctx) => readRunReference(ctx, id));
  }

  runningCount() {
    return this.query("runningCount", readRunningCount);
  }

  queryRuns(query: RunPageQuery) {
    return this.query("queryRuns", (ctx) => queryRuns(ctx, query));
  }

  runCountsByDefinition() {
    return this.query("runCountsByDefinition", readRunCountsByDefinition);
  }

  runWorkspaces() {
    return this.query("runWorkspaces", readRunWorkspaces);
  }

  pendingHooks(ids: string[], now: string) {
    return this.query("pendingHooks", (ctx) => readPendingHooks(ctx, ids, now));
  }

  overview(query: OverviewQuery) {
    return this.query("overview", (ctx) => readOverview(ctx, query));
  }

  nodePage(runId: string, query: NodePageQuery) {
    return this.query("nodePage", (ctx) => readNodePage(ctx, runId, query));
  }

  scopeCounts(runId: string, parentScope: string) {
    return this.query("scopeCounts", (ctx) => readScopeCounts(ctx, runId, parentScope));
  }

  scopeItems(runId: string, query: ScopeItemsQuery) {
    return this.query("scopeItems", (ctx) => readScopeItems(ctx, runId, query));
  }

  execution(runId: string, key: string, after = 0) {
    return this.query("execution", (ctx) => readExecution(ctx, runId, key, after));
  }

  logPage(query: LogPageQuery) {
    return this.query("logPage", (ctx) => readLogPage(ctx, query));
  }

  logDetail(id: number) {
    return this.query("logDetail", (ctx) => readLog(ctx, id));
  }

  eventPage(query: EventPageQuery) {
    return this.query("eventPage", (ctx) => readEventPage(ctx, query));
  }

  eventDetail(sequence: number) {
    return this.query("eventDetail", (ctx) => readEvent(ctx, sequence));
  }
}
