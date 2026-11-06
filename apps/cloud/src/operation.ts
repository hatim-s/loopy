import { Data, Effect } from "effect";
import { errorMessage } from "../../../packages/loopy/src/core";

export class CloudError extends Data.TaggedError("CloudError")<{
  operation: string;
  cause: unknown;
}> {
  override get message() {
    return errorMessage(this.cause);
  }
}

/** Only foreign Promise APIs enter here. Cloud orchestration yields native operations. */
export function platform<A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({
    try: (signal) => Promise.resolve(run(signal)),
    catch: (cause) => new CloudError({ operation, cause }),
  });
}

export function cloudSync<A>(operation: string, run: () => A) {
  return Effect.try({ try: run, catch: (cause) => new CloudError({ operation, cause }) });
}

export class CloudProtocolError extends Data.TaggedError("CloudProtocolError")<{
  operation: "receipt" | "artifact";
  cause: unknown;
}> {}

export function decodeProtocol<A>(operation: "receipt" | "artifact", decode: () => A) {
  return Effect.try({
    try: decode,
    catch: (cause) => new CloudProtocolError({ operation, cause }),
  });
}
