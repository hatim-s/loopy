import {
  checkOutSchema,
  executionKeyString,
  type HookRecord,
  isTerminalRun,
  type Json,
  type NodeRun,
  outSchemaMessage,
  type RunRecord,
  type StoreEffect,
  type WaitRecord,
  type WaitResolution,
} from "@loopy/core";
import { Struct } from "effect";
import { StoreInvariantError } from "./operation";
import { utc } from "./timestamps";

export function publicHook(wait: WaitRecord): HookRecord {
  return Struct.omit(wait, ["executionKey", "schema"]);
}

export function registerWait(
  effect: Extract<StoreEffect, { kind: "register_wait" }>,
  node: NodeRun | undefined,
  waits: WaitRecord[],
): WaitRecord | undefined {
  if (!node || node.status !== "waiting") {
    throw new StoreInvariantError("Register a wait only after persisting its waiting node.");
  }

  if (
    waits.some((wait) => executionKeyString(wait.executionKey) === executionKeyString(node.key))
  ) {
    return undefined;
  }

  return {
    token: crypto.randomUUID(),
    executionKey: node.key,
    schema: effect.payload,
    runId: node.key.runId,
    seq: waits.reduce((max, wait) => Math.max(max, wait.seq), 0) + 1,
    name: effect.name,
    createdAt: utc(effect.at),
  };
}

export function checkSignal({
  wait,
  node,
  run,
  payload,
  at,
}: {
  wait: WaitRecord | undefined;
  node: NodeRun | undefined;
  run: RunRecord | undefined;
  payload: Json;
  at: string;
}): Extract<WaitResolution, { kind: "rejected" }> | null {
  if (
    !wait ||
    !run ||
    isTerminalRun(run.status) ||
    wait.resolvedAt ||
    wait.expiredAt ||
    node?.status !== "waiting" ||
    (node.wakeAt !== null && Date.parse(at) >= Date.parse(node.wakeAt))
  ) {
    return {
      kind: "rejected",
      code: "unknown_hook",
      message: "The hook is unknown or no longer pending.",
    };
  }

  const issue = checkOutSchema(payload, wait.schema);

  return issue === null
    ? null
    : { kind: "rejected", code: "bad_request", message: outSchemaMessage("Wait payload", issue) };
}
