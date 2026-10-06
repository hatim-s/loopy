import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Json, RunRecord } from "../core/model.js";
import { errorMessage } from "../runtime/errors.js";
import { localRunOptions } from "./process.js";
import { defaultHome, Registry } from "./registry.js";
import { createLocalRuntime } from "./runtime.js";

type ServerOptions = { home?: string; cwd?: string; port?: number; assets?: string };
type Asset = { body: Blob; type: string };
type Route = {
  method: "GET" | "POST";
  pattern: RegExp;
  handle: (match: RegExpExecArray, request: Request, url: URL) => Promise<Response>;
};

const DEFAULT_PORT = 4310;
const MAX_BODY_BYTES = 1024 * 1024;
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

/** Reads every regular file once so later builds cannot swap code under a running viewer. */
function snapshotAssets(directory: string): Map<string, Asset> {
  const files = new Map<string, Asset>();
  const visit = (path: string, prefix: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const filename = join(path, entry.name);
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(filename, `${key}/`);
      else if (entry.isFile())
        files.set(key, {
          body: new Blob([new Uint8Array(readFileSync(filename))]),
          type: Bun.file(filename).type,
        });
    }
  };
  if (existsSync(directory)) visit(directory, "");
  return files;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("Send an application/json request body.");
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

export function startServer(options: ServerOptions = {}) {
  const home = options.home ?? defaultHome();
  const cwd = resolve(options.cwd ?? process.cwd());
  const registry = new Registry(home, cwd);
  const local = createLocalRuntime({ home });
  const { runtime } = local;
  const token = crypto.randomUUID();
  const assets = snapshotAssets(
    resolve(options.assets ?? resolve(import.meta.dir, "../../dist/studio")),
  );

  // Executions run in the background; the viewer polls run detail for progress.
  const controllers = new Map<string, AbortController>();
  const jobs = new Set<Promise<unknown>>();
  const launch = (run: RunRecord, retryUncertain = false) => {
    if (controllers.has(run.id)) throw new Error("This run is already executing.");
    const controller = new AbortController();
    controllers.set(run.id, controller);
    const job = runtime
      .execute(run.id, { retryUncertain, signal: controller.signal })
      .catch((error: unknown) => console.error(`Run ${run.id}: ${errorMessage(error)}`))
      .finally(() => {
        controllers.delete(run.id);
        jobs.delete(job);
      });
    jobs.add(job);
  };

  const authorized = (request: Request) => {
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const routes: Route[] = [
    { method: "GET", pattern: /^\/api\/config$/, handle: async () => json({ cwd }) },
    { method: "GET", pattern: /^\/api\/workflows$/, handle: async () => json(registry.list()) },
    {
      method: "GET",
      pattern: /^\/api\/workflows\/([^/]+)$/,
      handle: async ([, slug]) => json(registry.get(slug as string).workflow),
    },
    {
      method: "GET",
      pattern: /^\/api\/runs$/,
      handle: async (_match, _request, url) =>
        json(await runtime.listRuns(url.searchParams.get("slug") ?? undefined)),
    },
    {
      method: "POST",
      pattern: /^\/api\/runs$/,
      handle: async (_match, request) => {
        const body = await jsonBody(request);
        if (typeof body.slug !== "string") throw new Error("A saved workflow slug is required.");
        if (body.mode !== "sandbox" && body.mode !== "full")
          throw new Error("Choose sandbox or full execution.");
        const saved = registry.get(body.slug);
        const run = await runtime.createRun(
          saved.workflow,
          (body.input === undefined ? {} : body.input) as Json,
          { ...localRunOptions(cwd, body.mode), secretBindings: saved.secretBindings },
        );
        launch(run);
        return json(run, 202);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/([^/]+)$/,
      handle: async ([, id]) => {
        const run = await runtime.getRun(id as string);
        if (!run) return json({ error: "Run not found." }, 404);
        return json({
          run,
          attempts: await runtime.getAttempts(run.id),
          events: await runtime.getEvents(run.id),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/runs\/([^/]+)\/resume$/,
      handle: async ([, id], request) => {
        const run = await runtime.getRun(id as string);
        if (!run) return json({ error: "Run not found." }, 404);
        const body = await jsonBody(request);
        if (body.retryUncertain !== undefined && typeof body.retryUncertain !== "boolean")
          throw new Error("retryUncertain must be boolean.");
        if (run.status === "succeeded" || run.status === "running")
          throw new Error(`Cannot resume a ${run.status} run.`);
        launch(run, body.retryUncertain === true);
        return json(await runtime.getRun(run.id), 202);
      },
    },
  ];

  const api = async (request: Request, url: URL, path: string): Promise<Response> => {
    if (!authorized(request))
      return json({ error: "Open the viewer URL printed by loopy ui to authenticate." }, 401);
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(path);
      if (match) return route.handle(match, request, url);
    }
    return json({ error: "Endpoint not found." }, 404);
  };

  const serveAsset = (request: Request, path: string): Response => {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 });
    const file = assets.get(path === "/" ? "index.html" : path.replace(/^\/+/, ""));
    if (!file)
      return new Response("Viewer assets missing. Run bun run build first.", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file.body, {
      headers: {
        "Content-Type": file.type,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      },
    });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_PORT,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const ownOrigin = `http://127.0.0.1:${server.port}`;
        if (url.origin !== ownOrigin || request.headers.get("host") !== `127.0.0.1:${server.port}`)
          return json({ error: "Invalid host." }, 403);
        const origin = request.headers.get("origin");
        if (origin && origin !== ownOrigin)
          return json({ error: "Cross-origin access is disabled." }, 403);
        const path = decodeURIComponent(url.pathname);
        return path.startsWith("/api/") ? await api(request, url, path) : serveAsset(request, path);
      } catch (error) {
        return json({ error: errorMessage(error) }, 400);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/#token=${token}`,
    async stop() {
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled(jobs);
      await server.stop(true);
      local.close();
    },
  };
}
