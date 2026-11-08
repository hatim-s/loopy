import { createHash, randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ResultRef } from "@loopy/contract";
import {
  decodeBoundary,
  type ExecutionResult,
  executionResultSchema,
  SANDBOX_MAX_CAPTURE_BYTES,
} from "@loopy/contract";
import { canonicalJson } from "@loopy/core";
import { Effect } from "effect";
import { readBytes, syncDirectory } from "./journal-files";
import type { ImmutableResults } from "./operations";
import { checked, failure, io } from "./operations";

export function resultBytes(result: ExecutionResult) {
  const bytes = Buffer.from(canonicalJson(result));

  if (bytes.byteLength > SANDBOX_MAX_CAPTURE_BYTES) {
    throw new Error("Sandbox terminal result exceeds its serialized byte limit.");
  }

  return bytes;
}

export function resultReference(result: ExecutionResult): ResultRef {
  const bytes = resultBytes(result);

  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

export class FilesystemResults implements ImmutableResults {
  private readonly prefix: string;
  constructor(
    private readonly root: string,
    workspace: string,
  ) {
    this.prefix = createHash("sha256").update(workspace).digest("hex");
  }

  private path(ref: ResultRef) {
    return join(this.root, "results", `${this.prefix}-${ref.sha256}.json`);
  }

  get(ref: ResultRef) {
    return Effect.gen({ self: this }, function* () {
      const bytes = yield* io("immutable-results", () => readBytes(this.path(ref)));

      if (
        !bytes ||
        bytes.byteLength !== ref.size ||
        createHash("sha256").update(bytes).digest("hex") !== ref.sha256
      ) {
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
        decodeBoundary(executionResultSchema)(JSON.parse(bytes.toString("utf8"))),
      );
    }).pipe(Effect.uninterruptible);
  }

  put(result: ExecutionResult) {
    return Effect.gen({ self: this }, function* () {
      const bytes = yield* checked("result bytes", () => resultBytes(result));
      const ref = resultReference(result);
      const directory = join(this.root, "results");
      const temporary = join(directory, `${randomUUID()}.tmp`);

      return yield* Effect.acquireUseRelease(
        io("result open", () => open(temporary, "wx", 0o600)),
        (file) =>
          Effect.gen({ self: this }, function* () {
            yield* io("result write", () => file.writeFile(bytes));
            yield* io("result sync", () => file.sync());
            yield* io("result link", () =>
              link(temporary, this.path(ref)).catch((cause: unknown) => {
                if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
                  throw cause;
                }
              }),
            );
            yield* io("result directory sync", () => syncDirectory(directory));
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
