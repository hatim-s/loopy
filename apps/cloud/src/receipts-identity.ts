import type { DockerAttemptPlan } from "../../../packages/loopy/src/contract/index.js";
import { canonicalJson } from "../../../packages/loopy/src/core/index.js";

export async function receiptHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validReceiptPlan(root: string, plan: DockerAttemptPlan): Promise<boolean> {
  const id = await receiptHash(
    new TextEncoder().encode(
      canonicalJson({
        root,
        workspace: plan.workspace,
        executionKey: plan.executionKey,
        attempt: plan.attempt,
      }),
    ),
  );

  const volume = await receiptHash(
    new TextEncoder().encode(
      canonicalJson({
        root,
        workspace: plan.workspace,
        runId: plan.executionKey.runId,
      }),
    ),
  );

  return (
    plan.id === id &&
    plan.container === `loopy-attempt-${id}` &&
    plan.inputVolume === `loopy-input-${id}` &&
    plan.volume === `loopy-workspace-${volume}`
  );
}
