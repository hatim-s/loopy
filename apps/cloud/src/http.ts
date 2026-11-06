import { Cause, Data, Effect } from "effect";
import { errorResponse } from "../../../packages/loopy/src/service";
import { CloudError, platform } from "./operation";

export const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

export class BodyLimitError extends Data.TaggedError("BodyLimitError")<{ limit: number }> {}

function readBytes(body: ReadableStream<Uint8Array>, limit: number) {
  return Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Uint8Array[] = [];
        let size = 0;

        while (true) {
          const next = yield* platform("read body", () => reader.read());

          if (next.done) {
            break;
          }

          size += next.value.byteLength;

          if (size > limit) {
            return yield* Effect.fail(new BodyLimitError({ limit }));
          }

          chunks.push(next.value);
        }

        const bytes = new Uint8Array(size);
        let offset = 0;

        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }

        return bytes;
      }),
    (reader, exit) =>
      (exit._tag === "Success"
        ? Effect.void
        : Effect.interruptible(platform("cancel body", () => reader.cancel())).pipe(
            Effect.timeoutOrElse({
              duration: 1000,
              orElse: () =>
                Effect.fail(
                  new CloudError({
                    operation: "cancel body",
                    cause: "Body cancellation exceeded 1000 ms. The producer may still be running.",
                  }),
                ),
            }),
          )
      ).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock()))),
  );
}

export function boundedRequest(request: Request) {
  return Effect.gen(function* () {
    if (!request.body) {
      return request;
    }

    const bytes = yield* recoverBodyLimit(readBytes(request.body, MAX_REQUEST_BYTES));

    if (bytes === null) {
      return errorResponse("bad_request", "Request exceeds the 24 MiB cloud artifact limit.");
    }

    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bytes,
      signal: request.signal,
    });
  });
}

export function acceptsOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");

  return origin === null || origin === new URL(request.url).origin;
}

export function readBoundedText(response: Response, limit: number) {
  return Effect.gen(function* () {
    if (!response.body) {
      return yield* Effect.fail(
        new CloudError({ operation: "read body", cause: "Sandbox returned an empty receipt." }),
      );
    }

    return new TextDecoder().decode(yield* readBytes(response.body, limit));
  });
}

/** Only a sole limit rejection is a client error; cleanup failures retain the full Cause. */
export function recoverBodyLimit<A>(read: Effect.Effect<A, CloudError | BodyLimitError>) {
  return read.pipe(
    Effect.catchCause((cause) => {
      const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;

      if (reason && Cause.isFailReason(reason) && reason.error._tag === "BodyLimitError") {
        return Effect.succeed(null);
      }

      return Effect.failCause(cause);
    }),
  );
}
