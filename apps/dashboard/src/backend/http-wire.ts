import { Cause, Effect, Exit } from "effect";
import { BackendError } from "./backend";

export async function runRequest<A>(
  operation: Effect.Effect<A, BackendError>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(operation, { signal });

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw signal?.aborted ? signal.reason : Cause.squash(exit.cause);
}

export const readText = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: () => new BackendError("unreachable"),
  });

export function httpRequests(base: string, headers: Record<string, string>) {
  return function withResponse<A>(
    url: string,
    init: RequestInit,
    use: (response: Response) => Effect.Effect<A, BackendError>,
  ) {
    return Effect.scoped(
      Effect.gen(function* () {
        // The controller keeps fetch cancellation owned through body consumption and stream use.
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );

        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(`${base}${url}`, {
              ...init,
              signal: AbortSignal.any([controller.signal, signal]),
              headers: { ...headers, ...init.headers },
              credentials: "omit",
              redirect: "error",
              referrerPolicy: "no-referrer",
            }),
          catch: () => new BackendError("unreachable"),
        });

        return yield* use(response);
      }),
    );
  };
}
