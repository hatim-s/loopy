import {
  attemptIdInput,
  attemptResourceNames,
  type DockerAttemptPlan,
  workspaceVolumeInput,
} from "../../../packages/loopy/src/contract/index.js";
import { canonicalJson } from "../../../packages/loopy/src/core/index.js";

export async function receiptHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validReceiptPlan(root: string, plan: DockerAttemptPlan): Promise<boolean> {
  const id = await receiptHash(new TextEncoder().encode(canonicalJson(attemptIdInput(root, plan))));

  const volume = await receiptHash(
    new TextEncoder().encode(canonicalJson(workspaceVolumeInput(root, plan))),
  );

  const names = attemptResourceNames(id, volume);

  return (
    plan.id === id &&
    plan.container === names.container &&
    plan.inputVolume === names.inputVolume &&
    plan.volume === names.volume
  );
}
