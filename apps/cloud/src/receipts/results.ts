import type { R2Bucket } from "@cloudflare/workers-types";
import { decodeBoundary, type ExecutionResult, executionResultSchema } from "@loopy/contract";
import {
  AuthorityError,
  type ResultRef,
  resultBytes,
  resultRef,
  sameRef,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { ImmutableBucket, r2Key } from "../artifacts/storage";
import { CloudError, cloudSync, platform } from "../operation";

export class R2ImmutableResults {
  private readonly objects: ImmutableBucket;

  constructor(bucket: R2Bucket, namespace: string, workspace: string) {
    this.objects = new ImmutableBucket(bucket, r2Key.results(namespace, workspace));
  }

  put(result: ExecutionResult) {
    return Effect.gen({ self: this }, function* () {
      const bytes = resultBytes(result);

      if (bytes === null) {
        return yield* Effect.fail(new AuthorityError("invalid_state"));
      }

      const ref = yield* platform("hash result", () => resultRef(bytes));

      if (!(yield* this.objects.put(ref.sha256, bytes))) {
        // An existing object must verify before its digest can be reused.
        yield* this.get(ref);
      }

      return ref;
    });
  }

  get(ref: ResultRef) {
    return Effect.gen({ self: this }, function* () {
      const bytes = yield* this.objects.read(ref.sha256, ref.size);

      if (!bytes) {
        return yield* Effect.fail(
          new CloudError({
            operation: "verify result",
            cause: "Immutable result is missing. Restore receipt storage before resuming.",
          }),
        );
      }

      if (!sameRef(yield* platform("hash result", () => resultRef(bytes)), ref)) {
        return yield* Effect.fail(
          new CloudError({
            operation: "verify result",
            cause: "Immutable result does not match its receipt.",
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
