import {
  executionKeyString,
  type NodeRun,
  type Store,
  type StoreEffect,
  type WaitRecord,
} from "@loopy/core";
import type { EventTransaction } from "../event-outbox";
import { StoreInvariantError, storageOperation } from "../operation";
import { earliestWakeAt, utc } from "../timestamps";
import { checkSignal, publicHook, registerWait } from "../wait";
import { MemoryNodes } from "./nodes";

export class MemoryWaits extends MemoryNodes {
  getWaits(runId: string) {
    return storageOperation("getWaits", () => {
      return structuredClone([...this.waits.values()].filter((wait) => wait.runId === runId));
    });
  }

  getWait(token: string) {
    return storageOperation("getWait", () => {
      return structuredClone(this.waits.get(token));
    });
  }

  protected override applyEffect(txn: EventTransaction, runId: string, effect: StoreEffect): void {
    if (effect.kind === "register_wait") {
      if (effect.executionKey.runId !== runId) {
        throw new StoreInvariantError("Wait belongs to another run.");
      }

      const node = this.nodes.get(runId)?.get(executionKeyString(effect.executionKey));

      const wait = registerWait(
        effect,
        node,
        [...this.waits.values()].filter((wait) => wait.runId === runId),
      );

      if (wait) {
        this.waits.set(wait.token, wait);
        this.emit(txn, { entity: "hook", kind: "created", runId, record: publicHook(wait) });
      }

      return;
    }

    if (effect.kind === "suspend_run") {
      const run = this.requireRun(runId);
      run.status = "suspended";
      run.updatedAt = utc(effect.at);
      const wakeAt = earliestWakeAt(run.wakeAt, effect.wakeAt);
      delete run.wakeAt;

      if (wakeAt !== null) {
        run.wakeAt = wakeAt;
      }

      this.emit(txn, { entity: "run", kind: "suspended", runId, record: run });

      return;
    }

    super.applyEffect(txn, runId, effect);

    if (effect.kind === "write_node_run" && effect.nodeRun.status !== "waiting") {
      this.expireNodeWait(txn, effect.nodeRun);
    }

    if (effect.kind === "finish_run") {
      this.expireWaits(txn, runId, effect.at);
    }
  }

  private expireNodeWait(txn: EventTransaction, node: NodeRun): void {
    for (const wait of this.waits.values()) {
      if (executionKeyString(wait.executionKey) === executionKeyString(node.key)) {
        this.expire(txn, wait, "endedAt" in node ? node.endedAt : this.timestamp());
      }
    }
  }

  private expire(txn: EventTransaction, wait: WaitRecord, at: string): void {
    if (wait.resolvedAt || wait.expiredAt) {
      return;
    }

    wait.expiredAt = utc(at);
    this.emit(txn, {
      entity: "hook",
      kind: "expired",
      runId: wait.runId,
      record: publicHook(wait),
    });
  }

  resolveWait({ token, payload, at }: Parameters<Store["resolveWait"]>[0]) {
    return storageOperation("resolveWait", () => {
      return this.commit((txn) => {
        const wait = this.waits.get(token);
        const node = wait && this.nodes.get(wait.runId)?.get(executionKeyString(wait.executionKey));
        const run = wait && this.runs.get(wait.runId);
        const rejected = checkSignal({ wait, node, run, payload, at });

        if (rejected) {
          return rejected;
        }

        if (!wait || !node || !run) {
          throw new StoreInvariantError("Validated wait disappeared.");
        }

        wait.payload = structuredClone(payload);
        wait.resolvedAt = utc(at);
        this.emit(txn, {
          entity: "hook",
          kind: "resolved" as const,
          runId: run.id,
          record: publicHook(wait),
        });
        this.applyEffect(txn, run.id, {
          kind: "write_node_run",
          nodeRun: {
            key: node.key,
            attempt: node.attempt,
            maxAttempts: node.maxAttempts,
            startedAt: node.startedAt,
            receipt: node.receipt,
            status: "succeeded",
            output: payload,
            endedAt: utc(at),
          },
        });
        run.wakeAt = utc(at);
        run.updatedAt = utc(at);
        this.emit(txn, { entity: "run", kind: "woken", runId: run.id, record: run });

        return { kind: "resolved" as const, runId: run.id };
      });
    });
  }
}
