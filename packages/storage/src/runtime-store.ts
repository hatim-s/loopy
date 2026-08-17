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
import type {
  AttemptStatus,
  RunStatus,
  Storage,
  ApprovalRecord as StoredApproval,
} from "./storage.js";

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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Runtime event is missing ${label}`);
  return value;
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
          workflowId: stableId(requiredString(source.workflowId, "workflowId")),
          workflowVersion: Number(source.workflowVersion ?? 1),
        },
      };
      break;
    case "run.started":
      canonical = {
        ...base,
        type: event.type,
        payload: { planHash: requiredString(source.planHash, "planHash") },
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

export class RuntimeStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeStoreConflictError";
  }
}

export interface CompareAndSetRunStatusInput {
  runId: string;
  expectedStatus: RunStatus;
  nextStatus: RunStatus;
  error?: string;
  /** Terminal recovery is an explicit seam; ordinary transitions remain strict. */
  allowTerminalRecovery?: boolean;
}

export interface CompareAndSetAttemptStatusInput {
  attemptId: string;
  expectedStatus: AttemptStatus;
  nextStatus: AttemptStatus;
  error?: string;
}

export interface ResolveApprovalAtomicallyInput {
  runId: string;
  nodeId: string;
  decision: "approved" | "rejected";
  expectedApprovalStatus?: "pending";
  attemptStatus?: "succeeded" | "failed" | "cancelled";
  runStatus?: RunStatus;
  expectedRunStatus?: RunStatus;
  resolvedBy?: string;
}

export interface ResolveApprovalAtomicallyResult {
  approval: StoredApproval;
  attempt?: RuntimeAttempt;
  run?: RuntimeRun;
}

function runFromRow(row: Row): RuntimeRun {
  const runtime = decode<RuntimeRun>(row.runtime_json as string | null);
  if (runtime) return runtime;
  return {
    runId: row.id as string,
    workflowId: row.workflow_id as string,
    workflowVersion: row.workflow_version as number,
    plan: (decode<JsonObject>(row.plan_json as string) ?? {}) as RuntimeRun["plan"],
    executionPlanHash: row.plan_hash as string | undefined,
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
      this.validate(commands);
      for (const command of commands) this.apply(command);
    })();
  }

  private validate(commands: readonly RuntimeStoreCommand[]): void {
    const createdRunIds = new Set(
      commands
        .filter(
          (command): command is Extract<RuntimeStoreCommand, { type: "create_run" }> =>
            command.type === "create_run",
        )
        .map((command) => command.run.runId),
    );
    for (const command of commands) {
      if (command.type === "create_run") {
        if (this.db.query("SELECT 1 FROM runs WHERE id=?").get(command.run.runId))
          throw new Error(`Duplicate run ${command.run.runId}`);
        continue;
      }
      if (command.type === "set_run") {
        const row = this.db
          .query<Row, [string]>("SELECT * FROM runs WHERE id=?")
          .get(command.runId);
        if (!row) throw new Error(`Unknown run ${command.runId}`);
        const current = row.status as RunStatus;
        if (command.expectedStatus && current !== command.expectedStatus)
          throw new RuntimeStoreConflictError(
            `Run ${command.runId} changed from ${command.expectedStatus} to ${current}`,
          );
        if (command.patch.status) {
          const terminalRecovery =
            command.allowTerminalRecovery === true &&
            (current === "failed" || current === "cancelled") &&
            command.patch.status === "running";
          if (!legal(RUN_TRANSITIONS, current, command.patch.status) && !terminalRecovery)
            throw new Error(`Illegal run transition ${current} -> ${command.patch.status}`);
        }
        continue;
      }
      if (command.type === "create_attempt") {
        const attempt = command.attempt;
        if (this.db.query("SELECT 1 FROM node_attempts WHERE id=?").get(attempt.attemptId))
          throw new Error(`Duplicate attempt ${attempt.attemptId}`);
        const run = this.db
          .query<Row, [string]>("SELECT * FROM runs WHERE id=?")
          .get(attempt.runId);
        const createdRun = commands.find(
          (item): item is Extract<RuntimeStoreCommand, { type: "create_run" }> =>
            item.type === "create_run" && item.run.runId === attempt.runId,
        )?.run;
        if (!run && !createdRun) throw new Error(`Unknown run ${attempt.runId}`);
        const runStatus = run?.status ?? createdRun?.status;
        if (command.expectedRunStatus && runStatus !== command.expectedRunStatus)
          throw new RuntimeStoreConflictError(
            `Attempt run precondition failed for ${attempt.runId}: expected ${command.expectedRunStatus}, got ${String(runStatus)}`,
          );
        continue;
      }
      if (command.type === "set_attempt") {
        const row = this.db
          .query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?")
          .get(command.attemptId);
        if (!row) throw new Error(`Unknown attempt ${command.attemptId}`);
        const current = row.status as AttemptStatus;
        if (command.expectedStatus && current !== command.expectedStatus)
          throw new RuntimeStoreConflictError(
            `Attempt ${command.attemptId} changed from ${command.expectedStatus} to ${current}`,
          );
        const run = this.db
          .query<Row, [string]>("SELECT * FROM runs WHERE id=?")
          .get(row.run_id as string);
        if (command.expectedRunStatus && (!run || run.status !== command.expectedRunStatus))
          throw new RuntimeStoreConflictError(
            `Attempt run precondition failed for ${command.attemptId}`,
          );
        if (command.patch.status && !legal(ATTEMPT_TRANSITIONS, current, command.patch.status))
          throw new Error(`Illegal attempt transition ${current} -> ${command.patch.status}`);
        continue;
      }
      if (command.type === "resolve_approval") {
        const row = this.db
          .query<Row, [string, string]>(
            "SELECT * FROM approvals WHERE run_id=? AND node_id=? ORDER BY requested_at DESC LIMIT 1",
          )
          .get(command.runId, command.nodeId);
        if (!row) throw new Error(`Unknown approval ${command.runId}/${command.nodeId}`);
        if (command.expectedDecision === "pending" && row.status !== "pending")
          throw new RuntimeStoreConflictError(
            `Approval ${command.runId}/${command.nodeId} is already ${String(row.status)}`,
          );
        const run = this.db
          .query<Row, [string]>("SELECT * FROM runs WHERE id=?")
          .get(command.runId);
        if (!run) throw new Error(`Unknown run ${command.runId}`);
        if (command.expectedRunStatus && run.status !== command.expectedRunStatus)
          throw new RuntimeStoreConflictError(
            `Approval run precondition failed for ${command.runId}`,
          );
        const persistedAttemptId = row.attempt_id as string | undefined;
        if (command.attemptId && command.attemptId !== persistedAttemptId)
          throw new RuntimeStoreConflictError(
            `Approval attempt precondition failed for ${command.runId}/${command.nodeId}`,
          );
        if (command.expectedAttemptStatus) {
          const attemptId = command.attemptId ?? persistedAttemptId;
          const attempt = attemptId
            ? this.db.query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?").get(attemptId)
            : undefined;
          if (!attempt || attempt.status !== command.expectedAttemptStatus)
            throw new RuntimeStoreConflictError(
              `Approval attempt precondition failed for ${command.runId}/${command.nodeId}`,
            );
        }
        continue;
      }
      if (command.type === "append_event") {
        if (
          !createdRunIds.has(command.event.runId) &&
          !this.db.query("SELECT 1 FROM runs WHERE id=?").get(command.event.runId)
        )
          throw new Error(`Unknown run ${command.event.runId}`);
        // Validate metadata before any sibling command can be persisted.
        const max =
          this.db
            .query<{ maxSequence: number | null }, [string]>(
              "SELECT MAX(sequence) maxSequence FROM events WHERE run_id=?",
            )
            .get(command.event.runId)?.maxSequence ?? -1;
        toTraceEvent(command.event, max + 1);
      }
    }
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
            run.executionPlanHash ?? null,
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
          "UPDATE runs SET status=?,input_json=?,plan_hash=?,created_at=?,updated_at=?,plan_json=?,runtime_json=? WHERE id=?",
          [
            next.status,
            encode(next.inputs),
            next.executionPlanHash ?? null,
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
          "INSERT INTO approvals(id,run_id,node_id,attempt_id,approval_key,message,status,requested_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,approval_key) DO UPDATE SET node_id=excluded.node_id,attempt_id=excluded.attempt_id,status=excluded.status,message=excluded.message,resolved_at=NULL,resolved_by=NULL",
          [
            stableId(`${approval.runId}:${approval.nodeId}:approval`),
            approval.runId,
            approval.nodeId,
            approval.attemptId,
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
        {
          const approval = this.db
            .query<Row, [string, string]>(
              "SELECT * FROM approvals WHERE run_id=? AND node_id=? ORDER BY requested_at DESC LIMIT 1",
            )
            .get(command.runId, command.nodeId);
          if (!approval) throw new Error(`Unknown approval ${command.runId}/${command.nodeId}`);
          if (command.attemptId && approval.attempt_id !== command.attemptId)
            throw new RuntimeStoreConflictError(
              `Approval attempt precondition failed for ${command.runId}/${command.nodeId}`,
            );
          const result = this.db.run(
            "UPDATE approvals SET status=?,resolved_at=?,resolved_by=? WHERE run_id=? AND node_id=? AND status='pending' AND (? IS NULL OR attempt_id=?)",
            [
              command.decision,
              new Date().toISOString(),
              "runtime",
              command.runId,
              command.nodeId,
              command.attemptId ?? null,
              command.attemptId ?? null,
            ],
          );
          if (result.changes === 0)
            throw new RuntimeStoreConflictError(
              `Approval ${command.runId}/${command.nodeId} is missing or already resolved`,
            );
        }
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

  /**
   * Compare-and-set repository primitives for the runtime's next intent shape.
   * These deliberately do not alter RuntimeStoreCommand: approval resolution and
   * terminal retry/recovery can use them as one-transaction seams while the
   * scheduler command contract evolves.
   */
  compareAndSetRunStatus(input: CompareAndSetRunStatusInput): RuntimeRun {
    return this.db.transaction(() => {
      const row = this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(input.runId);
      if (!row) throw new Error(`Unknown run ${input.runId}`);
      const current = row.status as RunStatus;
      if (current !== input.expectedStatus)
        throw new RuntimeStoreConflictError(
          `Run ${input.runId} changed from ${input.expectedStatus} to ${current}`,
        );
      const terminalRecovery =
        input.allowTerminalRecovery === true &&
        (current === "failed" || current === "cancelled") &&
        input.nextStatus === "running";
      if (!legal(RUN_TRANSITIONS, current, input.nextStatus) && !terminalRecovery)
        throw new Error(`Illegal run transition ${current} -> ${input.nextStatus}`);
      this.db.run("UPDATE runs SET status=?,updated_at=? WHERE id=? AND status=?", [
        input.nextStatus,
        new Date().toISOString(),
        input.runId,
        input.expectedStatus,
      ]);
      return runFromRow(
        this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(input.runId) as Row,
      );
    })();
  }

  compareAndSetAttemptStatus(input: CompareAndSetAttemptStatusInput): RuntimeAttempt {
    return this.db.transaction(() => {
      const row = this.db
        .query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?")
        .get(input.attemptId);
      if (!row) throw new Error(`Unknown attempt ${input.attemptId}`);
      const current = row.status as AttemptStatus;
      if (current !== input.expectedStatus)
        throw new RuntimeStoreConflictError(
          `Attempt ${input.attemptId} changed from ${input.expectedStatus} to ${current}`,
        );
      if (!legal(ATTEMPT_TRANSITIONS, current, input.nextStatus))
        throw new Error(`Illegal attempt transition ${current} -> ${input.nextStatus}`);
      const ended = ["succeeded", "failed", "cancelled", "skipped"].includes(input.nextStatus)
        ? new Date().toISOString()
        : null;
      this.db.run(
        "UPDATE node_attempts SET status=?,error=?,finished_at=?,updated_at=? WHERE id=? AND status=?",
        [
          input.nextStatus,
          input.error ?? null,
          ended,
          new Date().toISOString(),
          input.attemptId,
          input.expectedStatus,
        ],
      );
      return attemptFromRow(
        this.db
          .query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?")
          .get(input.attemptId) as Row,
      );
    })();
  }

  /** Resolve an approval and optional attempt/run transitions in one SQLite transaction. */
  resolveApprovalAtomically(
    input: ResolveApprovalAtomicallyInput,
  ): ResolveApprovalAtomicallyResult {
    return this.db.transaction(() => {
      const row = this.db
        .query<Row, [string, string]>(
          "SELECT * FROM approvals WHERE run_id=? AND node_id=? ORDER BY requested_at DESC LIMIT 1",
        )
        .get(input.runId, input.nodeId);
      if (!row) throw new Error(`Unknown approval ${input.runId}/${input.nodeId}`);
      if ((input.expectedApprovalStatus ?? "pending") !== row.status)
        throw new RuntimeStoreConflictError(
          `Approval ${input.runId}/${input.nodeId} is already ${String(row.status)}`,
        );
      const run = this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(input.runId);
      if (!run) throw new Error(`Unknown run ${input.runId}`);
      if (input.expectedRunStatus && run.status !== input.expectedRunStatus)
        throw new RuntimeStoreConflictError(
          `Run ${input.runId} changed from ${input.expectedRunStatus} to ${String(run.status)}`,
        );
      const now = new Date().toISOString();
      const updated = this.db.run(
        "UPDATE approvals SET status=?,resolved_at=?,resolved_by=? WHERE id=? AND status='pending'",
        [input.decision, now, input.resolvedBy ?? "runtime", row.id as string],
      );
      if (updated.changes !== 1)
        throw new RuntimeStoreConflictError(`Approval ${String(row.id)} was resolved concurrently`);

      let attempt: RuntimeAttempt | undefined;
      const attemptId = row.attempt_id as string | undefined;
      if (input.attemptStatus) {
        if (!attemptId) throw new Error(`Approval ${String(row.id)} has no attemptId`);
        const attemptRow = this.db
          .query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?")
          .get(attemptId);
        if (!attemptRow) throw new Error(`Unknown approval attempt ${attemptId}`);
        if (!legal(ATTEMPT_TRANSITIONS, attemptRow.status as string, input.attemptStatus))
          throw new Error(
            `Illegal attempt transition ${String(attemptRow.status)} -> ${input.attemptStatus}`,
          );
        this.db.run(
          "UPDATE node_attempts SET status=?,error=?,finished_at=?,updated_at=? WHERE id=?",
          [
            input.attemptStatus,
            input.decision === "rejected" ? "Approval rejected" : null,
            now,
            now,
            attemptId,
          ],
        );
        attempt = attemptFromRow(
          this.db
            .query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?")
            .get(attemptId) as Row,
        );
      }
      let nextRun: RuntimeRun | undefined;
      if (input.runStatus) {
        const current = run.status as RunStatus;
        if (!legal(RUN_TRANSITIONS, current, input.runStatus))
          throw new Error(`Illegal run transition ${current} -> ${input.runStatus}`);
        this.db.run("UPDATE runs SET status=?,updated_at=? WHERE id=?", [
          input.runStatus,
          now,
          input.runId,
        ]);
        nextRun = runFromRow(
          this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(input.runId) as Row,
        );
      }
      return {
        approval: {
          id: row.id as string,
          runId: row.run_id as string,
          nodeId: row.node_id as string | undefined,
          attemptId,
          approvalKey: row.approval_key as string,
          message: row.message as string,
          status: input.decision,
          requestedAt: row.requested_at as string,
          resolvedAt: now,
          resolvedBy: input.resolvedBy ?? "runtime",
        },
        attempt,
        run: nextRun,
      };
    })();
  }

  /** Return the statuses that can be safely cancelled during recovery. */
  async listCancellableAttempts(runId: string): Promise<RuntimeAttempt[]> {
    return (
      this.db
        .query<Row, [string]>(
          "SELECT * FROM node_attempts WHERE run_id=? AND status IN ('pending','ready','running') ORDER BY node_id,attempt",
        )
        .all(runId) as Row[]
    ).map(attemptFromRow);
  }

  /** Complete a cancelling run and cancel only legal pending/ready/running attempts atomically. */
  recoverCancellingRun(runId: string, reason = "cancelled during recovery"): RuntimeRun {
    return this.db.transaction(() => {
      const run = this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      if (run.status !== "cancelling")
        throw new RuntimeStoreConflictError(
          `Run ${runId} is ${String(run.status)}, not cancelling`,
        );
      const now = new Date().toISOString();
      this.db.run(
        "UPDATE node_attempts SET status='cancelled',error=?,finished_at=?,updated_at=? WHERE run_id=? AND status IN ('pending','ready','running')",
        [reason, now, now, runId],
      );
      this.db.run(
        "UPDATE runs SET status='cancelled',updated_at=? WHERE id=? AND status='cancelling'",
        [now, runId],
      );
      return runFromRow(
        this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(runId) as Row,
      );
    })();
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
          // v1 approvals legitimately have no attemptId; new records round-trip
          // the persisted FK and keep the runtime contract explicit for them.
          attemptId: (row.attempt_id as string | undefined) ?? "",
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
    this.appendTraceEvents([event], runId);
  }

  /** Validate all identities and database conflicts before writing a canonical trace batch. */
  appendTraceEvents(events: readonly TraceEvent[], expectedRunId?: string): void {
    if (events.length === 0) throw new Error("Cannot import an empty trace");
    const validated = events.map((event) => TraceEventSchema.parse(event));
    const runIds = new Set(validated.map((event) => event.runId));
    if (runIds.size !== 1) throw new Error("Trace contains multiple run IDs");
    const runId = expectedRunId ?? validated[0]?.runId;
    if (!runId) throw new Error("Trace is missing a run ID");
    const eventIds = new Set<string>();
    const sequences = new Set<number>();
    for (const event of validated) {
      if (!eventIds.add(event.id))
        throw new Error(`Trace event ID ${event.id} appears more than once`);
      if (!sequences.add(event.sequence))
        throw new Error(`Trace sequence ${event.sequence} appears more than once`);
    }

    this.db.transaction(() => {
      const existingRun = this.db.query("SELECT 1 FROM runs WHERE id=?").get(runId);
      const created = validated.find((event) => event.type === "run.created");
      if (!existingRun && !created)
        throw new Error(
          `Cannot import trace for unknown run ${runId}; a run.created event with workflowId is required`,
        );
      if (!existingRun && created) {
        const workflowId = requiredString(created.payload.workflowId, "workflowId");
        const workflowVersion = Number(created.payload.workflowVersion);
        this.db.run(
          "INSERT OR IGNORE INTO workflow_versions(workflow_id,version,definition_json,created_at) VALUES (?,?,?,?)",
          [
            workflowId,
            workflowVersion,
            encode({ id: workflowId, workflowVersion }),
            created.occurredAt,
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
            created.occurredAt,
            created.occurredAt,
            "{}",
          ],
        );
      }
      for (const event of validated) {
        if (this.db.query("SELECT 1 FROM events WHERE id=?").get(event.id))
          throw new Error(`Trace event ${event.id} already exists`);
        if (
          this.db
            .query("SELECT 1 FROM events WHERE run_id=? AND sequence=?")
            .get(runId, event.sequence)
        )
          throw new Error(`Trace sequence ${event.sequence} already exists for run ${runId}`);
      }
      for (const event of validated) this.appendTraceEventInternal(runId, event);
    })();
  }

  private appendTraceEventInternal(runId: string, event: TraceEvent): void {
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
  }
}

export function createSqliteRuntimeStore(storage: Storage): SqliteRuntimeStore {
  return new SqliteRuntimeStore(storage);
}
