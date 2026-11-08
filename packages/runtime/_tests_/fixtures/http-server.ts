import { join } from "node:path";
import {
  decodeRouteResponse,
  type RouteInput,
  type RouteName,
  routeRequest,
  routes,
} from "@loopy/contract";
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
  const origin = `http://127.0.0.1:${server.port}`;

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}/api${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

  /** The typed route client, failing the test on any answer other than success. */
  const call = async <K extends RouteName>(name: K, input: RouteInput<(typeof routes)[K]>) => {
    const route = routeRequest(routes[name], input);

    const response = await fetch(`${origin}${route.url}`, {
      method: route.method,
      headers: { ...route.headers, Authorization: `Bearer ${TOKEN}` },
      body: route.body,
    });

    const outcome = decodeRouteResponse(routes[name], response.status, await response.text());

    if (outcome.kind !== "ok") {
      throw new Error(`${name} answered ${response.status}: ${JSON.stringify(outcome)}`);
    }

    return outcome.value;
  };

  return { request, call, causes, origin };
}
