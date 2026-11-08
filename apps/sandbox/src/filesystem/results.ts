import { createHash, randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { decodeBoundary, type ExecutionResult, executionResultSchema } from "@loopy/contract";
import {
  AuthorityError,
  type ResultRef,
  resultBytes,
  resultRef,
  sameRef,
} from "@loopy/contract/sandbox";
import { errnoCode } from "@loopy/core";
import { Effect } from "effect";
import type { ImmutableResults } from "../authority";
import { readBytes, syncDirectory } from "../journal-files";
import { checked, failure, io } from "../operations";
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
      const read = yield* io("immutable-results", () => readBytes(this.path(ref)));
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
      const temporary = join(this.directory, `${randomUUID()}.tmp`);

      return yield* Effect.acquireUseRelease(
        io("result open", () => open(temporary, "wx", 0o600)),
        (file) =>
          Effect.gen({ self: this }, function* () {
            yield* io("result write", () => file.writeFile(bytes));
            yield* io("result sync", () => file.sync());
            yield* io("result link", () =>
              link(temporary, this.path(ref)).catch((cause: unknown) => {
                if (errnoCode(cause) !== "EEXIST") {
                  throw cause;
                }
              }),
            );
            yield* io("result directory sync", () => syncDirectory(this.directory));
            yield* this.get(ref);

            return ref;
          }),
        (file) =>
          Effect.acquireUseRelease(
            Effect.void,
            () => io("result close", () => file.close()),
            () => io("result temporary removal", () => unlink(temporary)),
          ),
      );
    }).pipe(Effect.uninterruptible);
  }
}
