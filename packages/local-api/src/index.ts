import { randomBytes, timingSafeEqual } from "node:crypto";
import type { JsonObject, WorkflowDefinition } from "@loopy/contracts";
import { WorkflowPatchSchema } from "@loopy/contracts";
import type { ProviderRegistry } from "@loopy/providers";
import type {
  AttemptRecord as RuntimeAttemptRecord,
  RuntimeEvent,
  RunRecord as RuntimeRunRecord,
  RuntimeScheduler,
  RuntimeSnapshot,
  RuntimeStore,
} from "@loopy/runtime";
import type {
  ArtifactRecord,
  AttemptRecord,
  EventRecord,
  ExtractionJobRecord,
  ExtractionReviewRecord,
  ImportedSessionRecord,
  RetentionFilter,
  RunRecord,
  ScheduleMissedPolicy,
  ScheduleOverlapPolicy,
  ScheduleRecord,
  ScheduleRepository,
  Storage,
  WorkflowVersionRecord,
} from "@loopy/storage";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  applyWorkflowPatch,
  validateWorkflowForSave,
  WorkflowEditError,
  workflowVersionDiff,
} from "./workflow-edit.ts";

export type LocalApiRepository = {
  listProviderInstallations(): unknown[];
  getProviderInstallation(provider: string): unknown;
  listImportedSessions(): ImportedSessionRecord[];
  getImportedSession(id: string): ImportedSessionRecord | undefined;
  listExtractionJobs(importId?: string): ExtractionJobRecord[];
  getExtractionJob(id: string): ExtractionJobRecord | undefined;
  createExtractionJob(input: { importId: string; input?: JsonObject }): ExtractionJobRecord;
  listExtractionReviews(): ExtractionReviewRecord[];
  getExtractionReview(reference: string): ExtractionReviewRecord | undefined;
  approveExtractionProposal(reference: string, resolvedBy?: string): WorkflowVersionRecord;
  rejectExtractionProposal(reference: string, reason?: string): ExtractionJobRecord;
  listWorkflowVersions(workflowId?: string): WorkflowVersionRecord[];
  getWorkflowVersion(workflowId: string, version: number): WorkflowVersionRecord | undefined;
  createWorkflowVersion(input: {
    workflowId?: string;
    version?: number;
    definition: WorkflowDefinition | JsonObject;
  }): WorkflowVersionRecord;
  listRuns(status?: RunRecord["status"]): RunRecord[];
  getRun(id: string): RunRecord | undefined;
  listAttempts(runId?: string): AttemptRecord[];
  getAttempt(id: string): AttemptRecord | undefined;
  listEvents(
    runId: string,
    options?: { afterSequence?: number; beforeSequence?: number; limit?: number },
  ): EventRecord[];
  getEvent(runId: string, sequence: number): EventRecord | undefined;
  listArtifacts(runId: string): ArtifactRecord[];
  getArtifact(id: string): ArtifactRecord | undefined;
};

export type LocalApiStorage = Pick<Storage, "runtime"> & { runtime: LocalApiRepository };
export type ScheduleRuntimeEngine = {
  start(plan: unknown, input: JsonObject): Promise<{ runId: string } | { id: string }>;
};
export type ScheduleCoordinator = (input: {
  schedule: ScheduleRecord;
  now: string;
  activeRunIds: string[];
  scheduledAt: string;
}) => Promise<"allow" | "skip" | "queue"> | "allow" | "skip" | "queue";
export type LocalApiOptions = {
  storage: LocalApiStorage;
  runtime?: RuntimeScheduler;
  scheduler?: RuntimeScheduler;
  runtimeStore?: RuntimeStore;
  providerRegistry?: ProviderRegistry;
  registry?: ProviderRegistry;
  origins?: readonly string[];
  maxBodyBytes?: number;
  heartbeatMs?: number;
  pollMs?: number;
  token?: string;
  scheduleStore?: ScheduleRepository;
  scheduleEngine?: ScheduleRuntimeEngine;
  scheduleCoordinator?: ScheduleCoordinator;
};
export type LocalServerConfig = {
  host: "127.0.0.1" | "::1";
  port: number;
  token: string;
  origins: readonly string[];
};
export type LocalApiServer = LocalServerConfig & { app: Hono; server: { stop(): void } };

/**
 * The public run shape deliberately uses the storage vocabulary (`id`, `input`,
 * `updatedAt`) even when a run is owned by an in-memory/runtime scheduler.
 * Runtime-specific fields remain optional metadata rather than changing the
 * identity of the resource between list/create/get responses.
 */
export type LocalApiRun = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunRecord["status"];
  input: JsonObject;
  planHash?: string;
  createdAt: string;
  updatedAt: string;
  plan?: RuntimeRunRecord["plan"];
  executionPlanHash?: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
};

export type LocalApiAttempt = {
  id: string;
  attemptId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: string;
  input?: JsonObject;
  output?: JsonObject;
  completion?: Record<string, unknown>;
  error?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
};

export type LocalApiEvent = EventRecord & { source?: "storage" | "runtime" };

export type LocalApiRunSnapshot = LocalApiRun & {
  attempts: LocalApiAttempt[];
  events: LocalApiEvent[];
  artifacts: ArtifactRecord[];
  approvals: unknown[];
  workflow?: WorkflowVersionRecord;
};

const DEFAULT_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"] as const;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_POLL_MS = 250;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

function randomHighPort(): number {
  return 49_152 + (randomBytes(2).readUInt16BE(0) % (65_536 - 49_152));
}
function newToken(): string {
  return randomBytes(32).toString("base64url");
}
function validateToken(token: string): string {
  if (typeof token !== "string" || token.length < 32 || token.trim() !== token) {
    throw new Error(
      "Local API bearer tokens must be at least 32 characters and contain no surrounding whitespace",
    );
  }
  return token;
}
function exactOrigins(origins: readonly string[] | undefined): readonly string[] {
  const values = origins?.length ? [...origins] : [...DEFAULT_ORIGINS];
  if (values.some((origin) => origin === "*" || origin.includes("*")))
    throw new Error("Local API origins must be an exact allowlist; wildcard origins are forbidden");
  for (const origin of values) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid local API origin '${origin}'`);
    }
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(`Local API origin must be an exact origin: '${origin}'`);
  }
  return [...new Set(values)];
}
export function createLocalServerConfig(input: Partial<LocalServerConfig> = {}): LocalServerConfig {
  const host = input.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("The local API may only bind to loopback");
  const port = input.port ?? randomHighPort();
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Invalid local API port");
  return {
    host,
    port,
    token: validateToken(input.token ?? newToken()),
    origins: exactOrigins(input.origins),
  };
}
function sameToken(expected: string, presented: string | undefined): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented ?? "");
  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return timingSafeEqual(left, right);
}
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
function notFound(label: string): never {
  throw new ApiError(404, "not_found", `${label} not found`);
}
function capability(message: string): never {
  throw new ApiError(501, "capability_unavailable", message);
}
function readLastEventId(value: string | undefined): number {
  if (!value) return -1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -1)
    throw new ApiError(
      400,
      "invalid_last_event_id",
      "Last-Event-ID must be a non-negative integer",
    );
  return parsed;
}
async function jsonBody(c: Context, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = c.req.header("content-length");
  if (declared && Number(declared) > maxBytes)
    throw new ApiError(413, "body_too_large", "Request body exceeds the local API limit");
  const body = c.req.raw.body;
  if (!body) return {};
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "body_too_large", "Request body exceeds the local API limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}
function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(400, "invalid_request", `${name} is required`);
  return value;
}
function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
type EventHub = {
  notify(runId: string): void;
  wait(runId: string, signal: AbortSignal): Promise<void>;
};
function createEventHub(): EventHub {
  const waiters = new Map<string, Set<() => void>>();
  return {
    notify(runId) {
      for (const resolve of waiters.get(runId) ?? []) resolve();
      waiters.delete(runId);
    },
    wait(runId, signal) {
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const listeners = waiters.get(runId) ?? new Set<() => void>();
        const done = () => {
          signal.removeEventListener("abort", done);
          listeners.delete(done);
          resolve();
        };
        listeners.add(done);
        waiters.set(runId, listeners);
        signal.addEventListener("abort", done, { once: true });
      });
    },
  };
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

type RuntimeStoreWithTrace = RuntimeStore & {
  listTraceEvents?: (runId: string) => readonly Record<string, unknown>[];
};

function isRuntimeRun(value: RunRecord | RuntimeRunRecord): value is RuntimeRunRecord {
  return "runId" in value;
}

function normalizeRun(value: RunRecord | RuntimeRunRecord): LocalApiRun {
  if (isRuntimeRun(value)) {
    const updatedAt = value.endedAt ?? value.startedAt ?? value.createdAt;
    return {
      id: value.runId,
      workflowId: value.workflowId,
      workflowVersion: value.workflowVersion,
      status: value.status,
      input: value.inputs,
      ...(value.executionPlanHash ? { planHash: value.executionPlanHash } : {}),
      createdAt: value.createdAt,
      updatedAt,
      plan: value.plan,
      ...(value.executionPlanHash ? { executionPlanHash: value.executionPlanHash } : {}),
      ...(value.startedAt ? { startedAt: value.startedAt } : {}),
      ...(value.endedAt ? { endedAt: value.endedAt } : {}),
      ...(value.error ? { error: value.error } : {}),
    };
  }
  return {
    id: value.id,
    workflowId: value.workflowId,
    workflowVersion: value.workflowVersion,
    status: value.status,
    input: value.input,
    ...(value.planHash ? { planHash: value.planHash } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeAttempt(value: AttemptRecord | RuntimeAttemptRecord): LocalApiAttempt {
  if ("attemptId" in value) {
    return {
      id: value.attemptId,
      attemptId: value.attemptId,
      runId: value.runId,
      nodeId: value.nodeId,
      attempt: value.attempt,
      status: value.status,
      input: value.input,
      ...(value.output ? { output: value.output } : {}),
      ...(value.completion ? { completion: value.completion } : {}),
      ...(value.error ? { error: value.error } : {}),
      ...(value.createdAt ? { createdAt: value.createdAt } : {}),
      ...(value.startedAt ? { startedAt: value.startedAt } : {}),
      ...(value.endedAt ? { endedAt: value.endedAt } : {}),
    };
  }
  return {
    id: value.id,
    attemptId: value.id,
    runId: value.runId,
    nodeId: value.nodeId,
    attempt: value.attempt,
    status: value.status,
    ...(value.input && typeof value.input === "object" && !Array.isArray(value.input)
      ? { input: value.input as JsonObject }
      : {}),
    ...(value.output && typeof value.output === "object" && !Array.isArray(value.output)
      ? { output: value.output as JsonObject }
      : {}),
    ...(value.error ? { error: value.error } : {}),
    ...(value.startedAt ? { startedAt: value.startedAt } : {}),
    ...(value.finishedAt ? { endedAt: value.finishedAt } : {}),
    updatedAt: value.updatedAt,
  };
}

function runtimeEventId(event: RuntimeEvent): string {
  return [event.runId, event.sequence, event.type, event.nodeId ?? "", event.attemptId ?? ""].join(
    ":",
  );
}

function normalizeRuntimeEvent(event: RuntimeEvent): LocalApiEvent {
  const source = event as RuntimeEvent & {
    id?: string;
    provider?: string;
    sessionId?: string;
    toolCallId?: string;
    monotonicOffsetMs?: number;
  };
  return {
    id: source.id ?? runtimeEventId(event),
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
    payload: jsonObject(event.payload),
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}),
    occurredAt: event.occurredAt,
    monotonicOffsetMs: source.monotonicOffsetMs ?? 0,
    source: "runtime",
  };
}

function normalizeCanonicalEvent(value: Record<string, unknown>): LocalApiEvent {
  const event = value as Partial<EventRecord>;
  return {
    id: typeof event.id === "string" ? event.id : "",
    runId: String(event.runId ?? ""),
    sequence: Number(event.sequence ?? 0),
    type: String(event.type ?? "runtime.event"),
    payload: jsonObject(event.payload),
    ...(typeof event.nodeId === "string" ? { nodeId: event.nodeId } : {}),
    ...(typeof event.attemptId === "string" ? { attemptId: event.attemptId } : {}),
    ...(typeof event.provider === "string" ? { provider: event.provider } : {}),
    ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}),
    ...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
    occurredAt: String(event.occurredAt ?? new Date(0).toISOString()),
    monotonicOffsetMs: Number(event.monotonicOffsetMs ?? 0),
    source: "storage",
  };
}

function topologyFromDefinition(definition: unknown): {
  startNodeIds: string[];
  terminalNodeIds: string[];
  topologicalOrder: string[];
} {
  const source = jsonObject(definition);
  const existing = jsonObject(source.topology);
  const nodes = Array.isArray(source.nodes)
    ? source.nodes
        .map((node) =>
          node && typeof node === "object" ? (node as Record<string, unknown>).id : undefined,
        )
        .filter((id): id is string => typeof id === "string")
    : [];
  const edges = Array.isArray(source.edges)
    ? source.edges
        .map((edge) => (edge && typeof edge === "object" ? (edge as Record<string, unknown>) : {}))
        .filter((edge) => typeof edge.source === "string" && typeof edge.target === "string")
        .map((edge) => ({ source: edge.source as string, target: edge.target as string }))
    : [];
  const indegree = new Map(nodes.map((node) => [node, 0]));
  const outgoing = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const edge of edges) {
    if (!indegree.has(edge.target) || !outgoing.has(edge.source)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const initialIndegree = new Map(indegree);
  const queue = nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
  const order: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index] as string;
    order.push(node);
    for (const target of outgoing.get(node) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return {
    startNodeIds: Array.isArray(existing.startNodeIds)
      ? existing.startNodeIds.filter((id): id is string => typeof id === "string")
      : nodes.filter((node) => (initialIndegree.get(node) ?? 0) === 0),
    terminalNodeIds: Array.isArray(existing.terminalNodeIds)
      ? existing.terminalNodeIds.filter((id): id is string => typeof id === "string")
      : nodes.filter((node) => (outgoing.get(node) ?? []).length === 0),
    topologicalOrder: Array.isArray(existing.topologicalOrder)
      ? existing.topologicalOrder.filter((id): id is string => typeof id === "string")
      : order,
  };
}

/** Construct the authenticated local API. It does not listen. */
export function createLocalApi(options: LocalApiOptions): Hono {
  const repository = options.storage.runtime;
  const scheduler = options.runtime ?? options.scheduler;
  const scheduleStore =
    options.scheduleStore ??
    (options.storage as LocalApiStorage & { schedules?: ScheduleRepository }).schedules;
  const scheduleEngine =
    options.scheduleEngine ?? (scheduler as unknown as ScheduleRuntimeEngine | undefined);
  const scheduleCoordinator = options.scheduleCoordinator;
  const registry = options.providerRegistry ?? options.registry;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const heartbeatMs = Math.max(1_000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const pollMs = Math.max(25, options.pollMs ?? DEFAULT_POLL_MS);
  const token = validateToken(options.token ?? newToken());
  const origins = exactOrigins(options.origins);
  const hub = createEventHub();
  const api = new Hono();
  api.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    c.header("Vary", "Origin");
    if (origin) {
      if (!origins.includes(origin))
        return c.json({ error: { code: "origin_denied", message: "Origin is not allowed" } }, 403);
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Expose-Headers", "Content-Type");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    const match = c.req.header("Authorization")?.match(/^Bearer ([^\s]+)$/);
    if (!sameToken(token, match?.[1]))
      return c.json(
        { error: { code: "unauthorized", message: "Bearer authentication required" } },
        401,
      );
    return next();
  });
  api.onError((error, c) => {
    const normalized =
      error instanceof ApiError
        ? error
        : error instanceof WorkflowEditError
          ? new ApiError(422, "workflow_patch_invalid", "Workflow patch could not be applied", {
              diagnostics: [error.diagnostic],
            })
          : new ApiError(500, "internal_error", "Internal server error");
    return c.json(
      { error: { code: normalized.code, message: normalized.message, ...normalized.details } },
      normalized.status as 400,
    );
  });
  api.get("/health", (c) => c.json({ ok: true, version: "v1" }));
  api.get("/providers", async (c) => {
    if (!registry)
      return c.json({
        providers: [],
        installations: repository.listProviderInstallations(),
        capability: { available: false, reason: "provider registry not configured" },
      });
    const providers = [];
    for (const adapter of registry.all()) {
      try {
        providers.push(await adapter.probe());
      } catch {
        providers.push({
          provider: adapter.id,
          available: false,
          version: adapter.version,
          capabilities: adapter.capabilities(),
          configurationError: true,
          diagnostic: "Probe failed",
        });
      }
    }
    return c.json({ providers, installations: repository.listProviderInstallations() });
  });
  api.get("/providers/capabilities", (c) => {
    if (!registry) return c.json({ capabilities: [] });
    const capabilities = registry.all().flatMap((adapter) =>
      Object.entries(adapter.capabilities().capabilities)
        .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => Boolean(entry[1]))
        .map(([capability, assessment]) => ({
          provider: adapter.id,
          capability,
          status: assessment.status,
          ...(assessment.reason ? { reason: assessment.reason } : {}),
          source: "provider-adapter",
        })),
    );
    return c.json({ capabilities });
  });
  api.get("/providers/:id/probe", async (c) => {
    const adapter = registry?.get(c.req.param("id"));
    if (!adapter) notFound("Provider");
    try {
      return c.json(await adapter.probe());
    } catch {
      return c.json({
        provider: adapter.id,
        available: false,
        version: adapter.version,
        capabilities: adapter.capabilities(),
        configurationError: true,
        diagnostic: "Probe failed",
      });
    }
  });
  api.get("/sessions", (c) => c.json({ sessions: repository.listImportedSessions() }));
  api.get("/sessions/:id", (c) =>
    c.json(repository.getImportedSession(c.req.param("id")) ?? notFound("Imported session")),
  );
  api.get("/extractions", (c) =>
    c.json({
      jobs: repository.listExtractionJobs(c.req.query("importId")),
      reviews: repository.listExtractionReviews(),
    }),
  );
  api.post("/extractions", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const importId = requiredString(body, "importId");
    if (!repository.getImportedSession(importId)) notFound("Imported session");
    return c.json(repository.createExtractionJob({ importId, input: jsonObject(body.input) }), 201);
  });
  api.get("/extractions/:id", (c) =>
    c.json(
      repository.getExtractionReview(c.req.param("id")) ??
        repository.getExtractionJob(c.req.param("id")) ??
        notFound("Extraction"),
    ),
  );
  api.post("/extractions/:id/approve", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    return c.json(
      repository.approveExtractionProposal(
        c.req.param("id"),
        typeof body.resolvedBy === "string" ? body.resolvedBy : "local-user",
      ),
    );
  });
  api.post("/extractions/:id/reject", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    return c.json(
      repository.rejectExtractionProposal(
        c.req.param("id"),
        typeof body.reason === "string" ? body.reason : undefined,
      ),
    );
  });
  api.get("/reviews", (c) => c.json({ reviews: repository.listExtractionReviews() }));
  api.get("/reviews/:id", (c) =>
    c.json(repository.getExtractionReview(c.req.param("id")) ?? notFound("Extraction review")),
  );
  api.post("/reviews/:id/approve", (c) =>
    c.json(repository.approveExtractionProposal(c.req.param("id"))),
  );
  api.post("/reviews/:id/reject", (c) =>
    c.json(repository.rejectExtractionProposal(c.req.param("id"))),
  );
  api.get("/workflows", (c) =>
    c.json({ workflows: repository.listWorkflowVersions(c.req.query("workflowId")) }),
  );
  api.get("/workflows/:id", (c) => {
    const versions = repository.listWorkflowVersions(c.req.param("id"));
    if (!versions.length) notFound("Workflow");
    return c.json({ workflowId: c.req.param("id"), versions });
  });
  // Register the static diff route before the generic two-segment version route.
  api.get("/workflows/:id/diff", (c) => {
    const fromVersion = Number(c.req.query("from"));
    const toVersion = Number(c.req.query("to"));
    if (![fromVersion, toVersion].every((version) => Number.isInteger(version) && version > 0))
      throw new ApiError(400, "invalid_request", "from and to versions must be positive integers");
    const from =
      repository.getWorkflowVersion(c.req.param("id"), fromVersion) ?? notFound("Workflow version");
    const to =
      repository.getWorkflowVersion(c.req.param("id"), toVersion) ?? notFound("Workflow version");
    return c.json(
      workflowVersionDiff(
        c.req.param("id"),
        fromVersion,
        toVersion,
        from.definition as WorkflowDefinition,
        to.definition as WorkflowDefinition,
      ),
    );
  });
  api.get("/workflows/:id/:version", (c) => {
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1)
      throw new ApiError(400, "invalid_request", "Workflow version must be positive");
    return c.json(
      repository.getWorkflowVersion(c.req.param("id"), version) ?? notFound("Workflow version"),
    );
  });
  api.get("/workflows/:id/:version/topology", (c) => {
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1)
      throw new ApiError(400, "invalid_request", "Workflow version must be positive");
    const workflow =
      repository.getWorkflowVersion(c.req.param("id"), version) ?? notFound("Workflow version");
    return c.json({
      workflowId: workflow.workflowId,
      version: workflow.version,
      topology: topologyFromDefinition(workflow.definition),
    });
  });
  const saveDefinition = (
    definitionInput: unknown,
    workflowIdHint?: string,
    requestedVersion?: number,
    createdFrom?: WorkflowDefinition["metadata"]["createdFrom"],
  ) => {
    const checked = validateWorkflowForSave(definitionInput);
    if (!checked.workflow || checked.diagnostics.some((item) => item.severity === "error"))
      throw new ApiError(422, "workflow_invalid", "Workflow definition failed validation", {
        diagnostics: checked.diagnostics,
      });
    const workflow = checked.workflow;
    if (workflowIdHint && workflow.id !== workflowIdHint)
      throw new ApiError(400, "workflow_id_mismatch", "Workflow id does not match the URL");
    const existing = repository.listWorkflowVersions(workflow.id);
    const nextVersion = requestedVersion ?? (existing.at(-1)?.version ?? 0) + 1;
    if (!Number.isInteger(nextVersion) || nextVersion < 1)
      throw new ApiError(400, "invalid_request", "Workflow version must be positive");
    if (repository.getWorkflowVersion(workflow.id, nextVersion))
      throw new ApiError(409, "workflow_version_conflict", "Workflow version already exists");
    const now = new Date().toISOString();
    const persisted: WorkflowDefinition = {
      ...workflow,
      workflowVersion: nextVersion,
      metadata: {
        ...workflow.metadata,
        updatedAt: now,
        ...(createdFrom ? { createdFrom } : {}),
      },
    };
    return repository.createWorkflowVersion({
      workflowId: workflow.id,
      version: nextVersion,
      definition: persisted,
    });
  };
  const patchWorkflow = (workflowId: string, body: Record<string, unknown>) => {
    const versions = repository.listWorkflowVersions(workflowId);
    const base = versions.at(-1);
    if (!base) notFound("Workflow");
    const baseVersion = Number(body.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 1)
      throw new ApiError(400, "invalid_request", "baseVersion must be a positive integer");
    if (baseVersion !== base.version)
      throw new ApiError(
        409,
        "workflow_version_conflict",
        "Workflow changed since this edit began",
        {
          expectedBaseVersion: base.version,
          requestedBaseVersion: baseVersion,
        },
      );
    const patch = {
      schemaVersion: "1" as const,
      workflowId,
      baseVersion,
      ...(body.operations === undefined ? {} : { operations: body.operations }),
      ...(body.patch === undefined ? {} : { patch: body.patch }),
    };
    const parsed = WorkflowPatchSchema.safeParse(patch);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "workflow_patch_invalid",
        "Workflow patch failed contract validation",
        {
          diagnostics: parsed.error.issues.map((issue) => ({
            code: "PATCH_CONTRACT_INVALID",
            severity: "error",
            message: issue.message,
            path: `/${issue.path.join("/")}`,
          })),
        },
      );
    }
    let next: WorkflowDefinition;
    try {
      next = applyWorkflowPatch(base.definition as WorkflowDefinition, parsed.data);
    } catch (error) {
      if (error instanceof WorkflowEditError)
        throw new ApiError(422, "workflow_patch_invalid", "Workflow patch could not be applied", {
          diagnostics: [error.diagnostic],
        });
      throw error;
    }
    const nextVersion = base.version + 1;
    next = {
      ...next,
      workflowVersion: nextVersion,
      metadata: { ...next.metadata, updatedAt: new Date().toISOString() },
    };
    return saveDefinition(next, workflowId, nextVersion);
  };
  api.post("/workflows/:id/patch", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    return c.json(patchWorkflow(c.req.param("id"), body), 201);
  });
  api.post("/workflows/:id/:version/patch", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1)
      throw new ApiError(400, "invalid_request", "Workflow version must be positive");
    if (body.baseVersion === undefined) body.baseVersion = version;
    return c.json(patchWorkflow(c.req.param("id"), body), 201);
  });
  api.post("/workflows/:id/validate", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const checked = validateWorkflowForSave(body.definition ?? body.workflow ?? body);
    return c.json({
      valid:
        Boolean(checked.workflow) && checked.diagnostics.every((item) => item.severity !== "error"),
      ...(checked.workflow ? { workflow: checked.workflow } : {}),
      diagnostics: checked.diagnostics,
    });
  });
  api.get("/workflows/:id/:from/:to/diff", (c) => {
    const fromVersion = Number(c.req.param("from"));
    const toVersion = Number(c.req.param("to"));
    if (![fromVersion, toVersion].every((version) => Number.isInteger(version) && version > 0))
      throw new ApiError(400, "invalid_request", "Workflow versions must be positive integers");
    const from =
      repository.getWorkflowVersion(c.req.param("id"), fromVersion) ?? notFound("Workflow version");
    const to =
      repository.getWorkflowVersion(c.req.param("id"), toVersion) ?? notFound("Workflow version");
    return c.json(
      workflowVersionDiff(
        c.req.param("id"),
        fromVersion,
        toVersion,
        from.definition as WorkflowDefinition,
        to.definition as WorkflowDefinition,
      ),
    );
  });
  api.get("/workflows/:id/:version/export", (c) => {
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1)
      throw new ApiError(400, "invalid_request", "Workflow version must be positive");
    const record =
      repository.getWorkflowVersion(c.req.param("id"), version) ?? notFound("Workflow version");
    const checked = validateWorkflowForSave(record.definition);
    if (!checked.workflow || checked.diagnostics.some((item) => item.severity === "error"))
      throw new ApiError(
        422,
        "workflow_export_invalid",
        "Stored workflow definition failed validation",
        { diagnostics: checked.diagnostics },
      );
    c.header("Content-Type", "application/json");
    return c.body(JSON.stringify(checked.workflow));
  });
  api.post("/workflows/import", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const definition = body.definition ?? body.workflow;
    if (!definition || typeof definition !== "object" || Array.isArray(definition))
      throw new ApiError(400, "invalid_request", "definition is required");
    return c.json(saveDefinition(definition, undefined, undefined, "import"), 201);
  });
  api.post("/workflows", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const definition = (body.definition ?? body.workflow) as
      | WorkflowDefinition
      | JsonObject
      | undefined;
    if (!definition || typeof definition !== "object" || Array.isArray(definition))
      throw new ApiError(400, "invalid_request", "definition is required");
    return c.json(
      saveDefinition(
        definition,
        typeof body.workflowId === "string" ? body.workflowId : undefined,
        typeof body.version === "number" ? body.version : undefined,
      ),
      201,
    );
  });

  const requireScheduleStore = (): ScheduleRepository =>
    scheduleStore ?? capability("Schedule persistence is not configured");
  const fireSchedule = async (scheduleId: string, requestedKey?: string, requestedAt?: string) => {
    const store = requireScheduleStore();
    if (!scheduleEngine) capability("Runtime scheduler is not configured for schedule execution");
    const schedule = store.get(scheduleId) ?? notFound("Schedule");
    const scheduledAt = requestedAt ?? schedule.nextFireAt ?? new Date().toISOString();
    const fireKey = requestedKey ?? scheduledAt;
    const active = store.listLinks(scheduleId, "active").map((item) => item.runId);
    const decision = scheduleCoordinator
      ? await scheduleCoordinator({
          schedule,
          now: new Date().toISOString(),
          activeRunIds: active,
          scheduledAt,
        })
      : active.length && schedule.overlapPolicy === "skip"
        ? "skip"
        : active.length && schedule.overlapPolicy === "queue"
          ? "queue"
          : "allow";
    const claimed = store.claimFire({ scheduleId, fireKey, scheduledAt });
    if (claimed.runId) return { schedule, fire: claimed, idempotent: true };
    if (decision === "skip") {
      return {
        schedule,
        fire: store.updateFire(claimed.id, {
          status: "skipped",
          finishedAt: new Date().toISOString(),
          error: "overlap policy skipped this fire",
        }),
        idempotent: false,
      };
    }
    if (decision === "queue") return { schedule, fire: claimed, queued: true, idempotent: false };
    const workflow =
      repository.getWorkflowVersion(schedule.workflowId, schedule.workflowVersion) ??
      notFound("Workflow version");
    const run = await scheduleEngine.start(workflow.definition, schedule.input);
    const runId = "runId" in run ? run.runId : run.id;
    const link = store.linkRun({ scheduleId, fireId: claimed.id, runId, state: "active" });
    return {
      schedule: store.update(scheduleId, { lastFireAt: scheduledAt, nextFireAt: undefined }),
      fire: store.updateFire(claimed.id, { runId, status: "running" }),
      link,
      idempotent: false,
    };
  };
  api.get("/schedules", (c) => {
    const store = requireScheduleStore();
    return c.json({
      schedules: store.list({
        enabled:
          c.req.query("enabled") === undefined ? undefined : c.req.query("enabled") === "true",
      }),
    });
  });
  api.post("/schedules", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const workflowId = requiredString(body, "workflowId");
    const version = Number(body.workflowVersion ?? body.version ?? 1);
    if (!Number.isInteger(version) || version < 1)
      throw new ApiError(400, "invalid_request", "workflowVersion must be positive");
    const workflow =
      repository.getWorkflowVersion(workflowId, version) ?? notFound("Workflow version");
    void workflow;
    const store = requireScheduleStore();
    return c.json(
      store.create({
        name: requiredString(body, "name"),
        workflowId,
        workflowVersion: version,
        input: jsonObject(body.input),
        expression: requiredString(body, "expression"),
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        overlapPolicy: body.overlapPolicy as ScheduleOverlapPolicy | undefined,
        missedPolicy: body.missedPolicy as ScheduleMissedPolicy | undefined,
        enabled: body.enabled !== false,
        nextFireAt: typeof body.nextFireAt === "string" ? body.nextFireAt : undefined,
      }),
      201,
    );
  });
  api.get("/schedules/:id", (c) => {
    const store = requireScheduleStore();
    const item = store.get(c.req.param("id")) ?? notFound("Schedule");
    return c.json({
      schedule: item,
      fires: store.listFires(item.id),
      links: store.listLinks(item.id),
    });
  });
  api.patch("/schedules/:id", async (c) => {
    const store = requireScheduleStore();
    const body = await jsonBody(c, maxBodyBytes);
    return c.json(
      store.update(c.req.param("id"), {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.expression === "string" ? { expression: body.expression } : {}),
        ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
        ...(typeof body.overlapPolicy === "string"
          ? { overlapPolicy: body.overlapPolicy as ScheduleOverlapPolicy }
          : {}),
        ...(typeof body.missedPolicy === "string"
          ? { missedPolicy: body.missedPolicy as ScheduleMissedPolicy }
          : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.nextFireAt === "string" ? { nextFireAt: body.nextFireAt } : {}),
        ...(body.input !== undefined ? { input: jsonObject(body.input) } : {}),
      }),
    );
  });
  api.post("/schedules/:id/enable", (c) =>
    c.json(requireScheduleStore().update(c.req.param("id"), { enabled: true })),
  );
  api.post("/schedules/:id/disable", (c) =>
    c.json(requireScheduleStore().update(c.req.param("id"), { enabled: false })),
  );
  api.post("/schedules/:id/fire", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    return c.json(
      await fireSchedule(
        c.req.param("id"),
        typeof body.fireKey === "string" ? body.fireKey : undefined,
        typeof body.scheduledAt === "string" ? body.scheduledAt : undefined,
      ),
    );
  });
  api.post("/schedules/tick", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const at = typeof body.now === "string" ? body.now : new Date().toISOString();
    const store = requireScheduleStore();
    const results = [];
    for (const schedule of store.list({ enabled: true, dueBefore: at }))
      results.push(await fireSchedule(schedule.id, schedule.nextFireAt, schedule.nextFireAt));
    return c.json({ now: at, results });
  });
  api.get("/schedules/:id/status", (c) => {
    const store = requireScheduleStore();
    const schedule = store.get(c.req.param("id")) ?? notFound("Schedule");
    return c.json({
      schedule,
      activeRunIds: store.listLinks(schedule.id, "active").map((item) => item.runId),
      fires: store.listFires(schedule.id),
      links: store.listLinks(schedule.id),
    });
  });
  api.get("/retention", (c) => {
    const store = requireScheduleStore();
    return c.json({ policy: store.getRetentionPolicy() });
  });
  api.post("/retention/preview", async (c) => {
    const store = requireScheduleStore();
    const body = await jsonBody(c, maxBodyBytes);
    return c.json(
      store.previewRetention({
        before: typeof body.before === "string" ? body.before : undefined,
        maxAgeDays: typeof body.maxAgeDays === "number" ? body.maxAgeDays : undefined,
        maxRuns: typeof body.maxRuns === "number" ? body.maxRuns : undefined,
        batchSize: typeof body.batchSize === "number" ? body.batchSize : undefined,
      } satisfies RetentionFilter),
    );
  });
  api.post("/retention/apply", async (c) => {
    const store = requireScheduleStore();
    const body = await jsonBody(c, maxBodyBytes);
    if (body.confirm !== true)
      return c.json(
        store.previewRetention({
          maxAgeDays: typeof body.maxAgeDays === "number" ? body.maxAgeDays : undefined,
          maxRuns: typeof body.maxRuns === "number" ? body.maxRuns : undefined,
        }),
        200,
      );
    return c.json(
      store.applyRetention({
        maxAgeDays: typeof body.maxAgeDays === "number" ? body.maxAgeDays : undefined,
        maxRuns: typeof body.maxRuns === "number" ? body.maxRuns : undefined,
      }),
    );
  });

  const runtimeStore = options.runtimeStore as RuntimeStoreWithTrace | undefined;
  const runtimeRun = async (id: string): Promise<RuntimeRunRecord | undefined> => {
    try {
      return (await runtimeStore?.getRun(id)) as RuntimeRunRecord | undefined;
    } catch {
      return undefined;
    }
  };
  const runRecord = async (id: string): Promise<LocalApiRun> => {
    const stored = repository.getRun(id);
    if (stored) return normalizeRun(stored);
    const runtime = await runtimeRun(id);
    if (runtime) return normalizeRun(runtime);
    notFound("Run");
  };
  const listEvents = async (runId: string, after?: number): Promise<LocalApiEvent[]> => {
    // Storage is the canonical API source because its EventRecord retains the
    // durable event ID, monotonic offset, and provider/session/tool metadata.
    if (repository.getRun(runId))
      return repository
        .listEvents(runId, { afterSequence: after, limit: 1_000 })
        .map((event) => ({ ...event, source: "storage" as const }));
    const canonical = runtimeStore?.listTraceEvents?.(runId);
    if (canonical) {
      return canonical
        .map(normalizeCanonicalEvent)
        .filter((event) => after === undefined || event.sequence > after)
        .sort((left, right) => left.sequence - right.sequence);
    }
    if (runtimeStore)
      return (await runtimeStore.listEvents(runId))
        .filter((event) => after === undefined || event.sequence > after)
        .map(normalizeRuntimeEvent)
        .sort((left, right) => left.sequence - right.sequence);
    if (scheduler) {
      try {
        return (await scheduler.snapshot(runId)).events
          .filter((event) => after === undefined || event.sequence > after)
          .map(normalizeRuntimeEvent)
          .sort((left, right) => left.sequence - right.sequence);
      } catch {
        /* no runtime-backed events */
      }
    }
    return [];
  };
  const listAttempts = async (runId: string): Promise<LocalApiAttempt[]> => {
    if (runtimeStore) {
      const attempts = await runtimeStore.listAttempts(runId);
      if (attempts.length) return attempts.map(normalizeAttempt);
    }
    if (scheduler) {
      try {
        const snapshot = await scheduler.snapshot(runId);
        if (snapshot.attempts.length) return snapshot.attempts.map(normalizeAttempt);
      } catch {
        /* persisted fallback */
      }
    }
    return repository.listAttempts(runId).map(normalizeAttempt);
  };
  const listRuns = async (status?: RunRecord["status"]): Promise<LocalApiRun[]> => {
    const byId = new Map<string, LocalApiRun>();
    for (const run of repository.listRuns(status)) byId.set(run.id, normalizeRun(run));
    if (runtimeStore) {
      for (const run of await runtimeStore.listRuns()) {
        const normalized = normalizeRun(run);
        if (!status || normalized.status === status) byId.set(normalized.id, normalized);
      }
    }
    return [...byId.values()].sort((left, right) =>
      `${left.createdAt}:${left.id}`.localeCompare(`${right.createdAt}:${right.id}`),
    );
  };
  api.get("/runs", async (c) =>
    c.json({ runs: await listRuns(c.req.query("status") as RunRecord["status"] | undefined) }),
  );
  api.post("/runs", async (c) => {
    if (!scheduler) capability("Runtime scheduler is not configured");
    const body = await jsonBody(c, maxBodyBytes);
    const workflowId = requiredString(body, "workflowId");
    const version =
      body.version === undefined ? Number(body.workflowVersion ?? 1) : Number(body.version);
    if (!Number.isInteger(version) || version < 1)
      throw new ApiError(400, "invalid_request", "version must be a positive integer");
    const workflow =
      repository.getWorkflowVersion(workflowId, version) ?? notFound("Workflow version");
    const run = await scheduler.start(
      workflow.definition as WorkflowDefinition,
      jsonObject(body.input),
    );
    hub.notify(run.runId);
    return c.json(normalizeRun(run), 201);
  });
  api.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    let runtimeSnapshot: RuntimeSnapshot | undefined;
    if (scheduler) {
      try {
        runtimeSnapshot = await scheduler.snapshot(id);
      } catch {
        /* persisted fallback */
      }
    }
    const run = runtimeSnapshot ? normalizeRun(runtimeSnapshot.run) : await runRecord(id);
    const events = await listEvents(id);
    const attempts = runtimeSnapshot?.attempts.length
      ? runtimeSnapshot.attempts.map(normalizeAttempt)
      : await listAttempts(id);
    const workflow = repository.getWorkflowVersion(run.workflowId, run.workflowVersion);
    return c.json({
      ...run,
      attempts,
      events,
      artifacts: repository.listArtifacts(id),
      approvals: runtimeSnapshot?.approvals ?? [],
      ...(workflow ? { workflow } : {}),
    } satisfies LocalApiRunSnapshot);
  });
  api.get("/runs/:id/attempts", async (c) => {
    await runRecord(c.req.param("id"));
    return c.json({ attempts: await listAttempts(c.req.param("id")) });
  });
  api.get("/runs/:id/events", async (c) => {
    await runRecord(c.req.param("id"));
    const after =
      c.req.query("after") === undefined ? undefined : readLastEventId(c.req.query("after"));
    return c.json({ events: await listEvents(c.req.param("id"), after) });
  });
  api.get("/runs/:id/artifacts", async (c) => {
    await runRecord(c.req.param("id"));
    return c.json({ artifacts: repository.listArtifacts(c.req.param("id")) });
  });
  api.get("/attempts/:id", (c) =>
    c.json(repository.getAttempt(c.req.param("id")) ?? notFound("Attempt")),
  );
  api.get("/artifacts/:id", (c) =>
    c.json(repository.getArtifact(c.req.param("id")) ?? notFound("Artifact")),
  );
  const requireScheduler = (): RuntimeScheduler =>
    scheduler ?? capability("Runtime scheduler is not configured");
  const command = (
    name: string,
    handler: (c: Context, body: Record<string, unknown>) => Promise<unknown> | unknown,
  ) => {
    api.post(`/runs/:id/${name}`, async (c) => {
      const id = c.req.param("id");
      await runRecord(id);
      if (!scheduler) capability(`Runtime scheduler does not implement ${name}`);
      const body = await jsonBody(c, maxBodyBytes);
      const result = await handler(c, body);
      hub.notify(id);
      return c.json(result as never);
    });
  };
  command("pause", (c) => requireScheduler().pause(c.req.param("id")));
  command("resume", (c) => requireScheduler().resume(c.req.param("id")));
  command("cancel", (c, body) =>
    requireScheduler().cancel(
      c.req.param("id"),
      typeof body.reason === "string" ? body.reason : "cancelled by user",
    ),
  );
  command("retry", (c, body) =>
    requireScheduler().retry(
      c.req.param("id"),
      requiredString(body, "nodeId"),
      jsonObject(body.input),
    ),
  );
  command("replay", () =>
    capability("Runtime replay is not available through the injected scheduler"),
  );
  command("fork", () => capability("Runtime fork is not available through the injected scheduler"));
  const commandNames = new Set(["pause", "resume", "cancel", "retry", "replay", "fork"]);
  const executeNamedCommand = async (name: string, c: Context, body: Record<string, unknown>) => {
    const id = c.req.param("id");
    await runRecord(id);
    if (!commandNames.has(name)) throw new ApiError(404, "not_found", "Command not found");
    if (!scheduler) capability(`Runtime scheduler does not implement ${name}`);
    switch (name) {
      case "pause":
        return scheduler.pause(id);
      case "resume":
        return scheduler.resume(id);
      case "cancel":
        return scheduler.cancel(
          id,
          typeof body.reason === "string" ? body.reason : "cancelled by user",
        );
      case "retry":
        return scheduler.retry(id, requiredString(body, "nodeId"), jsonObject(body.input));
      case "replay":
        return capability("Runtime replay is not available through the injected scheduler");
      case "fork":
        return capability("Runtime fork is not available through the injected scheduler");
    }
    return capability("Command is not implemented");
  };
  api.post("/runs/:id/commands/:name", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const result = await executeNamedCommand(c.req.param("name"), c, body);
    hub.notify(c.req.param("id"));
    return c.json(result as never);
  });
  api.post("/runs/:id/command", async (c) => {
    const body = await jsonBody(c, maxBodyBytes);
    const result = await executeNamedCommand(requiredString(body, "command"), c, body);
    hub.notify(c.req.param("id"));
    return c.json(result as never);
  });
  api.get("/runs/:id/events/stream", (c) => {
    const runId = c.req.param("id");
    const signal = c.req.raw.signal;
    const initial = readLastEventId(c.req.header("Last-Event-ID") ?? c.req.query("after"));
    return streamSSE(c, async (stream) => {
      await runRecord(runId);
      let cursor = initial;
      let lastHeartbeat = Date.now();
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      await stream.writeSSE({ event: "heartbeat", data: "{}" });
      while (!closed && !signal.aborted) {
        const events = await listEvents(runId, cursor);
        events.sort((left, right) => left.sequence - right.sequence);
        for (const event of events) {
          if (event.sequence <= cursor) continue;
          await stream.writeSSE({
            id: String(event.sequence),
            event: event.type,
            data: JSON.stringify(event),
          });
          cursor = event.sequence;
        }
        if (Date.now() - lastHeartbeat >= heartbeatMs) {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
          lastHeartbeat = Date.now();
        }
        const waiterAbort = new AbortController();
        try {
          await Promise.race([hub.wait(runId, waiterAbort.signal), sleep(pollMs, signal)]);
        } finally {
          // A polling tick may win the race. Cancel its hub waiter so a closed
          // connection never leaves a resolver registered until the next event.
          waiterAbort.abort();
        }
      }
    });
  });
  const root = new Hono();
  root.route("/api/v1", api);
  root.route("/v1", api);
  return root;
}

export function startLocalApiServer(
  options: LocalApiOptions & Partial<LocalServerConfig>,
): LocalApiServer {
  const config = createLocalServerConfig(options);
  const app = createLocalApi({ ...options, token: config.token, origins: config.origins });
  if (typeof Bun === "undefined") throw new Error("The local API server requires Bun");
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
  return { ...config, app, server };
}
export { ApiError };
export {
  applyWorkflowPatch,
  validateWorkflowForSave,
  WorkflowEditError,
  workflowVersionDiff,
} from "./workflow-edit.ts";
