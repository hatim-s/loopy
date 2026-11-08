import type { R2Bucket } from "@cloudflare/workers-types";
import {
  decodeBoundary,
  type ExecutionResult,
  executionResultSchema,
  type ResultRef,
  SANDBOX_MAX_CAPTURE_BYTES,
} from "@loopy/contract";
import { canonicalJson } from "@loopy/core";
import { Effect } from "effect";
import { CloudError, cloudSync, platform } from "../operation";
import { receiptHash } from "./identity";

export class R2ImmutableResults {
  private readonly prefix: string;

  constructor(
    private readonly bucket: R2Bucket,
    namespace: string,
    workspace: string,
  ) {
    this.prefix = `receipts/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(workspace)}/results/`;
  }

  put(result: ExecutionResult) {
    return Effect.gen({ self: this }, function* () {
      let bytes = new TextEncoder().encode(canonicalJson(result));

      if (bytes.byteLength > SANDBOX_MAX_CAPTURE_BYTES) {
        bytes = new TextEncoder().encode(
          canonicalJson({
            kind: "failed",
            error: { code: "output_limit", message: "Serialized attempt result exceeds 2 MiB." },
            exitCode: null,
            logs: [],
          }),
        );
      }

      const ref = { sha256: yield* receiptHash(bytes), size: bytes.byteLength };

      const created = yield* platform("publish immutable bytes", () =>
        this.bucket.put(this.prefix + ref.sha256, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      );

      if (!created) {
        // An existing object must verify before its digest can be reused.
        yield* this.get(ref);
      }

      return ref;
    });
  }

  get(ref: ResultRef) {
    return Effect.gen({ self: this }, function* () {
      const object = yield* platform("read immutable bytes", () =>
        this.bucket.get(this.prefix + ref.sha256, {
          range: { offset: 0, length: ref.size + 1 },
        }),
      );

      if (!object) {
        return yield* Effect.fail(
          new CloudError({
            operation: "verify result",
            cause: "Immutable result is missing. Restore receipt storage before resuming.",
          }),
        );
      }

      if (object.size !== ref.size || object.size > SANDBOX_MAX_CAPTURE_BYTES) {
        yield* platform("cancel artifact read", () => object.body.cancel());

        return yield* Effect.fail(
          new CloudError({
            operation: "verify result",
            cause: "Immutable result size does not match its receipt.",
          }),
        );
      }

      const bytes = new Uint8Array(
        yield* platform("read artifact bytes", () => object.arrayBuffer()),
      );

      if (bytes.byteLength !== ref.size || (yield* receiptHash(bytes)) !== ref.sha256) {
        return yield* Effect.fail(
          new CloudError({
            operation: "verify result",
            cause: "Immutable result hash does not match its receipt.",
          }),
        );
      }

      return yield* cloudSync("decode immutable result", () =>
        decodeBoundary(executionResultSchema)(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ),
      );
    });
  }
}
