import {
  decodeBoundary,
  decodeRouteResponse,
  isTerminalRun,
  type Json,
  type Route,
  type RouteInput,
  type RouteResult,
  type RunSnapshotView,
  routeRequest,
  routes,
} from "@loopy/contract";
import type { SandboxAttemptRequest } from "@loopy/contract/sandbox";
import type { Schema } from "effect";
import { assert, JourneyFailure } from "./assert";
import { until } from "./poll";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readText(response: Response): Promise<string> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new JourneyFailure({
      failure: "non_json_response_discarded",
      httpStatus: response.status,
    });
  }

  const text = await response.text();
  assert(Buffer.byteLength(text) <= MAX_RESPONSE_BYTES, "response_exceeds_8_mib");

  return text;
}

export async function readJson<T>(
  response: Response,
  schema: Schema.Codec<T, unknown, never, never>,
): Promise<T> {
  const text = await readText(response);

  try {
    return decodeBoundary(schema)(JSON.parse(text));
  } catch {
    throw new JourneyFailure({ failure: "invalid_json_response", httpStatus: response.status });
  }
}

export type CallOptions = {
  token?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/** A raw request for endpoints outside the daemon route table, such as the sandbox provider. */
export type RequestOptions = CallOptions & {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: Json | SandboxAttemptRequest;
};

/** Carries one prepared request. Callers inject one to bound concurrency or to check ownership. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export class ApiClient {
  constructor(
    private readonly options: {
      origin: string;
      token: string | null;
      timeoutMs: number;
      transport?: Transport;
    },
  ) {}

  private async fetch(path: string, init: RequestInit, options: CallOptions) {
    const headers = new Headers(init.headers);
    const token = options.token === undefined ? this.options.token : options.token;

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }

    if (token !== null) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    try {
      return await (this.options.transport ?? fetch)(`${this.options.origin}${path}`, {
        ...init,
        headers,
        signal: options.signal ?? AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      // A transport may refuse with its own safe evidence; other faults keep only the path.
      throw cause instanceof JourneyFailure
        ? cause
        : new JourneyFailure({ failure: "local_api_transport_failed", path });
    }
  }

  request(path: string, options: RequestOptions = {}): Promise<Response> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    return this.fetch(
      path,
      {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body,
      },
      options,
    );
  }

  send<R extends Route>(route: R, input: RouteInput<R>, options: CallOptions = {}) {
    const { method, url, headers, body } = routeRequest(route, input);

    return this.fetch(url, { method, headers, body }, options);
  }

  async call<R extends Route>(
    route: R,
    input: RouteInput<R>,
    options: CallOptions = {},
  ): Promise<RouteResult<R>> {
    const response = await this.send(route, input, options);

    if (!response.ok) {
      await response.body?.cancel();
      throw new JourneyFailure({
        failure: "unexpected_http_status",
        path: route.path,
        httpStatus: response.status,
      });
    }

    const outcome = decodeRouteResponse(route, response.status, await readText(response));

    if (outcome.kind !== "ok") {
      throw new JourneyFailure({ failure: "invalid_json_response", httpStatus: response.status });
    }

    return outcome.value;
  }

  async json<T>(
    schema: Schema.Codec<T, unknown, never, never>,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.request(path, options);

    if (!response.ok) {
      await response.body?.cancel();
      throw new JourneyFailure({
        failure: "unexpected_http_status",
        path: path.split("?")[0] ?? path,
        httpStatus: response.status,
      });
    }

    return readJson(response, schema);
  }

  waitForRun(
    id: string,
    options: { timeoutMs: number; intervalMs: number; untilWaiting?: boolean },
  ): Promise<RunSnapshotView> {
    return until(
      () => this.call(routes.run, { params: { id } }),
      (snapshot) =>
        isTerminalRun(snapshot.run.status) ||
        (options.untilWaiting === true && snapshot.run.waitingOn !== null),
      {
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
        timeout: (last) =>
          new JourneyFailure({
            failure: "run_wait_timed_out",
            runId: id,
            runStatus: last?.run.status ?? "unknown",
            nodeStatuses:
              last?.nodeRuns.map((node) => `${node.key.nodeId}:${node.status}:${node.attempt}`) ??
              [],
          }),
      },
    );
  }
}
