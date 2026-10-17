import { errorBodySchema, routes, serverEventSchema } from "loopy/contract";
import type { z } from "zod";
import {
  BackendError,
  type EventSubscription,
  type LoopyBackend,
  type StreamEnd,
} from "./backend.ts";

type Route = (typeof routes)[keyof typeof routes];

type Call<R extends Route> = {
  params: z.output<R["params"]>;
  query: z.output<R["query"]>;
  body: z.output<R["body"]>;
};

/** One SSE frame carries every event of one store transaction. */
const batchSchema = serverEventSchema.array();

const RETRY_MS = { first: 500, max: 10_000 } as const;

function routeUrl(
  path: string,
  params: Record<string, string>,
  query: Record<string, string | number | boolean | undefined>,
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

      return encodeURIComponent(value);
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

async function failure(response: Response): Promise<BackendError> {
  if (response.status === 401) {
    return new BackendError("unauthorized");
  }

  const body = decode(errorBodySchema, await response.text());

  if (!body.valid) {
    return new BackendError(
      "malformed_response",
      `The server answered ${response.status} without a readable error.`,
    );
  }

  return new BackendError(body.value.error.code, body.value.error.message);
}

function frameData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
}

/** Splits an SSE body into the joined data lines of each frame. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let finished = false;

  try {
    while (true) {
      const chunk = await reader.read();
      finished = chunk.done;

      if (chunk.done) {
        return;
      }

      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll("\r\n", "\n");

      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const data = frameData(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);

        if (data !== "") {
          yield data;
        }
      }
    }
  } finally {
    try {
      if (!finished) {
        await reader.cancel();
      }
    } finally {
      reader.releaseLock();
    }
  }
}

type Decoded<T> = { valid: true; value: T } | { valid: false };

/** The one place wire text becomes data: JSON that fails its contract schema is invalid. */
function decode<S extends z.ZodType>(schema: S, text: string): Decoded<z.output<S>> {
  try {
    const parsed = schema.safeParse(JSON.parse(text));

    return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
  } catch {
    return { valid: false };
  }
}

function contractBody<S extends z.ZodType>(schema: S, text: string, path: string): z.output<S> {
  const body = decode(schema, text);

  if (!body.valid) {
    throw new BackendError(
      "malformed_response",
      `${path} answered with a body that does not match the contract.`,
    );
  }

  return body.value;
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

type LocalHttpOptions = {
  /** Absolute origin of the Loopy server; the browser passes its own. */
  origin: string;
  token: string | null;
};

export function localHttpBackend({ origin, token }: LocalHttpOptions): LoopyBackend {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${origin}${url}`, { ...init, headers: { ...headers, ...init.headers } });
    } catch (cause) {
      if (init.signal?.aborted) {
        throw cause;
      }

      throw new BackendError("unreachable");
    }
  }

  async function send<R extends Route, S extends z.ZodType>(
    route: R & { response: S },
    call: Call<R>,
    signal?: AbortSignal,
  ): Promise<z.output<S>> {
    const init: RequestInit = { method: route.method, signal };

    if (call.body !== undefined) {
      init.body = JSON.stringify(call.body);
      init.headers = { "Content-Type": "application/json" };
    }

    const response = await request(routeUrl(route.path, call.params, call.query), init);

    if (!response.ok) {
      throw await failure(response);
    }

    return contractBody<S>(route.response, await response.text(), route.path);
  }

  /** Follows one stream until the server drops it, and reports why it stopped. */
  async function follow(
    subscription: EventSubscription,
    cursor: { after: number; received: boolean },
  ): Promise<StreamEnd | "dropped"> {
    const { epoch, signal, onBatch, onState } = subscription;
    const url = routeUrl(routes.events.path, {}, { after: cursor.after, epoch });
    const response = await request(url, { signal, headers: { Accept: "text/event-stream" } });

    if (response.status === 410) {
      const error = await failure(response);

      if (error.code === "stale_cursor") {
        return "reset";
      }

      throw error;
    }

    if (!response.ok || response.body === null) {
      throw await failure(response);
    }

    onState("live");

    for await (const data of frames(response.body)) {
      cursor.received = true;
      const batch = contractBody(batchSchema, data, routes.events.path);
      cursor.after = batch.reduce((max, event) => Math.max(max, event.sequence), cursor.after);
      onBatch(batch);
    }

    return "dropped";
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

  return {
    cursor: (signal) => send(routes.cursor, { params: {}, query: {}, body: undefined }, signal),
    loopies: () => send(routes.loopies, { params: {}, query: {}, body: undefined }),
    runs: (query) => send(routes.runs, { params: {}, query, body: undefined }),
    run: (id, signal) => send(routes.run, { params: { id }, query: {}, body: undefined }, signal),
    logs: (id, after) => send(routes.logs, { params: { id }, query: { after }, body: undefined }),
    startRun: (slug, input) =>
      send(routes.startRun, { params: { slug }, query: {}, body: { input } }),
    resumeRun: (id) => send(routes.resumeRun, { params: { id }, query: {}, body: undefined }),
    cancelRun: (id) => send(routes.cancelRun, { params: { id }, query: {}, body: undefined }),
    resolveHook: (token, payload) =>
      send(routes.resolveHook, { params: { token }, query: {}, body: { payload } }),
    daemon: () => send(routes.daemon, { params: {}, query: {}, body: undefined }),
    schedules: () => send(routes.schedules, { params: {}, query: {}, body: undefined }),
    putSchedule: (slug, body) => send(routes.putSchedule, { params: { slug }, query: {}, body }),
    setScheduleEnabled: (slug, enabled) =>
      send(routes.setScheduleEnabled, { params: { slug }, query: {}, body: { enabled } }),
    deleteSchedule: (slug) =>
      send(routes.deleteSchedule, { params: { slug }, query: {}, body: undefined }),
    events,
  };
}
