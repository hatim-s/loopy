import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
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
import {
  type ExtractionProposal,
  ExtractionProposalSchema,
  type ExtractionProposalV1,
} from "@loopy/contracts";
import { validateWorkflow } from "@loopy/runtime";
import { decodeTraceJsonl } from "@loopy/tracing";
import { ScheduleRepository } from "./schedule-store.js";

export const STORAGE_DIR = ".loopy";
export const DATABASE_FILENAME = "loopy.db";
export const LOCK_FILENAME = "loopy.lock";
export const CURRENT_MIGRATION = 6;

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
  [
    3,
    `ALTER TABLE imported_sessions ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE imported_sessions ADD COLUMN lossiness_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE imported_sessions ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS imported_sessions_content_hash_idx ON imported_sessions(content_hash) WHERE content_hash IS NOT NULL;`,
  ],
  [
    4,
    `CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK(workflow_version > 0),
  input_json TEXT NOT NULL DEFAULT '{}',
  expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  overlap_policy TEXT NOT NULL CHECK(overlap_policy IN ('skip','queue','cancel_previous')),
  missed_policy TEXT NOT NULL CHECK(missed_policy IN ('skip','run_once')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  next_fire_at TEXT,
  last_fire_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workflow_id, workflow_version) REFERENCES workflow_versions(workflow_id, version)
);
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(enabled, next_fire_at);
CREATE TABLE IF NOT EXISTS schedule_fires (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  fire_key TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','running','succeeded','failed','skipped')),
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id, fire_key)
);
CREATE INDEX IF NOT EXISTS schedule_fires_status_idx ON schedule_fires(schedule_id,status,scheduled_at);
CREATE TABLE IF NOT EXISTS schedule_run_links (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  fire_id TEXT NOT NULL REFERENCES schedule_fires(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('queued','active','terminal')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(fire_id),
  UNIQUE(run_id)
);
CREATE INDEX IF NOT EXISTS schedule_run_links_active_idx ON schedule_run_links(schedule_id,state);
CREATE TABLE IF NOT EXISTS retention_policies (
  id TEXT PRIMARY KEY,
  max_age_days INTEGER CHECK(max_age_days IS NULL OR max_age_days > 0),
  max_runs INTEGER CHECK(max_runs IS NULL OR max_runs > 0),
  batch_size INTEGER NOT NULL DEFAULT 100 CHECK(batch_size > 0),
  updated_at TEXT NOT NULL
);`,
  ],
  [
    5,
    `CREATE TABLE schedules_v5 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK(workflow_version > 0),
  input_json TEXT NOT NULL DEFAULT '{}',
  expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  overlap_policy TEXT NOT NULL CHECK(overlap_policy IN ('skip','queue','cancel_previous')),
  missed_policy TEXT NOT NULL CHECK(missed_policy IN ('skip','run_once')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  next_fire_at TEXT,
  last_fire_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workflow_id, workflow_version) REFERENCES workflow_versions(workflow_id, version)
);
INSERT INTO schedules_v5 SELECT id,name,workflow_id,workflow_version,input_json,expression,timezone,
  CASE WHEN overlap_policy='allow' THEN 'skip' ELSE overlap_policy END,
  CASE WHEN missed_policy IN ('fire_once','catch_up') THEN 'run_once' ELSE missed_policy END,
  enabled,next_fire_at,last_fire_at,created_at,updated_at FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_v5 RENAME TO schedules;
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(enabled, next_fire_at);`,
  ],
  [
    6,
    `CREATE TABLE IF NOT EXISTS scheduler_state (
  schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  cursor TEXT,
  active_json TEXT,
  pending_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduler_state_cursor_idx ON scheduler_state(cursor);`,
  ],
];

function applyMigrations(db: Database): void {
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

/**
 * Metadata is evidence about an imported session, so a repeated import may
 * enrich an existing row but must never replace an earlier claim with a
 * conflicting one. Objects are merged recursively and arrays are treated as
 * deterministic sets. Scalar conflicts are rejected explicitly; callers can
 * retry with the complete metadata and the transaction leaves the row intact.
 */
function mergeImportMetadata(
  existing: JsonObject,
  incoming: JsonObject,
  label: "capabilities" | "lossiness",
): JsonObject {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  const merge = (left: unknown, right: unknown, path: string): unknown => {
    if (right === undefined) return left;
    if (left === undefined) return canonical(right);
    if (JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))) return left;
    if (Array.isArray(left) && Array.isArray(right)) {
      const values = new Map<string, unknown>();
      for (const item of [...left, ...right]) values.set(JSON.stringify(canonical(item)), item);
      return [...values.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, item]) => canonical(item));
    }
    if (
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      !Array.isArray(left) &&
      typeof right === "object" &&
      !Array.isArray(right)
    ) {
      const result: Record<string, unknown> = {};
      const keys = new Set([
        ...Object.keys(left as Record<string, unknown>),
        ...Object.keys(right as Record<string, unknown>),
      ]);
      for (const key of [...keys].sort((a, b) => a.localeCompare(b)))
        result[key] = merge(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
      return result;
    }
    throw new Error(
      `Conflicting ${label} metadata at ${path || "<root>"}; repeated imports cannot downgrade existing evidence`,
    );
  };
  return merge(existing, incoming, "") as JsonObject;
}

function importMetadata(
  primary: JsonObject | undefined,
  alias: JsonObject | undefined,
  label: "capabilities" | "lossiness",
): JsonObject {
  return mergeImportMetadata(primary ?? {}, alias ?? {}, label);
}

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
  capabilities: JsonObject;
  capabilityMetadata: JsonObject;
  lossiness: JsonObject;
  lossinessMetadata: JsonObject;
  contentHash?: string;
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
export interface ExtractionAudit {
  [key: string]: JsonValue;
}
export interface ExtractionReviewRecord {
  job: ExtractionJobRecord;
  import: ImportedSessionRecord;
  proposal: ExtractionProposal;
  audit?: JsonValue;
}

export interface CanonicalSessionImportInput {
  provider: string;
  source: string;
  content: string | Uint8Array;
  capabilities?: JsonObject;
  capabilityMetadata?: JsonObject;
  lossiness?: JsonObject;
  lossinessMetadata?: JsonObject;
  id?: string;
  importedAt?: string;
}

export interface ExtractionResultInput {
  proposal: ExtractionProposal;
  audit?: JsonValue;
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

export type ScheduleOverlapPolicy = "skip" | "queue" | "cancel_previous";
export type ScheduleMissedPolicy = "skip" | "run_once";
export type ScheduleFireStatus = "claimed" | "running" | "succeeded" | "failed" | "skipped";

export interface ScheduleRecord {
  id: string;
  name: string;
  workflowId: string;
  workflowVersion: number;
  input: JsonObject;
  expression: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  missedPolicy: ScheduleMissedPolicy;
  enabled: boolean;
  nextFireAt?: string;
  lastFireAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduleFireRecord {
  id: string;
  scheduleId: string;
  fireKey: string;
  scheduledAt: string;
  status: ScheduleFireStatus;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  createdAt: string;
}
export interface ScheduleRunLinkRecord {
  id: string;
  scheduleId: string;
  fireId: string;
  runId: string;
  state: "queued" | "active" | "terminal";
  createdAt: string;
  updatedAt: string;
}
export interface RetentionPolicyRecord {
  id: string;
  maxAgeDays?: number;
  maxRuns?: number;
  batchSize: number;
  updatedAt: string;
}
export interface RetentionFilter {
  before?: string;
  maxAgeDays?: number;
  maxRuns?: number;
  batchSize?: number;
}
export interface RetentionCandidate {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  createdAt: string;
  eventCount: number;
  artifactCount: number;
}
export interface RetentionPreview {
  candidates: RetentionCandidate[];
  protectedRunIds: string[];
  hasMore: boolean;
  filter: RetentionFilter;
}
export interface RetentionApplyResult extends RetentionPreview {
  deletedRunIds: string[];
  deletedCounts: {
    runs: number;
    events: number;
    artifacts: number;
    approvals: number;
    nodeAttempts: number;
    scheduleRunLinks: number;
    scheduleFires: number;
  };
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
const asImportedSession = (r: Row): ImportedSessionRecord => ({
  id: r.id as string,
  provider: r.provider as string,
  source: r.source as string,
  session: must(decode(r.session_json as string), "imported session payload"),
  capabilities: (decode<JsonObject>(r.capabilities_json as string | null) ?? {}) as JsonObject,
  capabilityMetadata: (decode<JsonObject>(r.capabilities_json as string | null) ??
    {}) as JsonObject,
  lossiness: (decode<JsonObject>(r.lossiness_json as string | null) ?? {}) as JsonObject,
  lossinessMetadata: (decode<JsonObject>(r.lossiness_json as string | null) ?? {}) as JsonObject,
  ...(typeof r.content_hash === "string" ? { contentHash: r.content_hash } : {}),
  importedAt: r.imported_at as string,
});

function contentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(contentBytes(content)).digest("hex");
}

/** Turn a content hash into a stable UUID for contracts that require stable IDs. */
function hashId(hash: string): string {
  const hex = `${hash.slice(0, 32)}`.padEnd(32, "0").split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}
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
    capabilities?: JsonObject;
    capabilityMetadata?: JsonObject;
    lossiness?: JsonObject;
    lossinessMetadata?: JsonObject;
    contentHash?: string;
    importedAt?: string;
  }): ImportedSessionRecord {
    const id = input.id ?? randomUUID();
    const capabilities = importMetadata(
      input.capabilities,
      input.capabilityMetadata,
      "capabilities",
    );
    const lossiness = importMetadata(input.lossiness, input.lossinessMetadata, "lossiness");
    this.run(
      "INSERT INTO imported_sessions(id,provider,source,session_json,capabilities_json,lossiness_json,content_hash,imported_at) VALUES (?,?,?,?,?,?,?,?)",
      id,
      input.provider,
      input.source,
      encode(input.session),
      encode(capabilities),
      encode(lossiness),
      input.contentHash ?? null,
      input.importedAt ?? timestamp(),
    );
    return must(this.getImportedSession(id), "imported session");
  }
  /**
   * Validate and persist one canonical trace session. The import is atomic:
   * malformed, mixed-run, or non-contiguous traces never create a row.
   */
  importCanonicalSession(input: CanonicalSessionImportInput): ImportedSessionRecord {
    if (!input.provider.trim()) throw new Error("Import provider is required");
    if (!input.source.trim()) throw new Error("Import source is required");
    const hash = sha256(input.content);
    const capabilities = importMetadata(
      input.capabilities,
      input.capabilityMetadata,
      "capabilities",
    );
    const lossiness = importMetadata(input.lossiness, input.lossinessMetadata, "lossiness");
    return this.db.transaction(() => {
      const existing = this.db
        .query<Row, [string]>("SELECT * FROM imported_sessions WHERE content_hash=?")
        .get(hash);
      if (existing) {
        const currentCapabilities = (decode<JsonObject>(
          existing.capabilities_json as string | null,
        ) ?? {}) as JsonObject;
        const currentLossiness = (decode<JsonObject>(existing.lossiness_json as string | null) ??
          {}) as JsonObject;
        const mergedCapabilities = mergeImportMetadata(
          currentCapabilities,
          capabilities,
          "capabilities",
        );
        const mergedLossiness = mergeImportMetadata(currentLossiness, lossiness, "lossiness");
        if (
          JSON.stringify(currentCapabilities) !== JSON.stringify(mergedCapabilities) ||
          JSON.stringify(currentLossiness) !== JSON.stringify(mergedLossiness)
        ) {
          const updated = this.db.run(
            "UPDATE imported_sessions SET capabilities_json=?,lossiness_json=? WHERE id=? AND content_hash=?",
            [encode(mergedCapabilities), encode(mergedLossiness), existing.id, hash] as never,
          );
          if (updated.changes !== 1)
            throw new Error(
              `Concurrent metadata update for imported session ${String(existing.id)}`,
            );
          return asImportedSession(
            this.db
              .query<Row, [string]>("SELECT * FROM imported_sessions WHERE id=?")
              .get(existing.id as string) as Row,
          );
        }
        return asImportedSession(existing);
      }

      const decoded = decodeTraceJsonl(input.content, { rejectDiagnostics: true });
      if (decoded.events.length === 0) throw new Error("Canonical session must contain events");
      const runIds = new Set(decoded.events.map((event) => event.runId));
      if (runIds.size !== 1) throw new Error("Canonical session contains multiple run IDs");
      for (const [index, event] of decoded.events.entries()) {
        if (event.sequence !== index)
          throw new Error(
            `Canonical session sequence must be contiguous from zero (expected ${index}, got ${event.sequence})`,
          );
      }
      const session = decoded.events as unknown as JsonValue;
      return this.createImportedSession({
        id: input.id ?? hashId(hash),
        provider: input.provider,
        source: input.source,
        session,
        capabilities,
        lossiness,
        contentHash: hash,
        importedAt: input.importedAt,
      });
    })();
  }
  getImportedSession(id: string): ImportedSessionRecord | undefined {
    const r = this.db.query<Row, [string]>("SELECT * FROM imported_sessions WHERE id=?").get(id);
    return r ? asImportedSession(r) : undefined;
  }
  listImportedSessions(): ImportedSessionRecord[] {
    return (
      this.db
        .query<Row, []>("SELECT * FROM imported_sessions ORDER BY imported_at,id")
        .all() as Row[]
    ).map(asImportedSession);
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
  listExtractionJobs(importId?: string): ExtractionJobRecord[] {
    const rows = importId
      ? this.db
          .query<Row, [string]>(
            "SELECT * FROM extraction_jobs WHERE import_id=? ORDER BY created_at,id",
          )
          .all(importId)
      : this.db.query<Row, []>("SELECT * FROM extraction_jobs ORDER BY created_at,id").all();
    return (rows as Row[]).map((r) => this.getExtractionJob(r.id as string) as ExtractionJobRecord);
  }
  updateExtractionJob(
    id: string,
    input: {
      status?: ExtractionJobStatus;
      output?: JsonValue;
      error?: string;
    },
  ): ExtractionJobRecord {
    const current = this.getExtractionJob(id);
    if (!current) throw new Error(`Unknown extraction job ${id}`);
    this.run(
      "UPDATE extraction_jobs SET status=?,output_json=?,error=?,updated_at=? WHERE id=?",
      input.status ?? current.status,
      input.output === undefined
        ? current.output === undefined
          ? null
          : encode(current.output)
        : encode(input.output),
      input.error ?? null,
      timestamp(),
      id,
    );
    return must(this.getExtractionJob(id), "extraction job");
  }
  saveExtractionResult(id: string, result: ExtractionResultInput): ExtractionJobRecord {
    const proposal = ExtractionProposalSchema.parse(result.proposal);
    return this.updateExtractionJob(id, {
      status: "succeeded",
      output: { proposal, ...(result.audit === undefined ? {} : { audit: result.audit }) },
      error: undefined,
    });
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

  private reviewFromJob(job: ExtractionJobRecord): ExtractionReviewRecord | undefined {
    if (!job.output || typeof job.output !== "object" || Array.isArray(job.output))
      return undefined;
    const output = job.output as Record<string, unknown>;
    const proposalResult = ExtractionProposalSchema.safeParse(output.proposal ?? output);
    if (!proposalResult.success) return undefined;
    const imported = this.getImportedSession(job.importId);
    if (!imported) return undefined;
    return {
      job,
      import: imported,
      proposal: proposalResult.data,
      ...(output.audit === undefined ? {} : { audit: output.audit as JsonValue }),
    };
  }
  listExtractionReviews(): ExtractionReviewRecord[] {
    return this.listExtractionJobs().flatMap((job) => {
      const review = this.reviewFromJob(job);
      return review ? [review] : [];
    });
  }
  getExtractionReview(reference: string): ExtractionReviewRecord | undefined {
    const byJob = this.getExtractionJob(reference);
    if (byJob) return this.reviewFromJob(byJob);
    return this.listExtractionReviews().find((review) => review.proposal.id === reference);
  }
  private updateStoredProposal(
    review: ExtractionReviewRecord,
    proposal: ExtractionProposalV1,
    status: ExtractionJobStatus = review.job.status,
  ): ExtractionJobRecord {
    return this.updateExtractionJob(review.job.id, {
      status,
      output: {
        proposal,
        ...(review.audit === undefined ? {} : { audit: review.audit }),
      },
    });
  }
  approveExtractionProposal(reference: string, resolvedBy = "local-user"): WorkflowVersionRecord {
    return this.db.transaction(() => {
      const review = this.getExtractionReview(reference);
      if (!review) throw new Error(`Unknown extraction proposal or job ${reference}`);
      if (review.proposal.status === "approved")
        throw new Error(`Extraction proposal ${review.proposal.id} is already approved`);
      if (review.proposal.status === "rejected")
        throw new Error(`Extraction proposal ${review.proposal.id} was rejected`);
      if (review.proposal.unresolvedQuestions.some((question) => question.blocksExecution))
        throw new Error("Cannot approve an extraction proposal with blocking unresolved questions");
      const workflowResult = ExtractionProposalSchema.safeParse(review.proposal);
      if (!workflowResult.success)
        throw new Error("Stored extraction proposal failed schema validation");
      const graph = validateWorkflow(workflowResult.data.workflow);
      if (!graph.valid)
        throw new Error(
          `Cannot approve an invalid workflow graph: ${graph.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
        );
      const existing = this.getWorkflowVersion(review.proposal.workflow.id, 1);
      if (existing)
        throw new Error(
          `Workflow ${review.proposal.workflow.id} version 1 already exists; approval will not overwrite it`,
        );
      const now = timestamp();
      const workflow: WorkflowDefinition = {
        ...review.proposal.workflow,
        workflowVersion: 1,
        metadata: {
          ...review.proposal.workflow.metadata,
          createdAt: review.proposal.workflow.metadata.createdAt ?? now,
          updatedAt: now,
          createdFrom: "extraction",
          extractionId: review.proposal.id,
        },
      };
      const parsedWorkflow = workflow as WorkflowDefinition;
      this.run(
        "INSERT INTO workflow_versions(workflow_id,version,definition_json,created_at) VALUES (?,?,?,?)",
        workflow.id,
        1,
        encode(parsedWorkflow),
        now,
      );
      this.updateStoredProposal(review, { ...review.proposal, status: "approved" }, "succeeded");
      void resolvedBy;
      return must(this.getWorkflowVersion(workflow.id, 1), "workflow version");
    })();
  }
  rejectExtractionProposal(reference: string, _reason?: string): ExtractionJobRecord {
    return this.db.transaction(() => {
      const review = this.getExtractionReview(reference);
      if (!review) throw new Error(`Unknown extraction proposal or job ${reference}`);
      if (review.proposal.status === "approved")
        throw new Error(`Extraction proposal ${review.proposal.id} is already approved`);
      if (review.proposal.status === "rejected") return review.job;
      return this.updateStoredProposal(
        review,
        { ...review.proposal, status: "rejected" },
        "cancelled",
      );
    })();
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
  readonly schedules: ScheduleRepository;
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
    this.schedules = new ScheduleRepository(this.db);
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
