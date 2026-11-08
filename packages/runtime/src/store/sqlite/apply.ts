import type { StoreEffect } from "@loopy/core";
import { StoreInvariantError } from "../operation";
import { earliestWakeAt, utc } from "../timestamps";
import type { SqlWrite } from "./context";
import { writeLog, writeNodeRun } from "./nodes";
import { finishRun, requireRunning, suspendRun } from "./runs";
import { expireNodeWait, expireWaits, insertWait } from "./waits";

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
      if (effect.executionKey.runId !== runId) {
        throw new StoreInvariantError("Log belongs to another run.");
      }

      writeLog(write, effect);

      return;
    }

    case "finish_run": {
      finishRun(write, runId, token, effect.outcome, effect.at);
      expireWaits(write, runId, effect.at);

      return;
    }

    case "schedule_activation": {
      write.db
        .query("UPDATE runs SET next_retry_at=?,wake_at=?,updated_at=? WHERE id=?")
        .run(utc(effect.at), utc(effect.at), write.at, runId);

      return;
    }

    case "register_wait": {
      insertWait(write, runId, effect);

      return;
    }

    case "suspend_run": {
      suspendRun(write, runId, token, effect.wakeAt, effect.at);

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
