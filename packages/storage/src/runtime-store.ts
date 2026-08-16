import type { Database } from "bun:sqlite";
import type { JsonObject, TraceEvent } from "@loopy/contracts";
import { SupportedTraceEventSchema as TraceEventSchema } from "@loopy/contracts";
import type {
  ApprovalRecord as RuntimeApproval,
  AttemptRecord as RuntimeAttempt,
  RuntimeEvent,
  RunRecord as RuntimeRun,
  RuntimeStore,
  RuntimeStoreCommand,
} from "@loopy/runtime";
import type { TraceEventSink, TraceEventSource } from "@loopy/tracing";
import type { Storage } from "./storage.js";

type Row = Record<string, unknown>;

const encode = (value: unknown) => JSON.stringify(value ?? {});
const decode = <T>(value: string | null | undefined): T | undefined =>
  value == null ? undefined : (JSON.parse(value) as T);

function stableId(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    return value;
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}${hex.slice(0, 4)}`;
}

function nonEmpty(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function completion(value: unknown, status: "succeeded" | "failed" | "cancelled" | "skipped") {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    schemaVersion: "1" as const,
    status,
    summary: String(source.summary ?? status),
    outputs: (source.outputs ?? {}) as JsonObject,
    artifacts: Array.isArray(source.artifacts) ? source.artifacts : [],
    verification: Array.isArray(source.verification) ? source.verification : [],
    warnings: Array.isArray(source.warnings) ? source.warnings : [],
    ...(source.route === undefined ? {} : { route: String(source.route) }),
  };
}

/** Convert scheduler intents to the versioned event contract at the persistence boundary. */
function toTraceEvent(event: RuntimeEvent, sequence: number, approvalKey?: string): TraceEvent {
  const payload = event.payload ?? {};
  const source = payload as Record<string, unknown>;
  const base: Record<string, unknown> = {
    schemaVersion: "1",
    id: stableId(
      `${event.runId}:${sequence}:${event.type}:${event.nodeId ?? ""}:${event.attemptId ?? ""}`,
    ),
    runId: stableId(event.runId),
    sequence,
    occurredAt: event.occurredAt,
    monotonicOffsetMs: 0,
    redaction: { status: "none", removedFields: [] },
  };
  if (event.nodeId) base.nodeId = stableId(event.nodeId);
  if (event.attemptId) base.attemptId = stableId(event.attemptId);
  let canonical: Record<string, unknown>;
  switch (event.type) {
    case "run.created":
      canonical = {
        ...base,
        type: event.type,
        payload: {
          workflowId: stableId(String(source.workflowId ?? event.runId)),
          workflowVersion: Number(source.workflowVersion ?? 1),
        },
      };
      break;
    case "run.started":
      canonical = {
        ...base,
        type: event.type,
        payload: { planHash: nonEmpty(source.planHash, "0".repeat(64)) },
      };
      break;
    case "run.pause_requested":
      canonical = {
        ...base,
        type: event.type,
        payload: { requestedBy: source.requestedBy === "user" ? "user" : "runtime" },
      };
      break;
    case "run.paused":
      canonical = {
        ...base,
        type: event.type,
        payload: {
          activeNodeIds: Array.isArray(source.activeNodeIds)
            ? source.activeNodeIds.map((id) => stableId(String(id)))
            : [],
        },
      };
      break;
    case "run.resumed":
      canonical = {
        ...base,
        type: event.type,
        payload: { resumedBy: source.resumedBy === "recovery" ? "recovery" : "user" },
      };
      break;
    case "run.cancelling":
      canonical = {
        ...base,
        type: event.type,
        payload: { reason: nonEmpty(source.reason, "cancelled") },
      };
      break;
    case "run.completed":
      canonical = {
        ...base,
        type: event.type,
        payload: {
          status: source.status ?? "failed",
          summary: String(source.summary ?? source.status ?? "completed"),
        },
      };
      break;
    case "node.ready":
    case "node.started":
      canonical = { ...base, type: event.type, payload: {} };
      break;
    case "node.output":
      canonical = {
        ...base,
        type: event.type,
        payload: { output: (source.output ?? {}) as JsonObject },
      };
      break;
    case "node.blocked":
      canonical = {
        ...base,
        type: event.type,
        payload: { reason: nonEmpty(source.reason, "blocked") },
      };
      break;
    case "node.completed": {
      const status = ((source.completion as Record<string, unknown> | undefined)?.status ??
        "failed") as "succeeded" | "failed" | "cancelled" | "skipped";
      canonical = {
        ...base,
        type: event.type,
        payload: { completion: completion(source.completion, status) },
      };
      break;
    }
    case "attempt.created":
      canonical = { ...base, type: event.type, payload: { attempt: Number(source.attempt ?? 1) } };
      break;
    case "attempt.retrying":
      canonical = {
        ...base,
        type: event.type,
        payload: {
          nextAttempt: Number(source.nextAttempt ?? 1),
          reason: nonEmpty(source.reason, "retry"),
        },
      };
      break;
    case "attempt.failed":
      canonical = {
        ...base,
        type: event.type,
        payload: { error: nonEmpty(source.error, "attempt failed") },
      };
      break;
    case "attempt.cancelled":
      canonical = {
        ...base,
        type: event.type,
        payload: { reason: nonEmpty(source.reason, "cancelled") },
      };
      break;
    case "approval.requested":
      canonical = {
        ...base,
        type: event.type,
        payload: {
          approvalKey: nonEmpty(source.approvalKey, approvalKey ?? event.nodeId ?? "approval"),
          message: nonEmpty(source.message, "Approval required"),
        },
      };
      break;
    case "approval.resolved":
      canonical = {
        ...base,
        type: event.type,
        payload: {
          approvalKey: nonEmpty(source.approvalKey, approvalKey ?? event.nodeId ?? "approval"),
          decision: source.decision === "approved" ? "approved" : "rejected",
          resolvedBy: nonEmpty(source.resolvedBy, "runtime"),
        },
      };
      break;
    case "runtime.recovery": {
      const attempts = Array.isArray(source.interruptedAttempts) ? source.interruptedAttempts : [];
      if (!base.attemptId)
        base.attemptId = stableId(String(attempts[0] ?? `${event.runId}:recovery`));
      canonical = {
        ...base,
        type: event.type,
        payload: {
          action: "marked_failed",
          reason: nonEmpty(source.reason, "interrupted during recovery"),
        },
      };
      break;
    }
    default:
      canonical = {
        ...base,
        type: "runtime.warning",
        payload: {
          code: "internal_event",
          message: `Unsupported runtime event ${event.type}`,
          severity: "warning",
        },
      };
      break;
  }
  const parsed = TraceEventSchema.safeParse(canonical);
  if (!parsed.success)
    throw new Error(
      `Runtime event ${event.type} is not canonical (id=${String(canonical.id)} runId=${String(canonical.runId)}): ${parsed.error.message}`,
    );
  return parsed.data;
}

const RUN_TRANSITIONS: Record<string, readonly string[]> = {
  created: ["running", "cancelling"],
  running: ["pause_requested", "paused", "cancelling", "succeeded", "failed"],
  pause_requested: ["paused", "cancelling"],
  paused: ["running", "cancelling"],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  succeeded: [],
  failed: [],
};
const ATTEMPT_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["ready", "cancelled", "skipped"],
  ready: ["running", "cancelled", "skipped"],
  running: ["blocked_approval", "succeeded", "failed", "cancelled"],
  blocked_approval: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
};
const legal = (table: Record<string, readonly string[]>, from: string, to: string) =>
  from === to || table[from]?.includes(to) === true;

function runFromRow(row: Row): RuntimeRun {
  const runtime = decode<RuntimeRun>(row.runtime_json as string | null);
  if (runtime) return runtime;
  return {
    runId: row.id as string,
    workflowId: row.workflow_id as string,
    workflowVersion: row.workflow_version as number,
    plan: (decode<JsonObject>(row.plan_json as string) ?? {}) as RuntimeRun["plan"],
    inputs: (decode<JsonObject>(row.input_json as string) ?? {}) as JsonObject,
    status: row.status as RuntimeRun["status"],
    createdAt: row.created_at as string,
  };
}

function attemptFromRow(row: Row): RuntimeAttempt {
  const runtime = decode<RuntimeAttempt>(row.runtime_json as string | null);
  if (runtime) return runtime;
  return {
    attemptId: row.id as string,
    runId: row.run_id as string,
    nodeId: row.node_id as string,
    attempt: row.attempt as number,
    status: row.status as RuntimeAttempt["status"],
    input: (decode<JsonObject>(row.input_json as string | null) ?? {}) as JsonObject,
    createdAt: row.updated_at as string,
  };
}

/** SQLite implementation of the scheduler's transactional command port. */
export class SqliteRuntimeStore implements RuntimeStore {
  readonly storage: Storage;
  readonly db: Database;
  constructor(storage: Storage) {
    this.storage = storage;
    this.db = storage.db;
  }

  async commit(commands: readonly RuntimeStoreCommand[]): Promise<void> {
    this.db.transaction(() => {
      for (const command of commands) {
        if (command.type === "set_run") {
          const row = this.db
            .query<Row, [string]>("SELECT * FROM runs WHERE id=?")
            .get(command.runId);
          if (!row) throw new Error(`Unknown run ${command.runId}`);
          if (
            command.patch.status &&
            !legal(RUN_TRANSITIONS, row.status as string, command.patch.status)
          )
            throw new Error(`Illegal run transition ${row.status} -> ${command.patch.status}`);
        }
        if (command.type === "set_attempt") {
          const row = this.db
            .query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?")
            .get(command.attemptId);
          if (!row) throw new Error(`Unknown attempt ${command.attemptId}`);
          if (
            command.patch.status &&
            !legal(ATTEMPT_TRANSITIONS, row.status as string, command.patch.status)
          )
            throw new Error(`Illegal attempt transition ${row.status} -> ${command.patch.status}`);
        }
      }
      for (const command of commands) this.apply(command);
    })();
  }

  private apply(command: RuntimeStoreCommand): void {
    switch (command.type) {
      case "create_run": {
        const run = command.run;
        this.db.run(
          "INSERT OR IGNORE INTO workflow_versions(workflow_id,version,definition_json,created_at) VALUES (?,?,?,?)",
          [run.workflowId, run.workflowVersion, encode(run.plan), run.createdAt],
        );
        this.db.run(
          "INSERT INTO runs(id,workflow_id,workflow_version,status,input_json,plan_hash,created_at,updated_at,plan_json,runtime_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [
            run.runId,
            run.workflowId,
            run.workflowVersion,
            run.status,
            encode(run.inputs),
            null,
            run.createdAt,
            run.createdAt,
            encode(run.plan),
            encode(run),
          ],
        );
        return;
      }
      case "set_run": {
        const row = this.db
          .query<Row, [string]>("SELECT * FROM runs WHERE id=?")
          .get(command.runId);
        if (!row) throw new Error(`Unknown run ${command.runId}`);
        const current = runFromRow(row);
        const next = { ...current, ...command.patch };
        this.db.run(
          "UPDATE runs SET status=?,input_json=?,created_at=?,updated_at=?,plan_json=?,runtime_json=? WHERE id=?",
          [
            next.status,
            encode(next.inputs),
            next.createdAt,
            next.endedAt ?? new Date().toISOString(),
            encode(next.plan),
            encode(next),
            command.runId,
          ],
        );
        return;
      }
      case "create_attempt": {
        const attempt = command.attempt;
        const duplicate = this.db
          .query<Row, [string, string, number]>(
            "SELECT id FROM node_attempts WHERE run_id=? AND node_id=? AND attempt=?",
          )
          .get(attempt.runId, attempt.nodeId, attempt.attempt);
        if (duplicate)
          throw new Error(
            `Duplicate attempt ${attempt.runId}/${attempt.nodeId}/${attempt.attempt} (${attempt.attemptId}, existing ${String(duplicate.id)})`,
          );
        this.db.run(
          "INSERT INTO node_attempts(id,run_id,node_id,attempt,status,input_json,updated_at,runtime_json) VALUES (?,?,?,?,?,?,?,?)",
          [
            attempt.attemptId,
            attempt.runId,
            attempt.nodeId,
            attempt.attempt,
            attempt.status,
            encode(attempt.input),
            attempt.createdAt,
            encode(attempt),
          ],
        );
        return;
      }
      case "set_attempt": {
        const row = this.db
          .query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?")
          .get(command.attemptId);
        if (!row) throw new Error(`Unknown attempt ${command.attemptId}`);
        const current = attemptFromRow(row);
        const next = { ...current, ...command.patch };
        this.db.run(
          "UPDATE node_attempts SET status=?,input_json=?,output_json=?,error=?,started_at=?,finished_at=?,updated_at=?,runtime_json=? WHERE id=?",
          [
            next.status === "blocked_approval" ? "blocked_approval" : next.status,
            encode(next.input),
            next.output === undefined ? null : encode(next.output),
            next.error ?? null,
            next.startedAt ?? null,
            next.endedAt ?? null,
            next.endedAt ?? next.startedAt ?? new Date().toISOString(),
            encode(next),
            command.attemptId,
          ],
        );
        return;
      }
      case "set_approval": {
        const approval = command.approval;
        this.db.run(
          "INSERT INTO approvals(id,run_id,node_id,approval_key,message,status,requested_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id,approval_key) DO UPDATE SET node_id=excluded.node_id,status=excluded.status,message=excluded.message",
          [
            stableId(`${approval.runId}:${approval.nodeId}:approval`),
            approval.runId,
            approval.nodeId,
            approval.key,
            approval.message,
            approval.decision
              ? approval.decision === "approved"
                ? "approved"
                : "rejected"
              : "pending",
            new Date().toISOString(),
          ],
        );
        return;
      }
      case "resolve_approval":
        this.db.run(
          "UPDATE approvals SET status=?,resolved_at=?,resolved_by=? WHERE run_id=? AND node_id=?",
          [command.decision, new Date().toISOString(), "runtime", command.runId, command.nodeId],
        );
        return;
      case "append_event": {
        const raw = command.event;
        const row = this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(raw.runId);
        if (!row) throw new Error(`Unknown run ${raw.runId}`);
        const max =
          this.db
            .query<{ maxSequence: number | null }, [string]>(
              "SELECT MAX(sequence) maxSequence FROM events WHERE run_id=?",
            )
            .get(raw.runId)?.maxSequence ?? -1;
        const sequence = max + 1;
        const approval = raw.nodeId
          ? this.db
              .query<{ key: string }, [string, string]>(
                "SELECT approval_key key FROM approvals WHERE run_id=? AND node_id=? ORDER BY requested_at DESC LIMIT 1",
              )
              .get(raw.runId, raw.nodeId)?.key
          : undefined;
        const event = toTraceEvent(raw, sequence, approval);
        const attemptExists = raw.attemptId
          ? this.db.query("SELECT 1 FROM node_attempts WHERE id=?").get(raw.attemptId) !== null
          : false;
        this.db.run(
          "INSERT INTO events(id,run_id,sequence,type,payload_json,node_id,attempt_id,provider,session_id,tool_call_id,occurred_at,monotonic_offset_ms,trace_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            event.id,
            raw.runId,
            sequence,
            event.type,
            encode(event.payload),
            raw.nodeId ?? null,
            attemptExists ? (raw.attemptId ?? null) : null,
            event.provider ?? null,
            event.sessionId ?? null,
            event.toolCallId ?? null,
            event.occurredAt,
            event.monotonicOffsetMs,
            encode(event),
          ],
        );
        return;
      }
    }
  }

  async getRun(runId: string): Promise<RuntimeRun | undefined> {
    const row = this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(runId);
    return row ? runFromRow(row) : undefined;
  }
  async listRuns(): Promise<RuntimeRun[]> {
    return (this.db.query<Row, []>("SELECT * FROM runs ORDER BY created_at,id").all() as Row[]).map(
      runFromRow,
    );
  }
  async listAttempts(runId: string): Promise<RuntimeAttempt[]> {
    return (
      this.db
        .query<Row, [string]>("SELECT * FROM node_attempts WHERE run_id=? ORDER BY node_id,attempt")
        .all(runId) as Row[]
    ).map(attemptFromRow);
  }
  async listEvents(runId: string): Promise<RuntimeEvent[]> {
    return (
      this.db
        .query<Row, [string]>("SELECT * FROM events WHERE run_id=? ORDER BY sequence")
        .all(runId) as Row[]
    ).map((row) => ({
      sequence: row.sequence as number,
      type: row.type as string,
      runId,
      nodeId: row.node_id as string | undefined,
      attemptId: row.attempt_id as string | undefined,
      payload: decode<Record<string, unknown>>(row.payload_json as string) ?? {},
      occurredAt: row.occurred_at as string,
    }));
  }
  async getApproval(runId: string, nodeId: string): Promise<RuntimeApproval | undefined> {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM approvals WHERE run_id=? AND node_id=? ORDER BY requested_at DESC LIMIT 1",
      )
      .get(runId, nodeId);
    return row
      ? {
          runId,
          nodeId,
          attemptId: "",
          key: row.approval_key as string,
          message: row.message as string,
          decision: row.status === "pending" ? undefined : (row.status as "approved" | "rejected"),
        }
      : undefined;
  }

  listTraceEvents(runId: string): TraceEvent[] {
    return (
      this.db
        .query<Row, [string]>("SELECT * FROM events WHERE run_id=? ORDER BY sequence")
        .all(runId) as Row[]
    ).map((row) => {
      const stored = decode<TraceEvent>(row.trace_json as string | null);
      if (!stored) throw new Error(`Event ${String(row.id)} has no canonical trace envelope`);
      return TraceEventSchema.parse(stored);
    });
  }
  traceSource(runId: string): TraceEventSource {
    return { events: () => this.listTraceEvents(runId) };
  }
  traceSink(runId: string): TraceEventSink {
    return { append: (event) => this.appendTraceEvent(runId, event) };
  }
  appendTraceEvent(runId: string, event: TraceEvent): void {
    TraceEventSchema.parse(event);
    this.db.transaction(() => {
      const existingRun = this.db.query("SELECT 1 FROM runs WHERE id=?").get(runId);
      if (!existingRun) {
        const workflowId =
          event.type === "run.created"
            ? String(event.payload.workflowId)
            : stableId(`${runId}:workflow`);
        const workflowVersion =
          event.type === "run.created" ? Number(event.payload.workflowVersion) : 1;
        this.db.run(
          "INSERT OR IGNORE INTO workflow_versions(workflow_id,version,definition_json,created_at) VALUES (?,?,?,?)",
          [
            workflowId,
            workflowVersion,
            encode({ id: workflowId, workflowVersion }),
            event.occurredAt,
          ],
        );
        this.db.run(
          "INSERT INTO runs(id,workflow_id,workflow_version,status,input_json,created_at,updated_at,plan_json) VALUES (?,?,?,?,?,?,?,?)",
          [
            runId,
            workflowId,
            workflowVersion,
            "created",
            "{}",
            event.occurredAt,
            event.occurredAt,
            "{}",
          ],
        );
      }
      const collision = this.db
        .query("SELECT 1 FROM events WHERE run_id=? AND sequence=?")
        .get(runId, event.sequence);
      if (collision)
        throw new Error(`Trace sequence ${event.sequence} already exists for run ${runId}`);
      const attemptExists =
        event.attemptId &&
        this.db.query("SELECT 1 FROM node_attempts WHERE id=?").get(event.attemptId) !== null;
      this.db.run(
        "INSERT INTO events(id,run_id,sequence,type,payload_json,node_id,attempt_id,provider,session_id,tool_call_id,occurred_at,monotonic_offset_ms,trace_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          event.id,
          runId,
          event.sequence,
          event.type,
          encode(event.payload),
          event.nodeId ?? null,
          attemptExists ? (event.attemptId ?? null) : null,
          event.provider ?? null,
          event.sessionId ?? null,
          event.toolCallId ?? null,
          event.occurredAt,
          event.monotonicOffsetMs,
          encode(event),
        ],
      );
    })();
  }
}

export function createSqliteRuntimeStore(storage: Storage): SqliteRuntimeStore {
  return new SqliteRuntimeStore(storage);
}
