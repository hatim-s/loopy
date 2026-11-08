import { Data, Effect, Exit } from "effect";

export class BodyLimitError extends Data.TaggedError("BodyLimitError")<{ limit: number }> {
  override get message() {
    return `Body exceeds its ${this.limit} byte limit. Send a smaller body.`;
  }
}

export class BodyReadError extends Data.TaggedError("BodyReadError")<{
  operation: "read body" | "cancel body";
  cause: unknown;
}> {}

// A platform stream may never settle its cancellation, so cleanup gives up after this bound.
const CANCEL_TIMEOUT_MS = 1000;

const encoder = new TextEncoder();

function cancel(reader: ReadableStreamDefaultReader<Uint8Array>) {
  return Effect.tryPromise({
    try: () => reader.cancel(),
    catch: (cause) => new BodyReadError({ operation: "cancel body", cause }),
  }).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({
      duration: CANCEL_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new BodyReadError({
            operation: "cancel body",
            cause: `Body cancellation exceeded ${CANCEL_TIMEOUT_MS} ms. The producer may still be running.`,
          }),
        ),
    }),
  );
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

/** Reads at most `limit` bytes. Any failed or oversize read cancels the stream. */
export function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Effect.Effect<Uint8Array, BodyLimitError | BodyReadError> {
  if (body === null) {
    return Effect.succeed(new Uint8Array());
  }

  return Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Uint8Array[] = [];
        let size = 0;

        while (true) {
          const next = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (cause) => new BodyReadError({ operation: "read body", cause }),
          });

          if (next.done) {
            return concat(chunks, size);
          }

          size += next.value.byteLength;

          if (size > limit) {
            return yield* Effect.fail(new BodyLimitError({ limit }));
          }

          chunks.push(next.value);
        }
      }),
    (reader, exit) =>
      (Exit.isSuccess(exit) ? Effect.void : cancel(reader)).pipe(
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      ),
  );
}

/** Compares the Authorization header in time that depends only on the expected token length. */
export function bearerMatches(authorization: string | null, token: string): boolean {
  const actual = encoder.encode(authorization ?? "");
  const expected = encoder.encode(`Bearer ${token}`);
  let difference = actual.byteLength ^ expected.byteLength;

  for (let index = 0; index < expected.byteLength; index++) {
    difference |= (expected[index] ?? 0) ^ (actual[index] ?? 0);
  }

  return difference === 0;
}
