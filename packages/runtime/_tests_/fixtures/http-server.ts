import { join } from "node:path";
import type { Cause } from "effect";
import { type ServerOptions, startServer } from "../../src/local/server/start-server";
import { onCleanup } from "./test-scope";

const TOKEN = "fixture-token";

/** Serves a service through the authenticated local HTTP server until the test ends. */
export function serveHttp(
  options: Pick<ServerOptions, "service" | "store" | "cwd"> & { concurrency?: number },
) {
  const causes: Cause.Cause<unknown>[] = [];

  const server = startServer({
    ...options,
    token: TOKEN,
    port: 0,
    assets: join(options.cwd, "assets"),
    daemon: {
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      concurrency: options.concurrency ?? 4,
    },
    onError: (cause) => causes.push(cause),
  });

  onCleanup(() => server.stop());

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}/api${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

  return { request, causes };
}
