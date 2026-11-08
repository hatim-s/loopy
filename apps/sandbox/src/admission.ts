import { createHash } from "node:crypto";
import {
  attemptIdInput,
  SANDBOX_MAX_BUNDLE_BYTES,
  type SandboxAttemptIdentity,
  type SandboxAttemptRequest,
} from "@loopy/contract";
import { canonicalJson } from "@loopy/core";
import { Effect } from "effect";
import { verifiedBytes } from "./bytes";
import { SandboxRequestError } from "./request-error";

export function attemptHash(
  value:
    | SandboxAttemptRequest
    | (SandboxAttemptIdentity & { root: string })
    | { root: string; workspace: string; runId: string },
) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function attemptId(root: string, identity: SandboxAttemptIdentity) {
  return attemptHash(attemptIdInput(root, identity));
}

export function validateBundles(request: SandboxAttemptRequest) {
  return Effect.gen(function* () {
    const required =
      request.spec.kind === "code"
        ? [request.spec.bundleHash]
        : request.spec.parse
          ? [request.spec.parse.bundleHash]
          : [];

    const supplied = new Set<string>();

    for (const bundle of request.bundles) {
      const bytes = verifiedBytes(bundle.bytes, bundle.hash);

      if (
        bytes === null ||
        bytes.byteLength > SANDBOX_MAX_BUNDLE_BYTES ||
        supplied.has(bundle.hash) ||
        !required.includes(bundle.hash)
      ) {
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
