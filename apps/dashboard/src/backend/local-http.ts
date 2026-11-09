import {
  decodeEventBatch,
  decodeRouteResponse,
  type Route,
  type RouteName,
  type RouteOutcome,
  routeRequest,
  routes,
  routeUrl,
  splitSseFrames,
} from "@loopy/contract";
import { Effect, Stream } from "effect";
import { BackendError, type EventSubscription, type LoopyBackend, type StreamEnd } from "./backend";
import { httpRequests, readText, runRequest } from "./http-wire";

const RETRY_MS = { first: 500, max: 10_000 } as const;

function failure(path: string, status: number, outcome: RouteOutcome<Route>) {
  return outcome.kind === "error"
    ? new BackendError(outcome.error.code, outcome.error.message)
    : new BackendError(
        "malformed_response",
        `${path} answered ${status} with a body that does not match the contract.`,
      );
}

function decodeOutcome<K extends RouteName>(name: K, status: number, text: string) {
  const outcome = decodeRouteResponse(routes[name], status, text);

  return outcome.kind === "ok"
    ? Effect.succeed(outcome.value)
    : Effect.fail(failure(routes[name].path, status, outcome));
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
      const split = splitSseFrames(buffer + decoder.decode(chunk, { stream: true }));
      buffer = split.rest;

      return split.frames;
    }),
    Stream.flattenIterable,
  );
}

function decodeBatch(data: string) {
  return Effect.try({
    try: () => decodeEventBatch(data),
    catch: () =>
      new BackendError("malformed_response", "An event frame does not match the contract."),
  });
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
  /** Waits between stream reconnects; tests replace it to observe the back-off. */
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export function localHttpBackend(options: LocalHttpOptions): LoopyBackend {
  const headers: Record<string, string> = options.token
    ? { Authorization: `Bearer ${options.token}` }
    : {};

  const withResponse = httpRequests(options.baseUrl, headers);
  const wait = options.pause ?? pause;

  const call: LoopyBackend["call"] = (name, input, signal) => {
    const request = routeRequest(routes[name], input);

    return runRequest(
      withResponse(
        request.url,
        { method: request.method, headers: request.headers, body: request.body },
        (response) =>
          readText(response).pipe(
            Effect.flatMap((text) => decodeOutcome(name, response.status, text)),
          ),
      ),
      signal,
    );
  };

  /** Follows one stream until the server drops it, and reports why it stopped. */
  function follow(
    subscription: EventSubscription,
    cursor: { after: number; received: boolean },
  ): Promise<StreamEnd | "dropped"> {
    const { epoch, signal, onBatch, onState } = subscription;
    const url = routeUrl(routes.events, { query: { after: cursor.after, epoch } });

    return runRequest(
      withResponse(url, { headers: { Accept: "text/event-stream" } }, (response) =>
        Effect.gen(function* () {
          if (!response.ok || response.body === null) {
            const text = yield* readText(response);
            const outcome = decodeRouteResponse(routes.events, response.status, text);
            const error = failure(routes.events.path, response.status, outcome);

            if (error.code === "stale_cursor") {
              return "reset" as const;
            }

            return yield* Effect.fail(error);
          }

          onState("live");
          yield* Stream.runForEach(frames(response.body), (frame) =>
            Effect.gen(function* () {
              cursor.received = true;
              const batch = yield* decodeBatch(frame.data);
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
      await wait(delay, signal);
      delay = Math.min(delay * 2, RETRY_MS.max);
    }

    return "aborted";
  }

  return { call, events };
}
