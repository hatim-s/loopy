import { createHash } from "node:crypto";
import { join } from "node:path";
import { decodeBoundary, type ExecutionResult, executionResultSchema } from "@loopy/contract";
import {
  AuthorityError,
  type ResultRef,
  resultBytes,
  resultRef,
  SANDBOX_MAX_CAPTURE_BYTES,
  sameRef,
} from "@loopy/contract/sandbox";
import { publishExclusive, readRegularFile } from "@loopy/runtime/os";
import { Effect } from "effect";
import type { ImmutableResults } from "../authority";
import { checked, failure } from "../operations";
import { stateLayout } from "../state-root";

export class FilesystemResults implements ImmutableResults {
  private readonly prefix: string;
  private readonly directory: string;
  constructor(root: string, workspace: string) {
    this.prefix = createHash("sha256").update(workspace).digest("hex");
    this.directory = stateLayout(root).results;
  }

  private path(ref: ResultRef) {
    return join(this.directory, `${this.prefix}-${ref.sha256}.json`);
  }

  get(ref: ResultRef) {
    return Effect.gen({ self: this }, function* () {
      const read = yield* checked("immutable-results", () =>
        readRegularFile(this.path(ref), SANDBOX_MAX_CAPTURE_BYTES),
      );

      const bytes = read && Uint8Array.from(read);

      if (!bytes || !sameRef(yield* Effect.promise(() => resultRef(bytes)), ref)) {
        return yield* Effect.fail(
          failure(
            "immutable-results",
            new Error(
              "Sandbox result bytes are missing or do not match their immutable reference.",
            ),
          ),
        );
      }

      return yield* checked("decode", () =>
        decodeBoundary(executionResultSchema)(JSON.parse(new TextDecoder().decode(bytes))),
      );
    }).pipe(Effect.uninterruptible);
  }

  put(result: ExecutionResult) {
    return Effect.gen({ self: this }, function* () {
      const bytes = resultBytes(result);

      if (bytes === null) {
        return yield* Effect.fail(new AuthorityError("invalid_state"));
      }

      const ref = yield* Effect.promise(() => resultRef(bytes));
      // A result already published under this ref is verified by the read below.
      yield* checked("result publish", () => publishExclusive(this.path(ref), bytes, 0o600));
      yield* this.get(ref);

      return ref;
    }).pipe(Effect.uninterruptible);
  }
}
