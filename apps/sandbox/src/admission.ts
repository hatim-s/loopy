import { createHash } from "node:crypto";
import { Data } from "effect";
import {
  SANDBOX_MAX_BUNDLE_BYTES,
  type SandboxAttemptIdentity,
  type SandboxAttemptRequest,
} from "../../../packages/loopy/src/contract";
import { attemptIdInput } from "../../../packages/loopy/src/contract/sandbox-journal";
import { canonicalJson } from "../../../packages/loopy/src/core";

export class InvalidAttempt extends Data.TaggedError("InvalidAttempt")<{ message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

export class AttemptConflict extends Data.TaggedError("AttemptConflict")<{ message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

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
  const required =
    request.spec.kind === "code"
      ? [request.spec.bundleHash]
      : request.spec.parse
        ? [request.spec.parse.bundleHash]
        : [];

  const supplied = new Set<string>();

  for (const bundle of request.bundles) {
    const bytes = Buffer.from(bundle.bytes, "base64");

    if (
      bytes.byteLength > SANDBOX_MAX_BUNDLE_BYTES ||
      supplied.has(bundle.hash) ||
      !required.includes(bundle.hash) ||
      bytes.toString("base64") !== bundle.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== bundle.hash
    ) {
      throw new InvalidAttempt("Supply each required bundle once with matching SHA-256 bytes.");
    }

    supplied.add(bundle.hash);
  }

  if (required.some((value) => !supplied.has(value))) {
    throw new InvalidAttempt("A required execution bundle is missing.");
  }
}
