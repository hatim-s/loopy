import { canonicalJson, type ExecutionResult, type Json, sha256Hex } from "@loopy/core";
import {
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxAttemptIdentity,
  type SandboxAttemptRequest,
} from "./attempt";
import { attemptResourceNames, type DockerAttemptPlan, type ResultRef } from "./journal";

const encoder = new TextEncoder();

const hashJson = (value: Json | SandboxAttemptRequest) =>
  sha256Hex(encoder.encode(canonicalJson(value)));

/** The id every authority derives for one attempt under one state root. */
export function attemptId(root: string, identity: SandboxAttemptIdentity) {
  return hashJson({
    root,
    workspace: identity.workspace,
    executionKey: identity.executionKey,
    attempt: identity.attempt,
  });
}

/** Attempts of one run share a workspace volume, so its hash leaves out the node and attempt. */
export async function attemptResources(root: string, identity: SandboxAttemptIdentity) {
  const [id, volumeHash] = await Promise.all([
    attemptId(root, identity),
    hashJson({ root, workspace: identity.workspace, runId: identity.executionKey.runId }),
  ]);

  return { id, ...attemptResourceNames(id, volumeHash) };
}

export type AttemptResources = Awaited<ReturnType<typeof attemptResources>>;

export async function planMatches(root: string, plan: DockerAttemptPlan) {
  const expected = await attemptResources(root, plan);

  return (
    plan.id === expected.id &&
    plan.container === expected.container &&
    plan.inputVolume === expected.inputVolume &&
    plan.volume === expected.volume
  );
}

/** Bundle order is not part of the request content. */
export function attemptRequestHash(request: SandboxAttemptRequest) {
  return hashJson({
    ...request,
    bundles: [...request.bundles].sort((left, right) => (left.hash < right.hash ? -1 : 1)),
  });
}

/**
 * Canonical result bytes, or null over the capture limit. The sandbox bounds results before
 * storing them, so both authorities reject a null here as `invalid_state`.
 */
export function resultBytes(result: ExecutionResult) {
  const bytes = encoder.encode(canonicalJson(result));

  return bytes.byteLength > SANDBOX_MAX_CAPTURE_BYTES ? null : bytes;
}

export async function resultRef(bytes: Uint8Array<ArrayBuffer>): Promise<ResultRef> {
  return { sha256: await sha256Hex(bytes), size: bytes.byteLength };
}

export function sameRef(left: ResultRef, right: ResultRef) {
  return left.sha256 === right.sha256 && left.size === right.size;
}
