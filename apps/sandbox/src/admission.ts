import {
  SANDBOX_MAX_BUNDLE_BYTES,
  type SandboxAttemptRequest,
  verifiedBase64,
} from "@loopy/contract/sandbox";
import { specBundles } from "@loopy/core";
import { Effect } from "effect";
import { SandboxRequestError } from "./request-error";

export function validateBundles(request: SandboxAttemptRequest) {
  return Effect.gen(function* () {
    const required = specBundles(request.spec);

    const supplied = new Set<string>();

    for (const bundle of request.bundles) {
      const bytes = yield* Effect.promise(() =>
        verifiedBase64(bundle.bytes, bundle.hash, SANDBOX_MAX_BUNDLE_BYTES),
      );

      if (bytes === null || supplied.has(bundle.hash) || !required.includes(bundle.hash)) {
        return yield* Effect.fail(
          new SandboxRequestError(
            "invalid_request",
            "Supply each required bundle once with matching SHA-256 bytes.",
          ),
        );
      }

      supplied.add(bundle.hash);
    }

    if (required.some((value) => !supplied.has(value))) {
      return yield* Effect.fail(
        new SandboxRequestError("invalid_request", "A required execution bundle is missing."),
      );
    }
  });
}
