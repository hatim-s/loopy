import { Cause, Effect, Exit, Schema } from "effect";
import { boundaryOptions, errorBodySchema } from "loopy/contract";
import { BackendError } from "./backend.ts";

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

export function decodeBody<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  text: string,
  path: string,
) {
  const malformed = () =>
    new BackendError(
      "malformed_response",
      `${path} answered with a body that does not match the contract.`,
    );

  return Effect.try({ try: () => JSON.parse(text), catch: malformed }).pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(schema, boundaryOptions)(json)),
    Effect.mapError(malformed),
  );
}

export function errorFrom(status: number, text: string) {
  return decodeBody(errorBodySchema, text, "error response").pipe(
    Effect.map((body) => new BackendError(body.error.code, body.error.message)),
    Effect.catch(() =>
      Effect.succeed(
        new BackendError(
          "malformed_response",
          `The server answered ${status} without a readable error.`,
        ),
      ),
    ),
  );
}

export const readText = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: () => new BackendError("unreachable"),
  });

export function httpRequests(base: string, headers: Record<string, string>) {
  function withResponse<A>(
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
  }

  const fetchText = (url: string, init: RequestInit) =>
    withResponse(url, init, (response) =>
      readText(response).pipe(
        Effect.map((text) => ({ ok: response.ok, status: response.status, text })),
      ),
    );

  return { withResponse, fetchText };
}
