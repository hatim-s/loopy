import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Json, RunRecord } from "./model.ts";
import { defaultHome, Registry } from "./registry.ts";
import { Runtime } from "./runtime.ts";

type ServerOptions = { home?: string; cwd?: string; port?: number; assets?: string };

function snapshotAssets(directory: string) {
  const files = new Map<string, { body: Uint8Array; type: string }>();
  const visit = (path: string, prefix: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const filename = join(path, entry.name);
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(filename, `${key}/`);
      else if (entry.isFile())
        files.set(key, { body: readFileSync(filename), type: Bun.file(filename).type });
    }
  };
  if (existsSync(directory)) visit(directory, "");
  return files;
}

export function startServer(options: ServerOptions = {}) {
  const home = options.home ?? defaultHome();
  const cwd = resolve(options.cwd ?? process.cwd());
  const registry = new Registry(home);
  const runtime = new Runtime({ home });
  const token = crypto.randomUUID();
  // Workflow writes must not replace the code served by a running viewer.
  const assets = snapshotAssets(
    resolve(options.assets ?? resolve(import.meta.dir, "../dist/studio")),
  );
  const controllers = new Map<string, AbortController>();
  const jobs = new Set<Promise<unknown>>();
  const launch = (run: RunRecord, retryUncertain = false) => {
    if (controllers.has(run.id)) throw new Error("This run is already executing.");
    const controller = new AbortController();
    controllers.set(run.id, controller);
    const job = runtime
      .execute(run.id, { retryUncertain, signal: controller.signal })
      .catch((error: unknown) => {
        console.error(`Run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        controllers.delete(run.id);
        jobs.delete(job);
      });
    jobs.add(job);
  };
  const json = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  const authorized = (request: Request) => {
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const body = async (request: Request): Promise<Record<string, unknown>> => {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new Error("Send an application/json request body.");
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a JSON object.");
    return value as Record<string, unknown>;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 4310,
    maxRequestBodySize: 1024 * 1024,
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
        if (path.startsWith("/api/")) {
          if (!authorized(request))
            return json({ error: "Open the viewer URL printed by loopy ui to authenticate." }, 401);
          const method = request.method;
          if (method === "GET" && path === "/api/config") return json({ cwd });
          if (method === "GET" && path === "/api/workflows") return json(registry.list());
          const workflowMatch = /^\/api\/workflows\/([^/]+)$/.exec(path);
          if (method === "GET" && workflowMatch?.[1])
            return json(registry.get(workflowMatch[1]).workflow);
          if (path === "/api/runs") {
            if (method === "GET")
              return json(runtime.listRuns(url.searchParams.get("slug") ?? undefined));
            if (method === "POST") {
              const value = await body(request);
              if (typeof value.slug !== "string")
                throw new Error("A saved workflow slug is required.");
              if (value.mode !== "sandbox" && value.mode !== "full")
                throw new Error("Choose sandbox or full execution.");
              const run = runtime.createRun(
                registry.get(value.slug).workflow,
                (value.input === undefined ? {} : value.input) as Json,
                { cwd, mode: value.mode },
              );
              launch(run);
              return json(run, 202);
            }
          }
          const runMatch = /^\/api\/runs\/([^/]+)(\/resume)?$/.exec(path);
          if (runMatch?.[1]) {
            const run = runtime.getRun(runMatch[1]);
            if (!run) return json({ error: "Run not found." }, 404);
            if (method === "GET" && !runMatch[2])
              return json({
                run,
                attempts: runtime.getAttempts(run.id),
                events: runtime.getEvents(run.id),
              });
            if (method === "POST" && runMatch[2]) {
              const value = await body(request);
              if (value.retryUncertain !== undefined && typeof value.retryUncertain !== "boolean")
                throw new Error("retryUncertain must be boolean.");
              if (run.status === "succeeded" || run.status === "running")
                throw new Error(`Cannot resume a ${run.status} run.`);
              launch(run, value.retryUncertain === true);
              return json(runtime.getRun(run.id), 202);
            }
          }
          return json({ error: "Endpoint not found." }, 404);
        }
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", { status: 405 });
        const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
        const file = assets.get(relative);
        if (!file)
          return new Response("Viewer assets missing. Run bun run build first.", { status: 404 });
        return new Response(request.method === "HEAD" ? null : file.body, {
          headers: {
            "Content-Type": file.type,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
          },
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/#token=${token}`,
    async stop() {
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled(jobs);
      await server.stop(true);
      runtime.close();
    },
  };
}
