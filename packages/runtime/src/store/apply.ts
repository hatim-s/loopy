import type { ExecutionKey, StoreEffect } from "@loopy/core";
import type { SqlWrite } from "./context";
import { writeLog, writeNodeRun } from "./nodes";
import { StoreInvariantError } from "./operation";
import { finishRun, requireRunning, suspendRun } from "./runs";
import { earliestWakeAt } from "./timestamps";
import { expireNodeWait, expireWaits, insertWait } from "./waits";

function effectKey(effect: StoreEffect): ExecutionKey | null {
  switch (effect.kind) {
    case "write_node_run":
      return effect.nodeRun.key;
    case "write_log":
    case "register_wait":
      return effect.executionKey;
    default:
      return null;
  }
}

function applyEffect(write: SqlWrite, runId: string, token: string, effect: StoreEffect): void {
  switch (effect.kind) {
    case "write_node_run": {
      writeNodeRun(write, runId, effect.nodeRun);

      if (effect.nodeRun.status !== "waiting") {
        expireNodeWait(write, effect.nodeRun);
      }

      return;
    }

    case "write_log": {
      writeLog(write, effect);

      return;
    }

    case "finish_run": {
      finishRun(write, runId, token, effect.outcome);
      expireWaits(write, runId, effect.at);

      return;
    }

    case "register_wait": {
      insertWait(write, runId, effect);

      return;
    }

    case "suspend_run": {
      suspendRun(write, runId, token, effect.wakeAt);

      return;
    }
  }
}

export function applyBatch(
  write: SqlWrite,
  { runId, token, effects }: { runId: string; token: string; effects: StoreEffect[] },
): void {
  // A wake stored before this batch, such as a resolved hook, must survive the batch's suspension.
  const resolvedWake = requireRunning(write, runId, token).wake_at;

  if (effects.some((effect) => (effectKey(effect)?.runId ?? runId) !== runId)) {
    throw new StoreInvariantError("A batch effect belongs to another run.");
  }

  for (const effect of effects) {
    applyEffect(
      write,
      runId,
      token,
      effect.kind === "suspend_run"
        ? { ...effect, wakeAt: earliestWakeAt(resolvedWake, effect.wakeAt) }
        : effect,
    );
  }
}
