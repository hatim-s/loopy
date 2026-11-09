import { routes, type ServerEvent, serverEventSchema } from "@loopy/contract";
import { Effect, Schema, Stream } from "effect";
import { BackendError, type EventSubscription, type LoopyBackend, type StreamEnd } from "./backend";
import { decodeBody, errorFrom, httpRequests, readText, runRequest } from "./http-wire";

type Route = {
  method: string;
  path: string;
  params: Schema.Codec<Record<string, string | number>, unknown>;
  query: Schema.Codec<object, object>;
  body: Schema.Codec<unknown, unknown>;
  response: Schema.Codec<unknown, unknown>;
};

type Call<R extends Route> = {
  params: Schema.Schema.Type<R["params"]>;
  query: Schema.Codec.Encoded<R["query"]>;
  body: Schema.Schema.Type<R["body"]>;
};

/** One SSE frame carries every event of one store transaction. */
const batchSchema = Schema.Array(serverEventSchema).pipe(Schema.mutable);

const RETRY_MS = { first: 500, max: 10_000 } as const;

function routeUrl(
  path: string,
  params: Record<string, string | number>,
  query: Schema.Codec.Encoded<Route["query"]>,
): string {
  const filled = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        return segment;
      }

      const value = params[segment.slice(1)];

      if (value === undefined) {
        throw new Error(`Route ${path} needs the ${segment} parameter.`);
      }

      return encodeURIComponent(String(value));
    })
    .join("/");

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const suffix = search.size > 0 ? `?${search}` : "";

  return `/api${filled}${suffix}`;
}

function frameData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
}

// EventSource cannot send the bearer header. Stream owns reader cancellation and release.
function frames(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";

  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: () => new BackendError("unreachable"),
  }).pipe(
    Stream.map((chunk) => {
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
      const result: string[] = [];

      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const data = frameData(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);

        if (data !== "") {
          result.push(data);
        }
      }

      return result;
    }),
    Stream.flattenIterable,
  );
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });

    if (signal.aborted) {
      finish();
    }
  });
}

export type LocalHttpOptions = {
  /** Trusted absolute base URL, optionally including a reverse-proxy path prefix. */
  baseUrl: string;
  token: string | null;
};

export function httpTransport(
  { baseUrl, token }: LocalHttpOptions,
  eventBatchSchema: Schema.Codec<ServerEvent[]> = batchSchema,
) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const { withResponse, fetchText } = httpRequests(baseUrl, headers);

  async function send<R extends Route>(
    route: R,
    call: Call<R>,
    signal?: AbortSignal,
  ): Promise<R["response"]["Type"]> {
    const init: RequestInit = { method: route.method, signal };

    if (call.body !== undefined) {
      init.body = JSON.stringify(call.body);
      init.headers = { "Content-Type": "application/json" };
    }

    const url = routeUrl(route.path, call.params, call.query);

    return runRequest(
      Effect.gen(function* () {
        const response = yield* fetchText(url, init);

        if (!response.ok) {
          return yield* Effect.fail(yield* errorFrom(response.status, response.text));
        }

        return yield* decodeBody(route.response, response.text, route.path);
      }),
      signal,
    );
  }

  /** Follows one stream until the server drops it, and reports why it stopped. */
  async function follow(
    subscription: EventSubscription,
    cursor: { after: number; received: boolean },
  ): Promise<StreamEnd | "dropped"> {
    const { epoch, signal, onBatch, onState } = subscription;
    const url = routeUrl(routes.events.path, {}, { after: cursor.after, epoch });

    return runRequest(
      withResponse(url, { headers: { Accept: "text/event-stream" } }, (response) =>
        Effect.gen(function* () {
          if (response.status === 410 || !response.ok || response.body === null) {
            const error = yield* errorFrom(response.status, yield* readText(response));

            if (response.status === 410 && error.code === "stale_cursor") {
              return "reset" as const;
            }

            return yield* Effect.fail(error);
          }

          onState("live");
          yield* Stream.runForEach(frames(response.body), (data) =>
            Effect.gen(function* () {
              cursor.received = true;
              const batch = yield* decodeBody(eventBatchSchema, data, routes.events.path);
              cursor.after = batch.reduce(
                (max, event) => Math.max(max, event.sequence),
                cursor.after,
              );
              onBatch(batch);
            }),
          );

          return "dropped" as const;
        }),
      ),
      signal,
    );
  }

  async function events(subscription: EventSubscription): Promise<StreamEnd> {
    const { signal, onState } = subscription;
    const cursor = { after: subscription.after, received: false };
    let delay: number = RETRY_MS.first;

    onState("connecting");

    while (!signal.aborted) {
      try {
        cursor.received = false;
        const end = await follow(subscription, cursor);

        if (end !== "dropped") {
          return end;
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }

        if (error instanceof BackendError && error.code !== "unreachable") {
          onState("stale");
          throw error;
        }
      }

      if (cursor.received) {
        delay = RETRY_MS.first;
      }

      onState("reconnecting");
      await pause(delay, signal);
      delay = Math.min(delay * 2, RETRY_MS.max);
    }

    return "aborted";
  }

  return { send, events };
}

export function localHttpBackend(options: LocalHttpOptions): LoopyBackend {
  const { send, events } = httpTransport(options);

  return {
    cursor: (signal) => send(routes.cursor, { params: {}, query: {}, body: undefined }, signal),
    loopies: (workspace) =>
      send(routes.loopies, { params: {}, query: { workspace }, body: undefined }),
    loopyGraph: (slug, workspace) =>
      send(routes.graph, { params: { slug }, query: { workspace }, body: undefined }),
    runs: (query) => send(routes.runs, { params: {}, query, body: undefined }),
    run: (id, signal) => send(routes.run, { params: { id }, query: {}, body: undefined }, signal),
    runGraph: (id) => send(routes.runGraph, { params: { id }, query: {}, body: undefined }),
    logs: (id, after) => send(routes.logs, { params: { id }, query: { after }, body: undefined }),
    startRun: (slug, input, workspace) =>
      send(routes.startRun, { params: { slug }, query: {}, body: { input, workspace } }),
    resumeRun: (id) => send(routes.resumeRun, { params: { id }, query: {}, body: undefined }),
    cancelRun: (id) => send(routes.cancelRun, { params: { id }, query: {}, body: undefined }),
    resolveHook: (token, payload) =>
      send(routes.resolveHook, { params: { token }, query: {}, body: { payload } }),
    daemon: () => send(routes.daemon, { params: {}, query: {}, body: undefined }),
    scheduleOverview: (signal) =>
      send(routes.scheduleOverview, { params: {}, query: {}, body: undefined }, signal),
    schedules: (workspace) =>
      send(routes.schedules, { params: {}, query: { workspace }, body: undefined }),
    putSchedule: (slug, workspace, body) =>
      send(routes.putSchedule, { params: { slug }, query: { workspace }, body }),
    setScheduleEnabled: (slug, workspace, enabled) =>
      send(routes.setScheduleEnabled, {
        params: { slug },
        query: { workspace },
        body: { enabled },
      }),
    deleteSchedule: (slug, workspace) =>
      send(routes.deleteSchedule, { params: { slug }, query: { workspace }, body: undefined }),
    events,
    runPayload: (id, signal) =>
      send(routes.runPayload, { params: { id }, query: {}, body: undefined }, signal),
    scopes: (id, query, signal) =>
      send(routes.scopes, { params: { id }, query, body: undefined }, signal),
    overview: (query, signal) =>
      send(routes.overview, { params: {}, query, body: undefined }, signal),
    source: (slug, workspace, signal) =>
      send(routes.source, { params: { slug }, query: { workspace }, body: undefined }, signal),
    runSource: (id, signal) =>
      send(routes.runSource, { params: { id }, query: {}, body: undefined }, signal),
    executions: (id, query, signal) =>
      send(routes.executions, { params: { id }, query, body: undefined }, signal),
    execution: (id, query, signal) =>
      send(routes.execution, { params: { id }, query, body: undefined }, signal),
    scopeItems: (id, query, signal) =>
      send(routes.scopeItems, { params: { id }, query, body: undefined }, signal),
    globalLogs: (query, signal) =>
      send(routes.globalLogs, { params: {}, query, body: undefined }, signal),
    log: (id, signal) => send(routes.log, { params: { id }, query: {}, body: undefined }, signal),
    eventHistory: (query, signal) =>
      send(routes.eventHistory, { params: {}, query, body: undefined }, signal),
    event: (sequence, signal) =>
      send(routes.event, { params: { sequence }, query: {}, body: undefined }, signal),
  };
}
