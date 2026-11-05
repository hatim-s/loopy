import { Effect } from "effect";
import {
  attemptIdInput,
  attemptResourceNames,
  type DockerAttemptPlan,
  workspaceVolumeInput,
} from "../../../packages/loopy/src/contract/index.js";
import { canonicalJson } from "../../../packages/loopy/src/core/index.js";
import { platform } from "./operation.js";

export function receiptHash(bytes: Uint8Array) {
  return Effect.gen(function* () {
    const digest = yield* platform("hash receipt", () =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    );

    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });
}

export function validReceiptPlan(root: string, plan: DockerAttemptPlan) {
  return Effect.gen(function* () {
    const id = yield* receiptHash(
      new TextEncoder().encode(canonicalJson(attemptIdInput(root, plan))),
    );

    const volume = yield* receiptHash(
      new TextEncoder().encode(canonicalJson(workspaceVolumeInput(root, plan))),
    );

    const names = attemptResourceNames(id, volume);

    return (
      plan.id === id &&
      plan.container === names.container &&
      plan.inputVolume === names.inputVolume &&
      plan.volume === names.volume
    );
  });
}
