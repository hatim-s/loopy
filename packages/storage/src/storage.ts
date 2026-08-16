import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type {
  ArtifactRef,
  JsonObject,
  JsonValue,
  ProviderInstallation,
  TraceEvent,
  WorkflowDefinition,
} from "@loopy/contracts";

export const STORAGE_DIR = ".loopy";
export const DATABASE_FILENAME = "loopy.db";
export const LOCK_FILENAME = "loopy.lock";
export const CURRENT_MIGRATION = 2;

export type RunStatus =
  | "created"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancelling"
  | "blocked_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type AttemptStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "blocked_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "interrupted";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ExtractionJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface StorageOptions {
  projectDir: string;
  readOnly?: boolean;
  acquireLock?: boolean;
  staleLockAfterMs?: number;
  busyTimeoutMs?: number;
}
export interface LockOwner {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
  command?: string;
}
export class ProjectLockError extends Error {
  constructor(
    message: string,
    readonly owner: LockOwner | undefined,
    readonly live: boolean,
  ) {
    super(message);
    this.name = "ProjectLockError";
  }
}

function readLock(path: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      typeof value.pid !== "number" ||
      typeof value.host !== "string" ||
      typeof value.token !== "string" ||
      typeof value.acquiredAt !== "string"
    )
      return undefined;
    return {
      pid: value.pid,
      host: value.host,
      token: value.token,
      acquiredAt: value.acquiredAt,
      command: typeof value.command === "string" ? value.command : undefined,
    };
  } catch {
    return undefined;
  }
}
function ownerLive(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
class ProjectLock {
  private released = false;
  private constructor(
    readonly path: string,
    readonly owner: LockOwner,
  ) {}
  static acquire(path: string, staleAfterMs = 86_400_000): ProjectLock {
    mkdirSync(resolve(path, ".."), { recursive: true });
    const owner: LockOwner = {
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
      command: process.argv.join(" ").slice(0, 500),
    };
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify(owner));
      } finally {
        closeSync(fd);
      }
      return new ProjectLock(path, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readLock(path);
      const live = current ? ownerLive(current) : false;
      const age = current ? Date.now() - Date.parse(current.acquiredAt) : 0;
      const stale = !live && (!current || !Number.isFinite(age) || age >= staleAfterMs);
      const detail = current
        ? `pid=${current.pid} host=${current.host} acquiredAt=${current.acquiredAt}`
        : "owner metadata unavailable";
      throw new ProjectLockError(
        stale
          ? `Project lock is stale but will not be removed automatically (${detail}). Inspect and remove ${path}.`
          : `Project is already locked by a live owner (${detail}).`,
        current,
        live,
      );
    }
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    if (readLock(this.path)?.token !== this.owner.token) return;
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const MIGRATIONS: readonly [number, string][] = [
  [
    1,
    `
CREATE TABLE IF NOT EXISTS workflow_versions (workflow_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), definition_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workflow_id, version));
CREATE TABLE IF NOT EXISTS imported_sessions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, source TEXT NOT NULL, session_json TEXT NOT NULL, imported_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS extraction_jobs (id TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES imported_sessions(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')), input_json TEXT NOT NULL DEFAULT '{}', output_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('created','running','pause_requested','paused','cancelling','blocked_approval','succeeded','failed','cancelled')), input_json TEXT NOT NULL DEFAULT '{}', plan_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, plan_json TEXT NOT NULL DEFAULT '{}', runtime_json TEXT, FOREIGN KEY(workflow_id, workflow_version) REFERENCES workflow_versions(workflow_id, version));
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, updated_at);
CREATE TABLE IF NOT EXISTS node_attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','ready','running','blocked','blocked_approval','succeeded','failed','cancelled','skipped','interrupted')), input_json TEXT, output_json TEXT, error TEXT, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL, runtime_json TEXT, UNIQUE(run_id,node_id,attempt));
CREATE INDEX IF NOT EXISTS attempts_recovery_idx ON node_attempts(status, updated_at);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL CHECK(sequence >= 0), type TEXT NOT NULL, payload_json TEXT NOT NULL, node_id TEXT, attempt_id TEXT REFERENCES node_attempts(id) ON DELETE SET NULL, provider TEXT, session_id TEXT, tool_call_id TEXT, occurred_at TEXT NOT NULL, monotonic_offset_ms REAL NOT NULL DEFAULT 0 CHECK(monotonic_offset_ms >= 0), trace_json TEXT, UNIQUE(run_id,sequence));
CREATE INDEX IF NOT EXISTS events_run_sequence_idx ON events(run_id,sequence);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, node_id TEXT, approval_key TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), requested_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, UNIQUE(run_id,approval_key));
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, sha256 TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), producer_node_id TEXT, source_path TEXT, redacted INTEGER NOT NULL DEFAULT 0 CHECK(redacted IN (0,1)), recorded_at TEXT NOT NULL, UNIQUE(run_id,sha256));
CREATE TABLE IF NOT EXISTS provider_installations (provider TEXT PRIMARY KEY, installation_json TEXT NOT NULL, detected_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
`,
  ],
  [
    2,
    "ALTER TABLE approvals ADD COLUMN attempt_id TEXT REFERENCES node_attempts(id) ON DELETE SET NULL;",
  ],
];

function applyMigrations(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (
      db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all() as {
        version: number;
      }[]
    ).map((r) => r.version),
  );
  for (const [version, sql] of MIGRATIONS)
    if (!applied.has(version))
      db.transaction(() => {
        db.run(sql);
        db.run("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)", [
          version,
          new Date().toISOString(),
        ]);
      })();
}
const timestamp = () => new Date().toISOString();
const encode = (value: unknown) => JSON.stringify(value ?? {});
const decode = <T>(value: string | null | undefined): T | undefined =>
  value == null ? undefined : (JSON.parse(value) as T);
const must = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
};
type Row = Record<string, unknown>;

export interface WorkflowVersionRecord {
  workflowId: string;
  version: number;
  definition: WorkflowDefinition | JsonObject;
  createdAt: string;
}
export interface ImportedSessionRecord {
  id: string;
  provider: string;
  source: string;
  session: JsonValue;
  importedAt: string;
}
export interface ExtractionJobRecord {
  id: string;
  importId: string;
  status: ExtractionJobStatus;
  input: JsonObject;
  output?: JsonValue;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface RunRecord {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  input: JsonObject;
  planHash?: string;
  createdAt: string;
  updatedAt: string;
}
export interface AttemptRecord {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: AttemptStatus;
  input?: JsonValue;
  output?: JsonValue;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}
export interface EventRecord {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: JsonValue;
  nodeId?: string;
  attemptId?: string;
  provider?: string;
  sessionId?: string;
  toolCallId?: string;
  occurredAt: string;
  monotonicOffsetMs: number;
}
export interface ApprovalRecord {
  id: string;
  runId: string;
  nodeId?: string;
  attemptId?: string;
  approvalKey: string;
  message: string;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}
export interface ArtifactRecord extends ArtifactRef {
  runId: string;
  recordedAt: string;
}
export interface ProviderInstallationRecord {
  provider: string;
  installation: ProviderInstallation | JsonObject;
  detectedAt: string;
}
export interface CreateRunInput {
  id?: string;
  workflowId: string;
  workflowVersion: number;
  input?: JsonObject;
  planHash?: string;
  status?: RunStatus;
  createdAt?: string;
}
export interface CreateAttemptInput {
  id?: string;
  runId: string;
  nodeId: string;
  attempt?: number;
  status?: AttemptStatus;
  input?: JsonValue;
}
export interface AppendEventInput {
  id?: string;
  type: string;
  payload?: JsonValue;
  sequence?: number;
  nodeId?: string;
  attemptId?: string;
  provider?: string;
  sessionId?: string;
  toolCallId?: string;
  occurredAt?: string;
  monotonicOffsetMs?: number;
}

const asWorkflow = (r: Row): WorkflowVersionRecord => ({
  workflowId: r.workflow_id as string,
  version: r.version as number,
  definition: must(decode(r.definition_json as string), "workflow definition"),
  createdAt: r.created_at as string,
});
const asRun = (r: Row): RunRecord => ({
  id: r.id as string,
  workflowId: r.workflow_id as string,
  workflowVersion: r.workflow_version as number,
  status: r.status as RunStatus,
  input: decode(r.input_json as string) as JsonObject,
  planHash: r.plan_hash as string | undefined,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});
const asAttempt = (r: Row): AttemptRecord => ({
  id: r.id as string,
  runId: r.run_id as string,
  nodeId: r.node_id as string,
  attempt: r.attempt as number,
  status: r.status as AttemptStatus,
  input: decode(r.input_json as string | null),
  output: decode(r.output_json as string | null),
  error: r.error as string | undefined,
  startedAt: r.started_at as string | undefined,
  finishedAt: r.finished_at as string | undefined,
  updatedAt: r.updated_at as string,
});
const asEvent = (r: Row): EventRecord => ({
  id: r.id as string,
  runId: r.run_id as string,
  sequence: r.sequence as number,
  type: r.type as string,
  payload: must(decode(r.payload_json as string), "event payload"),
  nodeId: r.node_id as string | undefined,
  attemptId: r.attempt_id as string | undefined,
  provider: r.provider as string | undefined,
  sessionId: r.session_id as string | undefined,
  toolCallId: r.tool_call_id as string | undefined,
  occurredAt: r.occurred_at as string,
  monotonicOffsetMs: r.monotonic_offset_ms as number,
});
const approval = (r: Row): ApprovalRecord => ({
  id: r.id as string,
  runId: r.run_id as string,
  nodeId: r.node_id as string | undefined,
  attemptId: r.attempt_id as string | undefined,
  approvalKey: r.approval_key as string,
  message: r.message as string,
  status: r.status as ApprovalStatus,
  requestedAt: r.requested_at as string,
  resolvedAt: r.resolved_at as string | undefined,
  resolvedBy: r.resolved_by as string | undefined,
});
const artifact = (r: Row): ArtifactRecord => ({
  id: r.id as string,
  runId: r.run_id as string,
  sha256: r.sha256 as string,
  mediaType: r.media_type as string,
  sizeBytes: r.size_bytes as number,
  producerNodeId: r.producer_node_id as string | undefined,
  sourcePath: r.source_path as string | undefined,
  redacted: Boolean(r.redacted),
  recordedAt: r.recorded_at as string,
});

export class RuntimeRepository {
  constructor(private readonly db: Database) {}
  private run(sql: string, ...bindings: unknown[]): void {
    this.db.run(sql, bindings as never);
  }
  createWorkflowVersion(input: {
    workflowId?: string;
    version?: number;
    definition: WorkflowDefinition | JsonObject;
    createdAt?: string;
  }): WorkflowVersionRecord {
    const d = input.definition as Record<string, unknown>;
    const workflowId = input.workflowId ?? (d.id as string);
    const version = input.version ?? (d.workflowVersion as number);
    if (!workflowId || !Number.isInteger(version) || version < 1)
      throw new Error("workflowId and positive version are required");
    this.run(
      "INSERT INTO workflow_versions(workflow_id,version,definition_json,created_at) VALUES (?,?,?,?)",
      workflowId,
      version,
      encode(input.definition),
      input.createdAt ?? timestamp(),
    );
    return must(this.getWorkflowVersion(workflowId, version), "workflow version");
  }
  getWorkflowVersion(workflowId: string, version: number): WorkflowVersionRecord | undefined {
    const r = this.db
      .query<Row, [string, number]>(
        "SELECT * FROM workflow_versions WHERE workflow_id=? AND version=?",
      )
      .get(workflowId, version);
    return r ? asWorkflow(r) : undefined;
  }
  listWorkflowVersions(workflowId?: string): WorkflowVersionRecord[] {
    const rows = workflowId
      ? this.db
          .query<Row, [string]>(
            "SELECT * FROM workflow_versions WHERE workflow_id=? ORDER BY version",
          )
          .all(workflowId)
      : this.db
          .query<Row, []>("SELECT * FROM workflow_versions ORDER BY workflow_id,version")
          .all();
    return rows.map(asWorkflow);
  }

  createImportedSession(input: {
    id?: string;
    provider: string;
    source: string;
    session: JsonValue;
    importedAt?: string;
  }): ImportedSessionRecord {
    const id = input.id ?? randomUUID();
    this.run(
      "INSERT INTO imported_sessions(id,provider,source,session_json,imported_at) VALUES (?,?,?,?,?)",
      id,
      input.provider,
      input.source,
      encode(input.session),
      input.importedAt ?? timestamp(),
    );
    return must(this.getImportedSession(id), "imported session");
  }
  getImportedSession(id: string): ImportedSessionRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM imported_sessions WHERE id=?").get(id);
    return r
      ? {
          id: r.id as string,
          provider: r.provider as string,
          source: r.source as string,
          session: must(decode(r.session_json as string), "imported session payload"),
          importedAt: r.imported_at as string,
        }
      : undefined;
  }
  createExtractionJob(input: {
    id?: string;
    importId: string;
    status?: ExtractionJobStatus;
    input?: JsonObject;
  }): ExtractionJobRecord {
    const id = input.id ?? randomUUID();
    const at = timestamp();
    this.run(
      "INSERT INTO extraction_jobs(id,import_id,status,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      id,
      input.importId,
      input.status ?? "queued",
      encode(input.input),
      at,
      at,
    );
    return must(this.getExtractionJob(id), "extraction job");
  }
  getExtractionJob(id: string): ExtractionJobRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM extraction_jobs WHERE id=?").get(id);
    return r
      ? {
          id: r.id as string,
          importId: r.import_id as string,
          status: r.status as ExtractionJobStatus,
          input: decode(r.input_json as string) as JsonObject,
          output: decode(r.output_json as string | null),
          error: r.error as string | undefined,
          createdAt: r.created_at as string,
          updatedAt: r.updated_at as string,
        }
      : undefined;
  }
  transitionExtractionJob(
    id: string,
    status: ExtractionJobStatus,
    output?: JsonValue,
    error?: string,
  ): ExtractionJobRecord {
    this.run(
      "UPDATE extraction_jobs SET status=?,output_json=?,error=?,updated_at=? WHERE id=?",
      status,
      output === undefined ? null : encode(output),
      error ?? null,
      timestamp(),
      id,
    );
    return (
      this.getExtractionJob(id) ??
      (() => {
        throw new Error(`Unknown extraction job ${id}`);
      })()
    );
  }

  createRun(input: CreateRunInput): RunRecord {
    const id = input.id ?? randomUUID();
    const at = input.createdAt ?? timestamp();
    return this.db.transaction(() => {
      this.run(
        "INSERT INTO runs(id,workflow_id,workflow_version,status,input_json,plan_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        id,
        input.workflowId,
        input.workflowVersion,
        input.status ?? "created",
        encode(input.input),
        input.planHash ?? null,
        at,
        at,
      );
      this.appendEventInternal(id, {
        type: "run.created",
        payload: { workflowId: input.workflowId, workflowVersion: input.workflowVersion },
        occurredAt: at,
      });
      return must(this.getRun(id), "run");
    })();
  }
  getRun(id: string): RunRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(id);
    return r ? asRun(r) : undefined;
  }
  listRuns(status?: RunStatus): RunRecord[] {
    const rows = status
      ? this.db
          .query<Row, [string]>("SELECT * FROM runs WHERE status=? ORDER BY created_at,id")
          .all(status)
      : this.db.query<Row, []>("SELECT * FROM runs ORDER BY created_at,id").all();
    return rows.map(asRun);
  }
  transitionRun(id: string, status: RunStatus, eventInput?: AppendEventInput): RunRecord {
    return this.db.transaction(() => {
      const c = this.db.run("UPDATE runs SET status=?,updated_at=? WHERE id=?", [
        status,
        timestamp(),
        id,
      ]);
      if (c.changes === 0) throw new Error(`Unknown run ${id}`);
      if (eventInput) this.appendEventInternal(id, eventInput);
      return must(this.getRun(id), "run");
    })();
  }

  createAttempt(input: CreateAttemptInput): AttemptRecord {
    const id = input.id ?? randomUUID();
    const row = this.db
      .query<{ maxAttempt: number | null }, [string, string]>(
        "SELECT MAX(attempt) maxAttempt FROM node_attempts WHERE run_id=? AND node_id=?",
      )
      .get(input.runId, input.nodeId);
    const n = input.attempt ?? (row?.maxAttempt ?? 0) + 1;
    const at = timestamp();
    return this.db.transaction(() => {
      this.run(
        "INSERT INTO node_attempts(id,run_id,node_id,attempt,status,input_json,updated_at) VALUES (?,?,?,?,?,?,?)",
        id,
        input.runId,
        input.nodeId,
        n,
        input.status ?? "ready",
        input.input === undefined ? null : encode(input.input),
        at,
      );
      this.appendEventInternal(input.runId, {
        type: "attempt.created",
        payload: { attempt: n },
        nodeId: input.nodeId,
        attemptId: id,
        occurredAt: at,
      });
      return must(this.getAttempt(id), "attempt");
    })();
  }
  getAttempt(id: string): AttemptRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM node_attempts WHERE id=?").get(id);
    return r ? asAttempt(r) : undefined;
  }
  listAttempts(runId?: string, status?: AttemptStatus): AttemptRecord[] {
    let rows: Row[];
    if (runId && status)
      rows = this.db
        .query<Row, [string, string]>(
          "SELECT * FROM node_attempts WHERE run_id=? AND status=? ORDER BY node_id,attempt",
        )
        .all(runId, status);
    else if (runId)
      rows = this.db
        .query<Row, [string]>("SELECT * FROM node_attempts WHERE run_id=? ORDER BY node_id,attempt")
        .all(runId);
    else if (status)
      rows = this.db
        .query<Row, [string]>("SELECT * FROM node_attempts WHERE status=? ORDER BY updated_at,id")
        .all(status);
    else rows = this.db.query<Row, []>("SELECT * FROM node_attempts ORDER BY updated_at,id").all();
    return rows.map(asAttempt);
  }
  transitionAttempt(
    id: string,
    status: AttemptStatus,
    patch: { output?: JsonValue; error?: string } = {},
    eventInput?: AppendEventInput,
  ): AttemptRecord {
    return this.db.transaction(() => {
      const old = this.getAttempt(id);
      if (!old) throw new Error(`Unknown attempt ${id}`);
      const at = timestamp();
      const started = status === "running" && !old.startedAt ? at : old.startedAt;
      const finished = ["succeeded", "failed", "cancelled", "interrupted"].includes(status)
        ? at
        : old.finishedAt;
      this.run(
        "UPDATE node_attempts SET status=?,output_json=?,error=?,started_at=?,finished_at=?,updated_at=? WHERE id=?",
        status,
        patch.output === undefined
          ? old.output === undefined
            ? null
            : encode(old.output)
          : encode(patch.output),
        patch.error ?? old.error ?? null,
        started ?? null,
        finished ?? null,
        at,
        id,
      );
      if (eventInput)
        this.appendEventInternal(old.runId, {
          ...eventInput,
          nodeId: eventInput.nodeId ?? old.nodeId,
          attemptId: eventInput.attemptId ?? id,
        });
      return must(this.getAttempt(id), "attempt");
    })();
  }
  listRecoverableAttempts(): AttemptRecord[] {
    return this.listAttempts(undefined, "running");
  }
  recoverRunningAttempts(
    reason = "Runtime process was not present after restart.",
  ): AttemptRecord[] {
    return this.listRecoverableAttempts().map((a) =>
      this.transitionAttempt(
        a.id,
        "interrupted",
        { error: reason },
        { type: "runtime.recovery", payload: { action: "marked_failed", reason } },
      ),
    );
  }

  /** Attempts that can be cancelled safely while recovering a cancelling run. */
  listCancellableAttempts(runId: string): AttemptRecord[] {
    return (
      this.db
        .query<Row, [string]>(
          "SELECT * FROM node_attempts WHERE run_id=? AND status IN ('pending','ready','running') ORDER BY node_id,attempt",
        )
        .all(runId) as Row[]
    ).map(asAttempt);
  }

  /** Atomically finish a cancelling run using only legal terminal cancellation. */
  recoverCancellingRun(runId: string, reason = "cancelled during recovery"): RunRecord {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      if (run.status !== "cancelling")
        throw new Error(`Run ${runId} is ${run.status}, not cancelling`);
      const at = timestamp();
      this.run(
        "UPDATE node_attempts SET status='cancelled',error=?,finished_at=?,updated_at=? WHERE run_id=? AND status IN ('pending','ready','running')",
        reason,
        at,
        at,
        runId,
      );
      this.run(
        "UPDATE runs SET status='cancelled',updated_at=? WHERE id=? AND status='cancelling'",
        at,
        runId,
      );
      return must(this.getRun(runId), "run");
    })();
  }

  appendEvent(runId: string, input: AppendEventInput | TraceEvent): EventRecord {
    return this.db.transaction(() => this.appendEventInternal(runId, input))();
  }
  private appendEventInternal(runId: string, input: AppendEventInput | TraceEvent): EventRecord {
    const r = this.db
      .query<{ maxSequence: number | null }, [string]>(
        "SELECT MAX(sequence) maxSequence FROM events WHERE run_id=?",
      )
      .get(runId);
    const sequence = input.sequence ?? (r?.maxSequence ?? -1) + 1;
    const at = input.occurredAt ?? timestamp();
    const id = input.id ?? randomUUID();
    this.run(
      "INSERT INTO events(id,run_id,sequence,type,payload_json,node_id,attempt_id,provider,session_id,tool_call_id,occurred_at,monotonic_offset_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      runId,
      sequence,
      input.type,
      encode(input.payload),
      input.nodeId ?? null,
      input.attemptId ?? null,
      input.provider ?? null,
      input.sessionId ?? null,
      input.toolCallId ?? null,
      at,
      input.monotonicOffsetMs ?? 0,
    );
    return must(this.getEvent(runId, sequence), "event");
  }
  getEvent(runId: string, sequence: number): EventRecord | undefined {
    const r = this.db
      .query<Row, [string, number]>("SELECT * FROM events WHERE run_id=? AND sequence=?")
      .get(runId, sequence);
    return r ? asEvent(r) : undefined;
  }
  listEvents(
    runId: string,
    options: { afterSequence?: number; beforeSequence?: number; limit?: number } = {},
  ): EventRecord[] {
    const limit = Math.max(1, Math.min(1000, options.limit ?? 100));
    if (options.beforeSequence !== undefined)
      return (
        this.db
          .query<Row, [string, number, number]>(
            "SELECT * FROM events WHERE run_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
          )
          .all(runId, options.beforeSequence, limit) as Row[]
      )
        .map(asEvent)
        .reverse();
    return (
      this.db
        .query<Row, [string, number, number]>(
          "SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(runId, options.afterSequence ?? -1, limit) as Row[]
    ).map(asEvent);
  }
  countEvents(runId: string): number {
    return (
      this.db
        .query<{ count: number }, [string]>("SELECT COUNT(*) count FROM events WHERE run_id=?")
        .get(runId)?.count ?? 0
    );
  }

  recordApproval(input: {
    id?: string;
    runId: string;
    nodeId?: string;
    attemptId?: string;
    approvalKey: string;
    message: string;
    status?: ApprovalStatus;
  }): ApprovalRecord {
    const id = input.id ?? randomUUID();
    this.run(
      "INSERT INTO approvals(id,run_id,node_id,attempt_id,approval_key,message,status,requested_at) VALUES (?,?,?,?,?,?,?,?)",
      id,
      input.runId,
      input.nodeId ?? null,
      input.attemptId ?? null,
      input.approvalKey,
      input.message,
      input.status ?? "pending",
      timestamp(),
    );
    return must(this.getApproval(id), "approval");
  }
  getApproval(id: string): ApprovalRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM approvals WHERE id=?").get(id);
    return r ? approval(r) : undefined;
  }
  resolveApproval(id: string, status: "approved" | "rejected", resolvedBy: string): ApprovalRecord {
    this.run(
      "UPDATE approvals SET status=?,resolved_at=?,resolved_by=? WHERE id=?",
      status,
      timestamp(),
      resolvedBy,
      id,
    );
    return (
      this.getApproval(id) ??
      (() => {
        throw new Error(`Unknown approval ${id}`);
      })()
    );
  }
  listApprovals(runId: string, status?: ApprovalStatus): ApprovalRecord[] {
    const rows = status
      ? this.db
          .query<Row, [string, string]>(
            "SELECT * FROM approvals WHERE run_id=? AND status=? ORDER BY requested_at",
          )
          .all(runId, status)
      : this.db
          .query<Row, [string]>("SELECT * FROM approvals WHERE run_id=? ORDER BY requested_at")
          .all(runId);
    return rows.map(approval);
  }
  recordArtifact(input: ArtifactRef & { runId: string }): ArtifactRecord {
    this.run(
      "INSERT INTO artifacts(id,run_id,sha256,media_type,size_bytes,producer_node_id,source_path,redacted,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
      input.id,
      input.runId,
      input.sha256,
      input.mediaType,
      input.sizeBytes,
      input.producerNodeId ?? null,
      input.sourcePath ?? null,
      input.redacted ? 1 : 0,
      timestamp(),
    );
    return must(this.getArtifact(input.id), "artifact");
  }
  getArtifact(id: string): ArtifactRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM artifacts WHERE id=?").get(id);
    return r ? artifact(r) : undefined;
  }
  listArtifacts(runId: string): ArtifactRecord[] {
    return (
      this.db
        .query<Row, [string]>("SELECT * FROM artifacts WHERE run_id=? ORDER BY recorded_at,id")
        .all(runId) as Row[]
    ).map(artifact);
  }
  recordProviderInstallation(
    input: ProviderInstallation | ProviderInstallationRecord,
  ): ProviderInstallationRecord {
    const installation = "installation" in input ? input.installation : input;
    const provider = installation.provider as string;
    const detectedAt = "detectedAt" in input ? input.detectedAt : timestamp();
    this.run(
      "INSERT INTO provider_installations(provider,installation_json,detected_at) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET installation_json=excluded.installation_json,detected_at=excluded.detected_at",
      provider,
      encode(installation),
      detectedAt,
    );
    return must(this.getProviderInstallation(provider), "provider installation");
  }
  getProviderInstallation(provider: string): ProviderInstallationRecord | undefined {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM provider_installations WHERE provider=?")
      .get(provider);
    return r
      ? {
          provider: r.provider as string,
          installation: must(
            decode(r.installation_json as string),
            "provider installation payload",
          ),
          detectedAt: r.detected_at as string,
        }
      : undefined;
  }
  listProviderInstallations(): ProviderInstallationRecord[] {
    return (
      this.db
        .query<Row, []>("SELECT * FROM provider_installations ORDER BY provider")
        .all() as Row[]
    ).map((r) => ({
      provider: r.provider as string,
      installation: must(decode(r.installation_json as string), "provider installation payload"),
      detectedAt: r.detected_at as string,
    }));
  }
}

export class Storage {
  readonly projectDir: string;
  readonly databasePath: string;
  readonly lockPath: string;
  readonly db: Database;
  readonly runtime: RuntimeRepository;
  readonly repository: RuntimeRepository;
  private readonly lock?: ProjectLock;
  private closed = false;
  constructor(options: StorageOptions | string) {
    const config = typeof options === "string" ? { projectDir: options } : options;
    this.projectDir = resolve(config.projectDir);
    const dir = join(this.projectDir, STORAGE_DIR);
    this.databasePath = join(dir, DATABASE_FILENAME);
    this.lockPath = join(dir, LOCK_FILENAME);
    mkdirSync(dir, { recursive: true });
    let lock: ProjectLock | undefined;
    let db: Database | undefined;
    try {
      if (!config.readOnly && config.acquireLock !== false)
        lock = ProjectLock.acquire(this.lockPath, config.staleLockAfterMs);
      db = new Database(this.databasePath, {
        readonly: config.readOnly ?? false,
        create: !(config.readOnly ?? false),
      });
      db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(config.busyTimeoutMs ?? 5000))}`);
      if (!config.readOnly) {
        db.run("PRAGMA journal_mode = WAL");
        applyMigrations(db);
      }
      db.run("PRAGMA foreign_keys = ON");
    } catch (error) {
      try {
        db?.close();
      } finally {
        lock?.release();
      }
      throw error;
    }
    this.db = db as Database;
    this.lock = lock;
    this.runtime = new RuntimeRepository(this.db);
    this.repository = this.runtime;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lock?.release();
  }
  [Symbol.dispose](): void {
    this.close();
  }
  static open(options: StorageOptions | string): Storage {
    return new Storage(options);
  }
}
export function openStorage(options: StorageOptions | string): Storage {
  return new Storage(options);
}
export function databasePath(projectDir: string): string {
  return join(resolve(projectDir), STORAGE_DIR, DATABASE_FILENAME);
}
export function lockPath(projectDir: string): string {
  return join(resolve(projectDir), STORAGE_DIR, LOCK_FILENAME);
}
export function migrationVersions(): number[] {
  return MIGRATIONS.map(([version]) => version);
}
