import { randomBytes, timingSafeEqual } from "node:crypto";
import type { JsonObject, WorkflowDefinition } from "@loopy/contracts";
import type { ProviderRegistry } from "@loopy/providers";
import type { RuntimeScheduler, RuntimeStore } from "@loopy/runtime";
import type {
  ArtifactRecord,
  AttemptRecord,
  EventRecord,
  ExtractionJobRecord,
  ExtractionReviewRecord,
  ImportedSessionRecord,
  RunRecord,
  Storage,
  WorkflowVersionRecord,
} from "@loopy/storage";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

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
};
export type LocalServerConfig = {
  host: "127.0.0.1" | "::1";
  port: number;
  token: string;
  origins: readonly string[];
};
export type LocalApiServer = LocalServerConfig & { app: Hono; server: { stop(): void } };

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
  return { host, port, token: input.token ?? newToken(), origins: exactOrigins(input.origins) };
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
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Request failed")
    .replace(/[\r\n]/g, " ")
    .slice(0, 500);
}
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw new ApiError(413, "body_too_large", "Request body exceeds the local API limit");
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

/** Construct the authenticated local API. It does not listen. */
export function createLocalApi(options: LocalApiOptions): Hono {
  const repository = options.storage.runtime;
  const scheduler = options.runtime ?? options.scheduler;
  const registry = options.providerRegistry ?? options.registry;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const heartbeatMs = Math.max(1_000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const pollMs = Math.max(25, options.pollMs ?? DEFAULT_POLL_MS);
  const token = options.token ?? newToken();
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
      error instanceof ApiError ? error : new ApiError(500, "internal_error", errorMessage(error));
    return c.json(
      { error: { code: normalized.code, message: normalized.message } },
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
  api.get("/workflows/:id/:version", (c) => {
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1)
      throw new ApiError(400, "invalid_request", "Workflow version must be positive");
    return c.json(
      repository.getWorkflowVersion(c.req.param("id"), version) ?? notFound("Workflow version"),
    );
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
      repository.createWorkflowVersion({
        workflowId: typeof body.workflowId === "string" ? body.workflowId : undefined,
        version: typeof body.version === "number" ? body.version : undefined,
        definition,
      }),
      201,
    );
  });

  const runRecord = (id: string): RunRecord => repository.getRun(id) ?? notFound("Run");
  const listEvents = async (
    runId: string,
    after?: number,
  ): Promise<Array<EventRecord | import("@loopy/runtime").RuntimeEvent>> =>
    options.runtimeStore
      ? (await options.runtimeStore.listEvents(runId)).filter(
          (event) => after === undefined || event.sequence > after,
        )
      : repository.listEvents(runId, { afterSequence: after, limit: 1_000 });
  api.get("/runs", (c) =>
    c.json({ runs: repository.listRuns(c.req.query("status") as RunRecord["status"] | undefined) }),
  );
  api.post("/runs", async (c) => {
    if (!scheduler) capability("Runtime scheduler is not configured");
    const body = await jsonBody(c, maxBodyBytes);
    const workflowId = requiredString(body, "workflowId");
    const version = body.version === undefined ? 1 : Number(body.version);
    if (!Number.isInteger(version) || version < 1)
      throw new ApiError(400, "invalid_request", "version must be a positive integer");
    const workflow =
      repository.getWorkflowVersion(workflowId, version) ?? notFound("Workflow version");
    const run = await scheduler.start(
      workflow.definition as WorkflowDefinition,
      jsonObject(body.input),
    );
    hub.notify(run.runId);
    return c.json(run, 201);
  });
  api.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (scheduler) {
      try {
        return c.json(await scheduler.snapshot(id));
      } catch {
        /* persisted fallback */
      }
    }
    return c.json(runRecord(id));
  });
  api.get("/runs/:id/attempts", (c) => {
    runRecord(c.req.param("id"));
    return c.json({ attempts: repository.listAttempts(c.req.param("id")) });
  });
  api.get("/runs/:id/events", async (c) => {
    runRecord(c.req.param("id"));
    const after =
      c.req.query("after") === undefined ? undefined : readLastEventId(c.req.query("after"));
    return c.json({ events: await listEvents(c.req.param("id"), after) });
  });
  api.get("/runs/:id/artifacts", (c) => {
    runRecord(c.req.param("id"));
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
      runRecord(id);
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
    runRecord(id);
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
    runRecord(runId);
    const signal = c.req.raw.signal;
    const initial = readLastEventId(c.req.header("Last-Event-ID") ?? c.req.query("after"));
    return streamSSE(c, async (stream) => {
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
        await Promise.race([hub.wait(runId, signal), sleep(pollMs, signal)]);
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
