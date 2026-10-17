import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type {
  HookRecord,
  Json,
  LogRecord,
  RunOutcome,
  RunRecord,
  RunSnapshot,
  RunStatus,
  RuntimeEvent,
  RuntimeEventChange,
  Schedule,
  StepRecord,
  WaitingHookStep,
} from "../core/index.js";
import {
  acquireWindow,
  canResolveHook,
  earliestWake,
  OwnershipError,
  type RateLimitResult,
  type RateLimitWindow,
  type RunStore,
} from "../runtime/index.js";
import { errnoCode } from "./fs.js";
import {
  rowToEvent,
  rowToHook,
  rowToLog,
  rowToRun,
  rowToSchedule,
  rowToStep,
  SQL,
  stepToRow,
} from "./store-rows.js";
import {
  type EventRow,
  type HookRow,
  type LogRow,
  type RunRow,
  SCHEMA,
  SCHEMA_VERSION,
  type ScheduleRow,
  type StepRow,
} from "./store-schema.js";

type EventTransaction = { id: string; events: RuntimeEvent[] };

export class SqliteRunStore implements RunStore {
  private readonly db: Database;

  get leaseMs(): number {
    return this.options.leaseMs ?? 60_000;
  }

  constructor(
    file: string,
    private readonly now: () => number = Date.now,
    private readonly options: { leaseMs?: number } = {},
  ) {
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    this.db
      .transaction(() => {
        const version = this.db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version;

        if (version === SCHEMA_VERSION) {
          return;
        }

        const tables = this.db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();

        // Defer foreign keys until every old table has been dropped.
        this.db.exec("PRAGMA defer_foreign_keys=ON");

        for (const table of tables) {
          this.db.exec(`DROP TABLE "${table.name.replaceAll('"', '""')}"`);
        }

        this.db.exec(SCHEMA);
        this.db.query(SQL.createEpoch).run(crypto.randomUUID());
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      })
      .immediate();
  }

  async createHook(runId: string, token: string, step: WaitingHookStep): Promise<void> {
    this.commit((txn) => {
      this.requireRunning(this.owned(runId, token));

      if (
        this.db.query(SQL.hook).get(step.input.token) ||
        this.db.query(SQL.step).get(runId, step.seq)
      ) {
        throw new Error("Hook already exists. Resume the run to use its waiting hook.");
      }

      this.writeStep({ ...step, runId });
      this.db
        .query(SQL.createHook)
        .run(step.input.token, runId, step.seq, step.input.name, step.startedAt);
      this.emitStep(txn, runId, step.seq);
      this.emitHook(txn, step.input.token, "created");
    });
  }

  async resolveHook(token: string, payload: Json): Promise<boolean> {
    return this.commit((txn) => {
      const hook = this.db.query<HookRow, [string]>(SQL.hook).get(token);

      const row = hook
        ? this.db.query<StepRow, [string, number]>(SQL.step).get(hook.run_id, hook.seq)
        : undefined;

      const run = hook ? this.row(hook.run_id) : undefined;

      if (
        !hook ||
        hook.resolved_at !== null ||
        hook.expired_at !== null ||
        !row ||
        !run ||
        !canResolveHook(rowToRun(run), rowToStep(row), this.now())
      ) {
        return false;
      }

      const timestamp = this.timestamp();
      this.db.query(SQL.resolveHook).run(JSON.stringify(payload), timestamp, token);
      this.db.query(SQL.wakeHook).run(timestamp, timestamp, hook.run_id);
      this.emitHook(txn, token, "resolved");
      this.emitRun(txn, hook.run_id, "woken");

      return true;
    });
  }

  async listHooks(runId: string): Promise<HookRecord[]> {
    return this.db.query<HookRow, [string]>(SQL.hooks).all(runId).map(rowToHook);
  }

  async listPendingHooks(runId: string, seqs: number[]): Promise<HookRecord[]> {
    if (seqs.length === 0) {
      return [];
    }

    return this.db
      .query<HookRow, [string, ...number[]]>(SQL.pendingHooks(seqs.length))
      .all(runId, ...seqs)
      .map(rowToHook);
  }

  async expireHook(runId: string, token: string, seq: number): Promise<string | undefined> {
    return this.commit((txn) => {
      this.requireRunning(this.owned(runId, token));

      const hook = this.db.query<HookRow, [string, number]>(SQL.hookStep).get(runId, seq);

      const step = this.db.query<StepRow, [string, number]>(SQL.step).get(runId, seq);

      if (
        !hook ||
        hook.resolved_at !== null ||
        hook.expired_at !== null ||
        step?.status !== "waiting" ||
        step.wake_at === null ||
        Date.parse(step.wake_at) > this.now()
      ) {
        return undefined;
      }

      this.db.query(SQL.expireHook).run(this.timestamp(), runId, seq);
      this.emitHook(txn, hook.token, "expired");

      return step.wake_at;
    });
  }

  async acquireRateLimit(
    key: string,
    count: number,
    windowMs: number,
    now: string,
  ): Promise<RateLimitResult> {
    return this.db
      .transaction(() => {
        const window =
          this.db.query<RateLimitWindow, [string]>(SQL.rateLimit).get(key) ?? undefined;

        const acquired = acquireWindow(window, count, windowMs, now);
        this.db
          .query(SQL.putRateLimit)
          .run(key, acquired.window.windowStart, acquired.window.count);

        return acquired.result;
      })
      .immediate();
  }

  async createRun(run: RunRecord): Promise<void> {
    this.commit((txn) => {
      if (this.row(run.id)) {
        throw new Error(`Run '${run.id}' already exists. Use a new run ID.`);
      }

      this.insertRun(run);
      this.emitRun(txn, run.id, "created");
    });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const row = this.row(id);

    return row ? rowToRun(row) : undefined;
  }

  async listRuns(filter: { slug?: string; status?: RunStatus } = {}): Promise<RunRecord[]> {
    if (filter.slug !== undefined && filter.status !== undefined) {
      return this.db
        .query<RunRow, [string, RunStatus]>(SQL.listRunsBySlugAndStatus)
        .all(filter.slug, filter.status)
        .map(rowToRun);
    }

    if (filter.slug !== undefined) {
      return this.db.query<RunRow, [string]>(SQL.listRunsBySlug).all(filter.slug).map(rowToRun);
    }

    if (filter.status !== undefined) {
      return this.db
        .query<RunRow, [RunStatus]>(SQL.listRunsByStatus)
        .all(filter.status)
        .map(rowToRun);
    }

    return this.db.query<RunRow, []>(SQL.listRuns).all().map(rowToRun);
  }

  async claim(runId: string, token: string): Promise<RunRecord> {
    return this.commit((txn) => {
      const timestamp = this.timestamp();

      const previous = this.requireRow(runId);

      if (this.stale(previous, this.now())) {
        this.recoverRun(txn, previous, timestamp);
      }

      const result = this.db
        .query(SQL.claim)
        .run(token, process.pid, hostname(), timestamp, timestamp, runId);

      if (result.changes !== 1) {
        const row = this.requireRow(runId);

        if (row.owner_token !== null) {
          throw new OwnershipError(runId);
        }

        throw new Error(
          `Run '${runId}' cannot be claimed in status '${row.status}'. Activate a queued or suspended run.`,
        );
      }

      this.emitRun(txn, runId, "claimed");

      return rowToRun(this.requireRow(runId));
    });
  }

  private recoverRun(txn: EventTransaction, previous: RunRow, timestamp: string): void {
    const runId = previous.id;
    const running = this.db.query<StepRow, [string]>(SQL.runningSteps).all(runId);
    this.db.query(SQL.recoverSteps).run(timestamp, timestamp, runId);

    for (const step of running) {
      this.emitStep(txn, runId, step.seq);
    }

    this.db.query(SQL.release).run(timestamp, timestamp, runId, previous.owner_token);
    this.emitRun(txn, runId, "released");
  }

  async heartbeat(runId: string, token: string): Promise<boolean> {
    return this.commit((txn) => {
      this.requireRow(runId);
      const timestamp = this.timestamp();

      const changed =
        this.db.query(SQL.heartbeat).run(timestamp, timestamp, runId, token).changes === 1;

      if (changed) {
        this.emitRun(txn, runId, "heartbeat");
      }

      return changed;
    });
  }

  async suspend(runId: string, token: string, wakeAt?: string): Promise<void> {
    this.commit((txn) => {
      const run = this.owned(runId, token);
      this.requireRunning(run);

      const resolved =
        this.db.query<{ wake_at: string | null }, [string]>(SQL.unconsumedHook).get(runId)
          ?.wake_at ?? undefined;

      const wake = earliestWake(resolved, wakeAt);
      this.db
        .query(SQL.suspend)
        .run(
          wake === undefined ? null : new Date(wake).toISOString(),
          this.timestamp(),
          runId,
          token,
        );
      this.emitRun(txn, runId, "suspended");
    });
  }

  async finishRun(runId: string, token: string, outcome: RunOutcome): Promise<void> {
    this.commit((txn) => {
      this.requireRunning(this.owned(runId, token));
      this.db
        .query(SQL.finish)
        .run(
          outcome.status,
          outcome.status === "succeeded" ? JSON.stringify(outcome.output) : null,
          outcome.status === "failed" ? outcome.error : null,
          this.timestamp(),
          runId,
          token,
        );
      this.emitRun(txn, runId, "finished");
    });
  }

  async release(runId: string, token: string): Promise<void> {
    this.commit((txn) => {
      const previous = this.owned(runId, token);
      const timestamp = this.timestamp();
      this.db.query(SQL.release).run(timestamp, timestamp, runId, token);
      this.emitRun(txn, runId, "released");

      if (previous.status === "running") {
        this.emitRun(txn, runId, "suspended");
      }
    });
  }

  async getSteps(runId: string): Promise<StepRecord[]> {
    return this.db.query<StepRow, [string]>(SQL.steps).all(runId).map(rowToStep);
  }

  async putStep(runId: string, token: string, step: StepRecord): Promise<void> {
    this.commit((txn) => {
      this.owned(runId, token);
      const previous = this.db.query<StepRow, [string, number]>(SQL.step).get(runId, step.seq);
      const next = stepToRow({ ...step, runId });

      if (previous && JSON.stringify(rowToStep(previous)) === JSON.stringify(rowToStep(next))) {
        return;
      }

      this.writeStep({ ...step, runId });
      this.emitStep(txn, runId, step.seq);
    });
  }

  private writeStep(step: StepRecord): void {
    const row = stepToRow(step);

    this.db
      .query(SQL.putStep)
      .run(
        row.run_id,
        row.seq,
        row.key,
        row.kind,
        row.input_json,
        row.attempt,
        row.max_attempts,
        row.started_at,
        row.status,
        row.output_json,
        row.error,
        row.next_retry_at,
        row.wake_at,
        row.finish_order,
        row.ended_at,
      );
  }

  async appendLog(runId: string, token: string, log: LogRecord): Promise<void> {
    this.commit((txn) => {
      this.owned(runId, token);

      try {
        this.db
          .query(SQL.appendLog)
          .run(
            runId,
            log.seq,
            log.position.kind,
            log.position.kind === "workflow" ? log.position.afterStep : null,
            log.position.kind === "workflow" ? log.position.afterFinish : null,
            log.position.kind === "step" ? log.position.seq : null,
            log.position.kind === "step" ? log.position.attempt : null,
            log.position.index,
            log.level,
            log.message,
            log.data === undefined ? null : JSON.stringify(log.data),
            new Date(log.at).toISOString(),
          );
      } catch (error) {
        if (this.db.query(SQL.logExists).get(runId, log.seq)) {
          throw new Error(`Log sequence ${log.seq} already exists. Append a new sequence number.`);
        }

        throw error;
      }

      const row = this.db.query<LogRow, [string, number]>(SQL.log).get(runId, log.seq);

      if (!row) {
        throw new Error("Log disappeared before commit. Restore storage.");
      }

      this.emit(txn, { entity: "log", kind: "written", runId, record: rowToLog(row) });
    });
  }

  async getLogs(runId: string, after = 0): Promise<LogRecord[]> {
    return this.db.query<LogRow, [string, number]>(SQL.logs).all(runId, after).map(rowToLog);
  }

  async dueRuns(now: string): Promise<RunRecord[]> {
    return this.db
      .query<RunRow, [string]>(SQL.dueRuns)
      .all(new Date(now).toISOString())
      .filter((row) => row.owner_token === null || this.stale(row, Date.parse(now)))
      .map(rowToRun);
  }

  async nextWakeAt(): Promise<string | undefined> {
    return (
      this.db.query<{ wake_at: string | null }, []>(SQL.nextWakeAt).get()?.wake_at ?? undefined
    );
  }

  async putSchedule(schedule: Schedule): Promise<void> {
    this.commit((txn) => {
      this.db
        .query(SQL.putSchedule)
        .run(
          schedule.workspace,
          schedule.slug,
          schedule.cron,
          schedule.tz,
          JSON.stringify(schedule.input),
          Number(schedule.enabled),
          schedule.lastFireKey ?? null,
          new Date(schedule.nextFireAt).toISOString(),
        );
      this.emitSchedule(txn, schedule, "saved");
    });
  }

  async listSchedules(): Promise<Schedule[]> {
    return this.db.query<ScheduleRow, []>(SQL.schedules).all().map(rowToSchedule);
  }

  async deleteSchedule(workspace: string, slug: string): Promise<void> {
    this.commit((txn) => {
      const row = this.db.query<ScheduleRow, [string, string]>(SQL.schedule).get(workspace, slug);

      if (this.db.query(SQL.deleteSchedule).run(workspace, slug).changes && row) {
        const record = rowToSchedule(row);
        this.emit(txn, {
          entity: "schedule",
          kind: "deleted",
          runId: null,
          record: { workspace: record.workspace, slug: record.slug },
        });
      }
    });
  }

  async fireSchedule(
    workspace: string,
    slug: string,
    fireKey: string,
    run: RunRecord,
    nextFireAt: string,
  ): Promise<boolean> {
    return this.commit((txn) => {
      const schedule = this.db
        .query<ScheduleRow, [string, string]>(SQL.schedule)
        .get(workspace, slug);

      if (!schedule) {
        throw new Error(`Schedule '${slug}' does not exist. Save the schedule before firing it.`);
      }

      if (schedule.last_fire_key === fireKey) {
        return false;
      }

      if (this.row(run.id)) {
        throw new Error(`Run '${run.id}' already exists. Use a new run ID.`);
      }

      this.insertRun(run);
      this.emitRun(txn, run.id, "created");
      this.db
        .query(SQL.fireSchedule)
        .run(fireKey, new Date(nextFireAt).toISOString(), workspace, slug);
      this.emitSchedule(txn, schedule, "fired");

      return true;
    });
  }

  private readonly listeners = new Set<(events: RuntimeEvent[]) => void>();

  subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async events(after: number, limit: number): Promise<RuntimeEvent[]> {
    return this.db.query<EventRow, [number, number]>(SQL.events).all(after, limit).map(rowToEvent);
  }

  async epoch(): Promise<string> {
    return this.readEpoch();
  }

  private readEpoch(): string {
    const row = this.db.query<{ value: string }, []>(SQL.epoch).get();

    if (!row) {
      throw new Error("Store epoch is missing. Recreate the database.");
    }

    return row.value;
  }

  async snapshotRun(id: string): Promise<RunSnapshot | undefined> {
    return this.db
      .transaction(() => {
        const row = this.row(id);

        if (!row) {
          return undefined;
        }

        return {
          run: rowToRun(row),
          steps: this.db.query<StepRow, [string]>(SQL.steps).all(id).map(rowToStep),
          logs: this.db.query<LogRow, [string, number]>(SQL.logs).all(id, 0).map(rowToLog),
          hooks: this.db.query<HookRow, [string]>(SQL.hooks).all(id).map(rowToHook),
          cursor: this.db.query<{ cursor: number }, []>(SQL.cursor).get()?.cursor ?? 0,
          epoch: this.readEpoch(),
        };
      })
      .deferred();
  }

  async pruneEvents(now: string): Promise<number> {
    const cutoff = new Date(Date.parse(now) - 86_400_000).toISOString();

    return this.db.query(SQL.pruneEvents).run(cutoff).changes;
  }

  private commit<T>(change: (txn: EventTransaction) => T): T {
    const txn: EventTransaction = { id: crypto.randomUUID(), events: [] };
    const result = this.db.transaction(() => change(txn)).immediate();

    if (txn.events.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(txn.events));
        } catch {
          continue;
        }
      }
    }

    return result;
  }

  private emit(txn: EventTransaction, change: RuntimeEventChange): void {
    const row = this.db
      .query<EventRow, [string, string, string, string, string | null, string]>(SQL.appendEvent)
      .get(
        this.timestamp(),
        txn.id,
        change.entity,
        change.kind,
        change.runId,
        JSON.stringify(change.record),
      );

    if (!row) {
      throw new Error("Event was not appended. Restore storage.");
    }

    txn.events.push(rowToEvent(row));
  }

  private emitRun(
    txn: EventTransaction,
    runId: string,
    kind: Extract<RuntimeEvent, { entity: "run" }>["kind"],
  ): void {
    this.emit(txn, { entity: "run", kind, runId, record: rowToRun(this.requireRow(runId)) });
  }

  private emitStep(txn: EventTransaction, runId: string, seq: number): void {
    const row = this.db.query<StepRow, [string, number]>(SQL.step).get(runId, seq);

    if (!row) {
      throw new Error("Step disappeared before commit. Restore storage.");
    }

    const record = rowToStep(row);
    this.emit(txn, { entity: "step", kind: record.status, runId, record });
  }

  private emitHook(
    txn: EventTransaction,
    token: string,
    kind: Extract<RuntimeEvent, { entity: "hook" }>["kind"],
  ): void {
    const row = this.db.query<HookRow, [string]>(SQL.hook).get(token);

    if (!row) {
      throw new Error("Hook disappeared before commit. Restore storage.");
    }

    const record = rowToHook(row);
    this.emit(txn, { entity: "hook", kind, runId: record.runId, record });
  }

  private emitSchedule(
    txn: EventTransaction,
    schedule: Pick<Schedule, "workspace" | "slug">,
    kind: "saved" | "fired",
  ): void {
    const row = this.db
      .query<ScheduleRow, [string, string]>(SQL.schedule)
      .get(schedule.workspace, schedule.slug);

    if (!row) {
      throw new Error("Schedule disappeared before commit. Restore storage.");
    }

    this.emit(txn, { entity: "schedule", kind, runId: null, record: rowToSchedule(row) });
  }

  close(): void {
    this.db.close();
  }

  private stale(row: RunRow, now: number): boolean {
    if (row.status !== "running" || row.owner_token === null || row.heartbeat_at === null) {
      return false;
    }

    if (row.owner_host === hostname() && row.owner_pid !== null) {
      try {
        process.kill(row.owner_pid, 0);

        return false;
      } catch (error) {
        if (errnoCode(error) !== "ESRCH") {
          return false;
        }
      }
    }

    return now - Date.parse(row.heartbeat_at) > this.leaseMs;
  }

  private insertRun(run: RunRecord): void {
    this.db
      .query(SQL.createRun)
      .run(
        run.id,
        run.slug,
        run.bundleHash,
        run.workspace,
        JSON.stringify(run.input),
        run.status,
        run.output === undefined ? null : JSON.stringify(run.output),
        run.error ?? null,
        run.wakeAt === undefined ? null : new Date(run.wakeAt).toISOString(),
        new Date(run.createdAt).toISOString(),
        new Date(run.updatedAt).toISOString(),
        run.owner?.token ?? null,
        run.owner?.pid ?? null,
        run.owner?.host ?? null,
        run.owner === undefined ? null : new Date(run.owner.heartbeatAt).toISOString(),
      );
  }

  private row(runId: string): RunRow | undefined {
    return this.db.query<RunRow, [string]>(SQL.run).get(runId) ?? undefined;
  }

  private requireRow(runId: string): RunRow {
    const row = this.row(runId);

    if (!row) {
      throw new Error(`Run '${runId}' does not exist. Create the run first.`);
    }

    return row;
  }

  private owned(runId: string, token: string): RunRow {
    const row = this.requireRow(runId);

    if (row.owner_token !== token) {
      throw new OwnershipError(runId);
    }

    return row;
  }

  private requireRunning(row: RunRow): void {
    if (row.status !== "running") {
      throw new Error(
        `Run '${row.id}' cannot transition from '${row.status}'. Claim a queued or suspended run first.`,
      );
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

export function openRunStore(home: string, options: { leaseMs?: number } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });

  return new SqliteRunStore(join(home, "runs.sqlite"), Date.now, options);
}
