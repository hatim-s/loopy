import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { RunRecord } from "../../core/index.js";
import { errorMessage } from "../../core/index.js";
import { defaultHome } from "../home.js";
import { Registry } from "../registry/registry.js";
import { createLocalRuntime } from "../runtime.js";
import { serveAsset, snapshotAssets } from "./assets.js";
import { apiRoutes, dispatch, json } from "./routes.js";

export const DEFAULT_PORT = 4310;
const MAX_BODY_BYTES = 1024 * 1024;

export type ServerOptions = {
  home?: string;
  cwd?: string;
  port?: number;
  assets?: string;
  /** Receives one line per background run that failed. Defaults to stderr. */
  log?: (line: string) => void;
};

function bearerMatches(request: Request, token: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Only the loopback origin this server answers on may call it. */
function originRejection(request: Request, url: URL, ownOrigin: string): Response | undefined {
  if (
    url.origin !== ownOrigin ||
    request.headers.get("host") !== ownOrigin.slice("http://".length)
  ) {
    return json({ error: "Invalid host." }, 403);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== ownOrigin) {
    return json({ error: "Cross-origin access is disabled." }, 403);
  }
  return undefined;
}

export function startServer(options: ServerOptions = {}) {
  const home = options.home ?? defaultHome();
  const cwd = resolve(options.cwd ?? process.cwd());
  // biome-ignore lint/suspicious/noConsole: the default sink for background run failures.
  const log = options.log ?? console.error;
  const registry = new Registry(home, cwd);
  const local = createLocalRuntime({ home });
  const { runtime } = local;
  const token = crypto.randomUUID();
  const assets = snapshotAssets(
    resolve(options.assets ?? resolve(import.meta.dir, "../../../dist/studio")),
  );

  // Executions run in the background; the viewer polls run detail for progress.
  const controllers = new Map<string, AbortController>();
  const jobs = new Set<Promise<unknown>>();
  const launch = (run: RunRecord, retryUncertain = false) => {
    if (controllers.has(run.id)) {
      throw new Error("This run is already executing.");
    }
    const controller = new AbortController();
    controllers.set(run.id, controller);
    const job = runtime
      .execute(run.id, { retryUncertain, signal: controller.signal })
      .catch((error: unknown) => log(`Run ${run.id} failed: ${errorMessage(error)}`))
      .finally(() => {
        controllers.delete(run.id);
        jobs.delete(job);
      });
    jobs.add(job);
  };
  const routes = apiRoutes({ cwd, registry, runtime, launch });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_PORT,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const rejection = originRejection(request, url, `http://127.0.0.1:${server.port}`);
        if (rejection) {
          return rejection;
        }
        const path = decodeURIComponent(url.pathname);
        if (!path.startsWith("/api/")) {
          return serveAsset(assets, request, path);
        }
        if (!bearerMatches(request, token)) {
          return json({ error: "Open the viewer URL printed by loopy ui to authenticate." }, 401);
        }
        return await dispatch(routes, request, url, path);
      } catch (error) {
        return json({ error: errorMessage(error) }, 400);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/#token=${token}`,
    async stop() {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      await Promise.allSettled(jobs);
      await server.stop(true);
      local.close();
    },
  };
}
