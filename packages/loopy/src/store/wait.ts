import {
  executionKeyString,
  type HookRecord,
  isFieldValue,
  isRecord,
  isTerminalRun,
  type Json,
  MAX_OUTPUT_BYTES,
  type NodeRun,
  outputBytes,
  type RunRecord,
  type StoreEffect,
  type WaitRecord,
  type WaitResolution,
} from "../core/index.js";

export function publicHook(wait: WaitRecord): HookRecord {
  const hook: HookRecord = {
    token: wait.token,
    runId: wait.runId,
    seq: wait.seq,
    name: wait.name,
    createdAt: wait.createdAt,
  };

  if (wait.payload !== undefined) {
    hook.payload = wait.payload;
  }

  if (wait.resolvedAt !== undefined) {
    hook.resolvedAt = wait.resolvedAt;
  }

  if (wait.expiredAt !== undefined) {
    hook.expiredAt = wait.expiredAt;
  }

  return hook;
}

export function registerWait(
  effect: Extract<StoreEffect, { kind: "register_wait" }>,
  node: NodeRun | undefined,
  waits: WaitRecord[],
): WaitRecord | undefined {
  if (!node || node.status !== "waiting") {
    throw new Error("Register a wait only after persisting its waiting node.");
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
    createdAt: new Date(effect.at).toISOString(),
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

  if (outputBytes(payload) > MAX_OUTPUT_BYTES) {
    return {
      kind: "rejected",
      code: "bad_request",
      message: "Wait payload exceeds the 1 MiB inline limit.",
    };
  }

  const schema = wait.schema;

  const valid =
    schema.kind === "value"
      ? isFieldValue(schema.type, payload)
      : isRecord(payload) &&
        Object.entries(schema.fields).every(([field, type]) => {
          const key = field.replace(/\?$/, "");

          return (
            (field.endsWith("?") && payload[key] === undefined) || isFieldValue(type, payload[key])
          );
        });

  return valid
    ? null
    : {
        kind: "rejected",
        code: "bad_request",
        message: "Wait payload does not match its declared schema.",
      };
}
