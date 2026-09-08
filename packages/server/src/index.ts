import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  type JsonObject,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from "@loopy/contracts";
import { ApiError, createLocalApi, createLocalServerConfig } from "@loopy/local-api";
import { assertWorkflowProvidersReady, createDefaultProviderRegistry } from "@loopy/providers";
import { createProviderExecutor, type ProviderExecutor, RuntimeScheduler } from "@loopy/runtime";
import { openStorage, SqliteRuntimeStore } from "@loopy/storage";
import { createToolRegistry } from "@loopy/tools";
import { decodeTraceJsonl } from "@loopy/tracing";
import {
  createShellExecutor,
  createShellVerifier,
  prepareWorkflowWorkspace,
} from "@loopy/workspace";
import { z } from "zod";
import { createExtractionService } from "./extraction";
import { handleMcpRequest } from "./mcp";
import type { ProjectManager } from "./projects";

export type ServerOptions = {
  projectDir: string;
  projects?: ProjectManager;
  studioDir: string;
  port?: number;
  token?: string;
  provider?: ProviderExecutor;
  onShutdown?: () => void;
};

export async function startServer(options: ServerOptions) {
  const projectDir = realpathSync(options.projectDir);
  const studioDir = realpathSync(options.studioDir);
  const index = await Bun.file(resolve(studioDir, "index.html")).text();
  const seed = createLocalServerConfig({ port: options.port, token: options.token });
  const origin = `http://${seed.host}:${seed.port}`;
  const config = { ...seed, origins: [origin] };
  const storage = openStorage({ projectDir });
  const store = new SqliteRuntimeStore(storage);
  const registry = createDefaultProviderRegistry();
  const tools = createToolRegistry();
  const provider =
    options.provider ??
    createProviderExecutor({
      registry,
      onEvent(event) {
        store.appendTraceEvent(event.runId, {
          ...event,
          sequence: store.listTraceEvents(event.runId).length,
        });
      },
    });
  const runtime = new RuntimeScheduler({
    store,
    provider: {
      async execute(context) {
        const run = await store.getRun(context.runId);
        if (run?.plan.execution?.mode === "local")
          return {
            status: "succeeded",
            outputs: {},
            summary: "Local simulation: agent call skipped",
          };
        return provider.execute(context);
      },
    },
    shell: createShellExecutor(),
    verifier: {
      async verify(context) {
        const run = await store.getRun(context.runId);
        const workingDirectory = run?.plan.policies?.workspace?.workingDirectory;
        if (typeof workingDirectory !== "string") throw new Error("Run workspace is missing");
        return createShellVerifier({ workingDirectory }).verify(context);
      },
    },
  });
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const startWithMode = async (
    definition: WorkflowDefinition,
    input?: JsonObject,
    mode?: "local" | "live",
  ) => {
    if (closing) throw new ApiError(503, "server_stopping", "Server is stopping");
    const parsed = WorkflowDefinitionSchema.safeParse(definition);
    if (!parsed.success) throw new ApiError(422, "invalid_workflow", parsed.error.message);
    let prepared: Awaited<ReturnType<typeof prepareWorkflowWorkspace>> | undefined;
    try {
      const usesRegisteredProvider = mode !== "local" && !options.provider;
      prepared = await prepareWorkflowWorkspace(parsed.data, projectDir);
      if (usesRegisteredProvider) await assertWorkflowProvidersReady(prepared.definition, registry);
      // Workspaces remain available for retries, inspection, and checkpoint forks.
      return await runtime.start(
        { ...prepared.definition, ...(mode ? { execution: { mode } } : {}) },
        input,
      );
    } catch (error) {
      if (prepared) await prepared.cleanup();
      throw new ApiError(
        422,
        "run_start_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const startWorkflow: RuntimeScheduler["start"] = (definition, input) =>
    startWithMode(WorkflowDefinitionSchema.parse(definition), input);
  const extraction = createExtractionService(storage);
  const app = createLocalApi({
    importTrace(content) {
      const result = decodeTraceJsonl(content, { rejectDiagnostics: true });
      store.appendTraceEvents(result.events);
      return { events: result.events.length, lines: result.lines };
    },
    importSession: (input) => storage.runtime.importCanonicalSession(input),
    extractSession: (id) => extraction.extract(id),
    storage,
    tools,
    runtime,
    runtimeStore: store,
    providerRegistry: registry,
    startWorkflow,
    scheduleEngine: {
      start: (plan, input, mode) =>
        startWithMode(WorkflowDefinitionSchema.parse(plan), input, mode),
      wait: (id) => runtime.wait(id),
    },
    token: config.token,
    origins: config.origins,
  });
  const bootstrap = `<script>globalThis.__LOOPY_STUDIO_SESSION__=${JSON.stringify({ baseUrl: "/api/v1", token: config.token })};</script>`;
  const html = index.replace("</head>", `${bootstrap}</head>`);
  const authenticated = async (request: Request) => {
    const health = new Request(`${origin}/api/v1/health`, { headers: request.headers });
    return app.fetch(health);
  };
  let listener: ReturnType<typeof Bun.serve> | undefined;
  try {
    listener = Bun.serve({
      hostname: config.host,
      port: config.port,
      idleTimeout: 0,
      maxRequestBodySize: 1_048_576,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.origin !== origin) return new Response("Invalid host", { status: 403 });
        if (closing) return new Response("Server is stopping", { status: 503 });
        if (url.pathname.startsWith("/api/v1/projects")) {
          const auth = await authenticated(request);
          if (!auth.ok) return auth;
          if (!options.projects)
            return Response.json(
              { error: { message: "Project switching is not configured" } },
              { status: 503 },
            );
          try {
            if (url.pathname === "/api/v1/projects" && request.method === "GET")
              return Response.json(await options.projects.list());
            if (url.pathname === "/api/v1/projects/open" && request.method === "POST") {
              const input = z.object({ path: z.string().min(1) }).parse(await request.json());
              return Response.json(await options.projects.open(input.path));
            }
            if (url.pathname === "/api/v1/projects/forget" && request.method === "POST") {
              const input = z
                .object({ id: z.string().regex(/^[a-f0-9]{24}$/) })
                .parse(await request.json());
              options.projects.forget(input.id);
              return Response.json({ forgotten: true });
            }
            return new Response("Not found", { status: 404 });
          } catch (error) {
            return Response.json(
              {
                error: {
                  message: error instanceof Error ? error.message : "Project operation failed",
                },
              },
              { status: 422 },
            );
          }
        }
        if (url.pathname === "/mcp") {
          const auth = await authenticated(request);
          if (!auth.ok) return auth;
          if (Number(request.headers.get("content-length") ?? 0) > 1_048_576)
            return new Response("Request too large", { status: 413 });
          return handleMcpRequest(request, async (path, body) => {
            const response = await app.request(`/api/v1${path}`, {
              method: body === undefined ? "GET" : "POST",
              headers: {
                Authorization: `Bearer ${config.token}`,
                "Content-Type": "application/json",
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
            const result: unknown = await response.json();
            if (!response.ok) throw new Error(JSON.stringify(result));
            return result;
          });
        }
        if (url.pathname === "/api/v1/server" || url.pathname === "/api/v1/server/stop") {
          const auth = await authenticated(request);
          if (!auth.ok) return auth;
          if (url.pathname.endsWith("/stop")) {
            if (request.method !== "POST")
              return new Response("Method not allowed", { status: 405 });
            setTimeout(() => void stop().then(() => options.onShutdown?.()), 10);
            return Response.json({ stopping: true });
          }
          return Response.json({ product: "Loopy", pid: process.pid, projectDir, url: origin });
        }
        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"))
          return app.fetch(request);
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", { status: 405 });
        if (request.headers.get("origin") && request.headers.get("origin") !== origin)
          return new Response("Origin denied", { status: 403 });
        if (request.headers.get("sec-fetch-site") === "cross-site")
          return new Response("Cross-site request denied", { status: 403 });
        const headers = {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        };
        if (url.pathname === "/" || url.pathname === "/index.html")
          return new Response(html, { headers });
        let path: string;
        try {
          path = realpathSync(resolve(studioDir, `.${decodeURIComponent(url.pathname)}`));
        } catch {
          return new Response(html, { headers });
        }
        if (!path.startsWith(`${studioDir}${sep}`))
          return new Response("Not found", { status: 404 });
        return new Response(Bun.file(path));
      },
    });
    await runtime.recover();
  } catch (error) {
    listener?.stop(true);
    try {
      await runtime.shutdown();
    } finally {
      storage.close();
    }
    throw error;
  }
  let ticking = false;
  let tick: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    if (ticking || closing) return;
    ticking = true;
    tick = Promise.resolve(
      app.request("/api/v1/schedules/tick", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}` },
      }),
    )
      .then(async (response) => {
        if (!response.ok) console.error(`Loopy schedule tick failed: ${response.status}`);
      })
      .catch((error: unknown) => console.error("Loopy schedule tick failed", error))
      .finally(() => {
        ticking = false;
      });
  }, 1_000);
  function stop(): Promise<void> {
    shutdown ??= (async () => {
      closing = true;
      clearInterval(timer);
      await tick;
      // Pause at a node boundary. Stopping the server never silently replays a command.
      await tools.drain();
      await extraction.drain();
      await runtime.shutdown();
      listener?.stop(true);
      storage.close();
    })();
    return shutdown;
  }
  return { url: origin, token: config.token, projectDir, runtime, storage, stop };
}

export { startMcpStdio } from "./mcp";

export {
  createProjectCatalog,
  type ProjectManager,
  type ProjectRecord,
  type ProjectSummary,
  projectPath,
} from "./projects";
