import { createHash } from "node:crypto";
import {
  SANDBOX_MAX_BUNDLE_BYTES,
  type SandboxAttemptIdentity,
  type SandboxAttemptRequest,
} from "../../../packages/loopy/src/contract/index.js";
import { canonicalJson } from "../../../packages/loopy/src/core/index.js";

export class InvalidAttempt extends Error {}

export class AttemptConflict extends Error {}

export function attemptHash(
  value:
    | SandboxAttemptRequest
    | (SandboxAttemptIdentity & { root: string })
    | { root: string; workspace: string; runId: string },
) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
