import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "@loopy/contracts";
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
    const id = input.id ?? randomUUID();
    const at = now();
    this.run(
      "INSERT INTO schedules(id,name,workflow_id,workflow_version,input_json,expression,timezone,overlap_policy,missed_policy,enabled,next_fire_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      input.name.trim(),
      input.workflowId,
      input.workflowVersion,
      encode(input.input),
      input.expression.trim(),
      input.timezone ?? "UTC",
      input.overlapPolicy ?? "skip",
      input.missedPolicy ?? "skip",
      input.enabled === false ? 0 : 1,
      input.nextFireAt ?? null,
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
    return this.get(id) as ScheduleRecord;
  }
  claimFire(input: {
    scheduleId: string;
    fireKey: string;
    scheduledAt: string;
    id?: string;
  }): ScheduleFireRecord {
    return this.db.transaction(() => {
      const existing = this.db
        .query<Row, [string, string]>(
          "SELECT * FROM schedule_fires WHERE schedule_id=? AND fire_key=?",
        )
        .get(input.scheduleId, input.fireKey);
      if (existing) return fire(existing);
      this.run(
        "INSERT INTO schedule_fires(id,schedule_id,fire_key,scheduled_at,status,created_at) VALUES (?,?,?,?,?,?)",
        input.id ?? randomUUID(),
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
      return fire(row as Row);
    })() as ScheduleFireRecord;
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
    if (input.before && !Number.isFinite(Date.parse(input.before)))
      throw new Error("before must be an ISO timestamp");
    if (
      input.maxAgeDays !== undefined &&
      (!Number.isSafeInteger(input.maxAgeDays) || input.maxAgeDays <= 0)
    )
      throw new Error("maxAgeDays must be a positive integer");
    if (input.maxRuns !== undefined && (!Number.isSafeInteger(input.maxRuns) || input.maxRuns <= 0))
      throw new Error("maxRuns must be a positive integer");
    const filter = {
      ...input,
      batchSize: Math.min(
        1000,
        Math.max(1, input.batchSize ?? this.getRetentionPolicy()?.batchSize ?? 100),
      ),
    };
    const before = filter.before
      ? filter.before
      : filter.maxAgeDays
        ? new Date(Date.now() - filter.maxAgeDays * 86_400_000).toISOString()
        : undefined;
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
  applyRetention(_input: RetentionFilter = {}): RetentionApplyResult {
    throw new Error("Retention apply must be enabled by the owning runtime integration");
  }
}
