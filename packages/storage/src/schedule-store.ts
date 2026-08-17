import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { CronExpressionV1Schema, IanaTimeZoneV1Schema, type JsonObject } from "@loopy/contracts";
import {
  nextOccurrence,
  type ScheduleDefinition,
  type SchedulerStore,
  type ScheduleState,
} from "@loopy/scheduler";
import type {
  RetentionApplyResult,
  RetentionCandidate,
  RetentionFilter,
  RetentionPolicyRecord,
  RetentionPreview,
  RunStatus,
  ScheduleFireRecord,
  ScheduleFireStatus,
  ScheduleMissedPolicy,
  ScheduleOverlapPolicy,
  ScheduleRecord,
  ScheduleRunLinkRecord,
} from "./storage.js";

type Row = Record<string, unknown>;
type NormalizedRetentionFilter = RetentionFilter & { batchSize: number };
const encode = (value: unknown) => JSON.stringify(value ?? {});
const decode = <T>(value: string | null | undefined): T | undefined =>
  value == null ? undefined : (JSON.parse(value) as T);
const now = () => new Date().toISOString();
const schedule = (r: Row): ScheduleRecord => ({
  id: r.id as string,
  name: r.name as string,
  workflowId: r.workflow_id as string,
  workflowVersion: r.workflow_version as number,
  input: decode<JsonObject>(r.input_json as string) ?? {},
  expression: r.expression as string,
  timezone: r.timezone as string,
  overlapPolicy: r.overlap_policy as ScheduleOverlapPolicy,
  missedPolicy: r.missed_policy as ScheduleMissedPolicy,
  enabled: Boolean(r.enabled),
  ...(typeof r.next_fire_at === "string" ? { nextFireAt: r.next_fire_at } : {}),
  ...(typeof r.last_fire_at === "string" ? { lastFireAt: r.last_fire_at } : {}),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});
const fire = (r: Row): ScheduleFireRecord => ({
  id: r.id as string,
  scheduleId: r.schedule_id as string,
  fireKey: r.fire_key as string,
  scheduledAt: r.scheduled_at as string,
  status: r.status as ScheduleFireStatus,
  ...(typeof r.run_id === "string" ? { runId: r.run_id } : {}),
  ...(typeof r.started_at === "string" ? { startedAt: r.started_at } : {}),
  ...(typeof r.finished_at === "string" ? { finishedAt: r.finished_at } : {}),
  ...(typeof r.error === "string" ? { error: r.error } : {}),
  createdAt: r.created_at as string,
});
const link = (r: Row): ScheduleRunLinkRecord => ({
  id: r.id as string,
  scheduleId: r.schedule_id as string,
  fireId: r.fire_id as string,
  runId: r.run_id as string,
  state: r.state as ScheduleRunLinkRecord["state"],
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

function validateScheduleDefinition(expression: string, timezone: string): void {
  if (!IanaTimeZoneV1Schema.safeParse(timezone).success)
    throw new Error("Schedule timezone must be a valid IANA timezone");
  if (expression === "manual") return;
  if (!CronExpressionV1Schema.safeParse(expression).success)
    throw new Error("Schedule expression must be a valid five-field cron expression");
}

/** SQLite-only seam for the scheduler engine. It owns durable claims; engines own time math. */
export class ScheduleRepository {
  constructor(private readonly db: Database) {}
  private run(sql: string, ...args: unknown[]): void {
    this.db.run(sql, args as never);
  }
  get(id: string): ScheduleRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM schedules WHERE id=?").get(id);
    return r ? schedule(r) : undefined;
  }
  /**
   * Remove a schedule and its bookkeeping atomically. A schedule owns only
   * terminal fire history; an active/queued or otherwise non-terminal linked
   * run is deliberately protected and makes removal fail closed.
   */
  remove(id: string): boolean {
    return this.db.transaction(() => {
      const existing = this.db.query<Row, [string]>("SELECT id FROM schedules WHERE id=?").get(id);
      if (!existing) return false;
      const protectedRun = this.db
        .query<Row, [string]>(
          `SELECT l.run_id
             FROM schedule_run_links l
             JOIN runs r ON r.id=l.run_id
            WHERE l.schedule_id=?
              AND r.status NOT IN ('succeeded','failed','cancelled')
            LIMIT 1`,
        )
        .get(id);
      const protectedFireRun = this.db
        .query<Row, [string]>(
          `SELECT f.run_id
             FROM schedule_fires f
             JOIN runs r ON r.id=f.run_id
            WHERE f.schedule_id=?
              AND r.status NOT IN ('succeeded','failed','cancelled')
            LIMIT 1`,
        )
        .get(id);
      if (protectedRun || protectedFireRun)
        throw new Error(
          `Cannot remove schedule ${id}: linked run ${String((protectedRun ?? protectedFireRun)?.run_id)} is active or non-terminal`,
        );
      // Foreign keys cascade fires, links, and scheduler cursor state. Keep
      // this explicit for older databases whose foreign-key pragma was off.
      this.run("DELETE FROM schedule_run_links WHERE schedule_id=?", id);
      this.run("DELETE FROM schedule_fires WHERE schedule_id=?", id);
      this.run("DELETE FROM scheduler_state WHERE schedule_id=?", id);
      this.run("DELETE FROM schedules WHERE id=?", id);
      return true;
    })() as boolean;
  }
  list(options: { enabled?: boolean; dueBefore?: string } = {}): ScheduleRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (options.enabled !== undefined) {
      where.push("enabled=?");
      args.push(options.enabled ? 1 : 0);
    }
    if (options.dueBefore !== undefined) {
      where.push("next_fire_at IS NOT NULL AND next_fire_at<=?");
      args.push(options.dueBefore);
    }
    const rows = this.db
      .query<Row, any>(
        `SELECT * FROM schedules${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at,id`,
      )
      .all(...(args as any));
    return (rows as Row[]).map(schedule);
  }
  create(input: {
    id?: string;
    name: string;
    workflowId: string;
    workflowVersion: number;
    input?: JsonObject;
    expression: string;
    timezone?: string;
    overlapPolicy?: ScheduleOverlapPolicy;
    missedPolicy?: ScheduleMissedPolicy;
    enabled?: boolean;
    nextFireAt?: string;
  }): ScheduleRecord {
    if (!input.name.trim() || !input.expression.trim())
      throw new Error("Schedule name and expression are required");
    const expression = input.expression.trim();
    const timezone = (input.timezone ?? "UTC").trim();
    validateScheduleDefinition(expression, timezone);
    const id = input.id ?? randomUUID();
    const at = now();
    const derivedNextFireAt =
      input.nextFireAt ??
      (expression === "manual"
        ? undefined
        : nextOccurrence(
            {
              schemaVersion: "1",
              scheduleId: id,
              expression,
              timezone,
              enabled: input.enabled !== false,
              overlap: input.overlapPolicy === "skip" || !input.overlapPolicy ? "skip" : "queue",
              missed: input.missedPolicy === "skip" || !input.missedPolicy ? "skip" : "run_once",
              input: input.input ?? {},
            },
            new Date(),
          ).toISOString());
    this.run(
      "INSERT INTO schedules(id,name,workflow_id,workflow_version,input_json,expression,timezone,overlap_policy,missed_policy,enabled,next_fire_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      input.name.trim(),
      input.workflowId,
      input.workflowVersion,
      encode(input.input),
      expression,
      timezone,
      input.overlapPolicy ?? "skip",
      input.missedPolicy ?? "skip",
      input.enabled === false ? 0 : 1,
      derivedNextFireAt ?? null,
      at,
      at,
    );
    return this.get(id) as ScheduleRecord;
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        ScheduleRecord,
        | "name"
        | "expression"
        | "timezone"
        | "overlapPolicy"
        | "missedPolicy"
        | "enabled"
        | "nextFireAt"
        | "lastFireAt"
        | "input"
      >
    >,
  ): ScheduleRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown schedule ${id}`);
    const next = { ...current, ...patch };
    next.expression = next.expression.trim();
    next.timezone = next.timezone.trim();
    validateScheduleDefinition(next.expression, next.timezone);
    if (next.expression !== current.expression || next.timezone !== current.timezone) {
      if (next.expression === "manual") next.nextFireAt = undefined;
      else
        next.nextFireAt = nextOccurrence(
          {
            schemaVersion: "1",
            scheduleId: next.id,
            expression: next.expression,
            timezone: next.timezone,
            enabled: next.enabled,
            overlap: next.overlapPolicy === "skip" ? "skip" : "queue",
            missed: next.missedPolicy === "skip" ? "skip" : "run_once",
            input: next.input,
          },
          new Date(),
        ).toISOString();
    }
    this.db.transaction(() => {
      this.run(
        "UPDATE schedules SET name=?,expression=?,timezone=?,overlap_policy=?,missed_policy=?,enabled=?,next_fire_at=?,last_fire_at=?,input_json=?,updated_at=? WHERE id=?",
        next.name,
        next.expression,
        next.timezone,
        next.overlapPolicy,
        next.missedPolicy,
        next.enabled ? 1 : 0,
        next.nextFireAt ?? null,
        next.lastFireAt ?? null,
        encode(next.input),
        now(),
        id,
      );
      if (next.expression !== current.expression || next.timezone !== current.timezone) {
        this.run(
          "UPDATE scheduler_state SET revision=revision+1,cursor=?,updated_at=? WHERE schedule_id=?",
          next.nextFireAt ?? null,
          now(),
          id,
        );
      }
    })();
    return this.get(id) as ScheduleRecord;
  }
  claimFire(input: {
    scheduleId: string;
    fireKey: string;
    scheduledAt: string;
    id?: string;
  }): ScheduleFireRecord & { claimed: boolean } {
    return this.db.transaction(() => {
      const id = input.id ?? randomUUID();
      const existing = this.db
        .query<Row, [string, string]>(
          "SELECT * FROM schedule_fires WHERE schedule_id=? AND fire_key=?",
        )
        .get(input.scheduleId, input.fireKey);
      if (existing) return { ...fire(existing), claimed: false };
      this.run(
        "INSERT OR IGNORE INTO schedule_fires(id,schedule_id,fire_key,scheduled_at,status,created_at) VALUES (?,?,?,?,?,?)",
        id,
        input.scheduleId,
        input.fireKey,
        input.scheduledAt,
        "claimed",
        now(),
      );
      const row = this.db
        .query<Row, [string, string]>(
          "SELECT * FROM schedule_fires WHERE schedule_id=? AND fire_key=?",
        )
        .get(input.scheduleId, input.fireKey);
      return { ...fire(row as Row), claimed: (row as Row).id === id };
    })() as ScheduleFireRecord & { claimed: boolean };
  }
  listFires(scheduleId?: string, limit = 100): ScheduleFireRecord[] {
    const n = Math.min(1000, Math.max(1, limit));
    const rows = scheduleId
      ? this.db
          .query<Row, [string, number]>(
            "SELECT * FROM schedule_fires WHERE schedule_id=? ORDER BY scheduled_at DESC,id DESC LIMIT ?",
          )
          .all(scheduleId, n)
      : this.db
          .query<Row, [number]>(
            "SELECT * FROM schedule_fires ORDER BY scheduled_at DESC,id DESC LIMIT ?",
          )
          .all(n);
    return (rows as Row[]).map(fire);
  }
  getFire(id: string): ScheduleFireRecord | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM schedule_fires WHERE id=?").get(id);
    return row ? fire(row) : undefined;
  }
  updateFire(
    id: string,
    patch: Partial<
      Pick<ScheduleFireRecord, "status" | "runId" | "startedAt" | "finishedAt" | "error">
    >,
  ): ScheduleFireRecord {
    const current = this.db.query<Row, [string]>("SELECT * FROM schedule_fires WHERE id=?").get(id);
    if (!current) throw new Error(`Unknown schedule fire ${id}`);
    const next = { ...fire(current), ...patch };
    this.run(
      "UPDATE schedule_fires SET status=?,run_id=?,started_at=?,finished_at=?,error=? WHERE id=?",
      next.status,
      next.runId ?? null,
      next.startedAt ?? null,
      next.finishedAt ?? null,
      next.error ?? null,
      id,
    );
    return fire(
      this.db.query<Row, [string]>("SELECT * FROM schedule_fires WHERE id=?").get(id) as Row,
    );
  }
  linkRun(input: {
    scheduleId: string;
    fireId: string;
    runId: string;
    state?: ScheduleRunLinkRecord["state"];
  }): ScheduleRunLinkRecord {
    return this.db.transaction(() => {
      const at = now();
      this.run(
        "UPDATE schedule_fires SET run_id=?,status='running',started_at=? WHERE id=? AND schedule_id=?",
        input.runId,
        at,
        input.fireId,
        input.scheduleId,
      );
      this.run(
        "INSERT INTO schedule_run_links(id,schedule_id,fire_id,run_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(fire_id) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,updated_at=excluded.updated_at",
        randomUUID(),
        input.scheduleId,
        input.fireId,
        input.runId,
        input.state ?? "active",
        at,
        at,
      );
      return link(
        this.db
          .query<Row, [string]>("SELECT * FROM schedule_run_links WHERE fire_id=?")
          .get(input.fireId) as Row,
      );
    })() as ScheduleRunLinkRecord;
  }
  listLinks(scheduleId?: string, state?: ScheduleRunLinkRecord["state"]): ScheduleRunLinkRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (scheduleId) {
      where.push("schedule_id=?");
      args.push(scheduleId);
    }
    if (state) {
      where.push("state=?");
      args.push(state);
    }
    return (
      this.db
        .query<Row, any>(
          `SELECT * FROM schedule_run_links${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at,id`,
        )
        .all(...(args as any)) as Row[]
    ).map(link);
  }
  updateLink(runId: string, state: ScheduleRunLinkRecord["state"]): void {
    this.run(
      "UPDATE schedule_run_links SET state=?,updated_at=? WHERE run_id=?",
      state,
      now(),
      runId,
    );
  }
  /** Reconcile durable schedule bookkeeping after a runtime reaches a terminal state. */
  reconcileRun(runId: string, status: RunStatus): ScheduleRunLinkRecord | undefined {
    const current = this.db
      .query<Row, [string]>("SELECT * FROM schedule_run_links WHERE run_id=?")
      .get(runId);
    if (!current) return undefined;
    const at = now();
    this.db.transaction(() => {
      this.run(
        "UPDATE schedule_run_links SET state='terminal',updated_at=? WHERE run_id=?",
        at,
        runId,
      );
      this.run(
        "UPDATE schedule_fires SET status=?,finished_at=?,run_id=? WHERE id=?",
        status === "succeeded" ? "succeeded" : "failed",
        at,
        runId,
        current.fire_id,
      );
    })();
    return link(
      this.db
        .query<Row, [string]>("SELECT * FROM schedule_run_links WHERE run_id=?")
        .get(runId) as Row,
    );
  }
  /** Adapt the durable schedule tables to the scheduler engine's state port. */
  schedulerStore(): SchedulerStore {
    return {
      listSchedules: async (): Promise<ScheduleDefinition[]> =>
        this.list().map((record) => ({
          schedule: {
            schemaVersion: "1",
            scheduleId: record.id,
            expression: record.expression,
            timezone: record.timezone,
            enabled: record.enabled,
            overlap: record.overlapPolicy,
            missed: record.missedPolicy,
            input: record.input,
          },
          workflowId: record.workflowId,
          workflowVersion: record.workflowVersion,
          manual: { enabled: true, input: record.input },
        })),
      getState: async (scheduleId: string): Promise<ScheduleState | undefined> => {
        const record = this.get(scheduleId);
        if (!record) return undefined;
        const persisted = this.db
          .query<Row, [string]>("SELECT * FROM scheduler_state WHERE schedule_id=?")
          .get(scheduleId);
        const active = this.listLinks(scheduleId, "active")[0];
        const activeFire = active ? this.getFire(active.fireId) : undefined;
        const toInvocation = (item: ScheduleFireRecord) => ({
          scheduleId,
          workflowId: record.workflowId,
          workflowVersion: record.workflowVersion,
          input: record.input,
          scheduledFor: item.scheduledAt,
          firedAt: item.createdAt,
          idempotencyKey: item.fireKey,
          source: "cron" as const,
        });
        const state: ScheduleState = {
          scheduleId,
          ...(record.nextFireAt ? { nextDueAt: record.nextFireAt } : {}),
          ...(active && activeFire
            ? { active: { ...toInvocation(activeFire), executionId: active.runId } }
            : {}),
        };
        if (persisted) {
          state.revision = Number(persisted.revision);
          if (typeof persisted.cursor === "string") state.cursor = persisted.cursor;
          state.nextDueAt = typeof persisted.cursor === "string" ? persisted.cursor : undefined;
          state.active =
            decode<ScheduleState["active"]>(persisted.active_json as string) ?? state.active;
          state.pending =
            decode<ScheduleState["pending"]>(persisted.pending_json as string) ?? state.pending;
        } else {
          state.revision = 0;
        }
        return state;
      },
      saveState: async (state: ScheduleState): Promise<void> => {
        const record = this.get(state.scheduleId);
        if (!record) throw new Error(`Unknown schedule ${state.scheduleId}`);
        const expectedRevision = state.revision ?? 0;
        const expectedCursor = state.cursor;
        this.db.transaction(() => {
          const current = this.db
            .query<Row, [string]>("SELECT revision,cursor FROM scheduler_state WHERE schedule_id=?")
            .get(state.scheduleId);
          if (current) {
            if (
              Number(current.revision) !== expectedRevision ||
              (current.cursor as string | null | undefined) !== (expectedCursor ?? null)
            )
              throw new Error(`Schedule state changed concurrently for ${state.scheduleId}`);
            this.run(
              "UPDATE scheduler_state SET revision=?,cursor=?,active_json=?,pending_json=?,updated_at=? WHERE schedule_id=? AND revision=? AND cursor IS ?",
              expectedRevision + 1,
              state.nextDueAt ?? null,
              state.active ? JSON.stringify(state.active) : null,
              state.pending ? JSON.stringify(state.pending) : null,
              now(),
              state.scheduleId,
              expectedRevision,
              expectedCursor ?? null,
            );
          } else {
            if (expectedRevision !== 0 || expectedCursor !== undefined)
              throw new Error(`Schedule state changed concurrently for ${state.scheduleId}`);
            this.run(
              "INSERT INTO scheduler_state(schedule_id,revision,cursor,active_json,pending_json,updated_at) VALUES (?,?,?,?,?,?)",
              state.scheduleId,
              1,
              state.nextDueAt ?? null,
              state.active ? JSON.stringify(state.active) : null,
              state.pending ? JSON.stringify(state.pending) : null,
              now(),
            );
          }
          this.run(
            "UPDATE schedules SET next_fire_at=?,updated_at=? WHERE id=?",
            state.nextDueAt ?? null,
            now(),
            state.scheduleId,
          );
        })();
        state.revision = expectedRevision + 1;
        state.cursor = state.nextDueAt;
      },
      claimIdempotencyKey: async (scheduleId: string, key: string): Promise<boolean> => {
        return this.db.transaction(() => {
          const existing = this.db
            .query<Row, [string, string]>(
              "SELECT 1 FROM schedule_fires WHERE schedule_id=? AND fire_key=?",
            )
            .get(scheduleId, key);
          if (existing) return false;
          this.run(
            "INSERT INTO schedule_fires(id,schedule_id,fire_key,scheduled_at,status,created_at) VALUES (?,?,?,?,?,?)",
            randomUUID(),
            scheduleId,
            key,
            key.startsWith(`${scheduleId}:manual:`)
              ? key.slice(`${scheduleId}:manual:`.length)
              : key.startsWith(`${scheduleId}:`)
                ? key.slice(`${scheduleId}:`.length)
                : new Date().toISOString(),
            "claimed",
            now(),
          );
          return true;
        })() as boolean;
      },
    };
  }
  getRetentionPolicy(id = "default"): RetentionPolicyRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM retention_policies WHERE id=?").get(id);
    return r
      ? {
          id: r.id as string,
          ...(typeof r.max_age_days === "number" ? { maxAgeDays: r.max_age_days } : {}),
          ...(typeof r.max_runs === "number" ? { maxRuns: r.max_runs } : {}),
          batchSize: r.batch_size as number,
          updatedAt: r.updated_at as string,
        }
      : undefined;
  }
  saveRetentionPolicy(input: Omit<RetentionPolicyRecord, "updatedAt">): RetentionPolicyRecord {
    const at = now();
    this.run(
      "INSERT INTO retention_policies(id,max_age_days,max_runs,batch_size,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET max_age_days=excluded.max_age_days,max_runs=excluded.max_runs,batch_size=excluded.batch_size,updated_at=excluded.updated_at",
      input.id,
      input.maxAgeDays ?? null,
      input.maxRuns ?? null,
      Math.min(1000, Math.max(1, input.batchSize)),
      at,
    );
    return this.getRetentionPolicy(input.id) as RetentionPolicyRecord;
  }
  previewRetention(input: RetentionFilter = {}): RetentionPreview {
    return this.retentionPreview(this.normalizeRetentionFilter(input));
  }
  private normalizeRetentionFilter(input: RetentionFilter): NormalizedRetentionFilter {
    if (input.before && !Number.isFinite(Date.parse(input.before)))
      throw new Error("before must be an ISO timestamp");
    if (
      input.maxAgeDays !== undefined &&
      (!Number.isSafeInteger(input.maxAgeDays) || input.maxAgeDays <= 0)
    )
      throw new Error("maxAgeDays must be a positive integer");
    if (input.maxRuns !== undefined && (!Number.isSafeInteger(input.maxRuns) || input.maxRuns <= 0))
      throw new Error("maxRuns must be a positive integer");
    const ageBefore =
      input.maxAgeDays === undefined
        ? undefined
        : new Date(Date.now() - input.maxAgeDays * 86_400_000).toISOString();
    const beforeValues = [input.before, ageBefore].filter(
      (value): value is string => typeof value === "string",
    );
    return {
      ...input,
      ...(beforeValues.length ? { before: beforeValues.sort()[0] } : {}),
      batchSize: Math.min(
        1000,
        Math.max(1, input.batchSize ?? this.getRetentionPolicy()?.batchSize ?? 100),
      ),
    };
  }
  private retentionPreview(filter: NormalizedRetentionFilter): RetentionPreview {
    const before = filter.before;
    const protectedRunIds = this.db
      .query<{ id: string }, []>(
        "SELECT id FROM runs WHERE status IN ('created','running','pause_requested','paused','cancelling','blocked_approval') OR id IN (SELECT run_id FROM schedule_run_links WHERE state IN ('queued','active'))",
      )
      .all()
      .map((r) => r.id);
    const keep = new Set(protectedRunIds);
    const rows = this.db
      .query<Row, []>(
        "SELECT * FROM runs WHERE status IN ('succeeded','failed','cancelled') ORDER BY created_at DESC,id DESC",
      )
      .all() as Row[];
    const terminal = rows.filter(
      (r) => !keep.has(r.id as string) && (!before || String(r.created_at) < before),
    );
    const selected = terminal
      .filter((_r, i) => filter.maxRuns === undefined || i >= filter.maxRuns)
      .slice(0, filter.batchSize + 1);
    const candidates: RetentionCandidate[] = selected.map((r) => ({
      runId: r.id as string,
      workflowId: r.workflow_id as string,
      workflowVersion: r.workflow_version as number,
      status: r.status as RunStatus,
      createdAt: r.created_at as string,
      eventCount:
        this.db
          .query<{ count: number }, [string]>("SELECT COUNT(*) count FROM events WHERE run_id=?")
          .get(r.id as string)?.count ?? 0,
      artifactCount:
        this.db
          .query<{ count: number }, [string]>("SELECT COUNT(*) count FROM artifacts WHERE run_id=?")
          .get(r.id as string)?.count ?? 0,
    }));
    return {
      candidates: candidates.slice(0, filter.batchSize),
      protectedRunIds,
      hasMore: candidates.length > filter.batchSize,
      filter,
    };
  }
  applyRetention(input: RetentionFilter = {}): RetentionApplyResult {
    const filter = this.normalizeRetentionFilter(input);
    return this.db.transaction(() => {
      // Recompute the candidate set under the same write transaction that removes it. This
      // keeps preview/apply criteria identical while preventing an active run from being
      // selected between the read and the deletes.
      const preview = this.retentionPreview(filter);
      const deletedCounts = {
        runs: 0,
        events: 0,
        artifacts: 0,
        approvals: 0,
        nodeAttempts: 0,
        scheduleRunLinks: 0,
        scheduleFires: 0,
      };
      for (const candidate of preview.candidates) {
        const runId = candidate.runId;
        const count = (table: string) =>
          Number(
            this.db
              .query<{ count: number }, [string]>(
                `SELECT COUNT(*) count FROM ${table} WHERE run_id=?`,
              )
              .get(runId)?.count ?? 0,
          );
        const deleteByRun = (table: string) =>
          this.run(`DELETE FROM ${table} WHERE run_id=?`, runId);

        deletedCounts.scheduleRunLinks += count("schedule_run_links");
        deletedCounts.scheduleFires += Number(
          this.db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) count FROM schedule_fires WHERE run_id=?",
            )
            .get(runId)?.count ?? 0,
        );
        this.run("DELETE FROM schedule_run_links WHERE run_id=?", runId);
        this.run("DELETE FROM schedule_fires WHERE run_id=?", runId);

        deletedCounts.approvals += count("approvals");
        deletedCounts.artifacts += count("artifacts");
        deletedCounts.events += count("events");
        deletedCounts.nodeAttempts += count("node_attempts");
        deleteByRun("approvals");
        deleteByRun("artifacts");
        deleteByRun("events");
        deleteByRun("node_attempts");
        this.run("DELETE FROM runs WHERE id=?", runId);
        deletedCounts.runs += 1;
      }
      return {
        ...preview,
        deletedRunIds: preview.candidates.map((candidate) => candidate.runId),
        deletedCounts,
      };
    })() as RetentionApplyResult;
  }
}
