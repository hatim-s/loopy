import type { R2Bucket } from "@cloudflare/workers-types";
import type { ExecutionResult } from "@loopy/contract";
import {
  AuthorityError,
  type ResultRef,
  resultBytes,
  resultRef,
  verifiedResult,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { ImmutableBucket, r2Key } from "../artifacts/storage";
import { CloudError, platform } from "../operation";

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
      const result = yield* platform("verify result", () => verifiedResult(bytes, ref));

      if (!result) {
        return yield* Effect.fail(
          new CloudError({
            operation: "verify result",
            cause:
              "Immutable result is missing or does not match its receipt. Restore receipt storage before resuming.",
          }),
        );
      }

      return result;
    });
  }
}
