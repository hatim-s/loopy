import {
  executionKeyString,
  type NodeRun,
  type Store,
  type StoreEffect,
  type WaitResolution,
} from "../../core/index.js";
import type { EventTransaction } from "../event-outbox.js";
import { earliestWakeAt, utc } from "../timestamps.js";
import { checkSignal, publicHook, registerWait } from "../wait.js";
import { SqliteNodes } from "./nodes.js";
import { rowToRun, SQL } from "./store-rows.js";

export class SqliteWaits extends SqliteNodes {
  protected override applyEffect(txn: EventTransaction, runId: string, effect: StoreEffect): void {
    if (effect.kind === "register_wait") {
      if (effect.executionKey.runId !== runId) {
        throw new Error("Wait belongs to another run.");
      }

      const key = executionKeyString(effect.executionKey);
      const node = this.readNode(runId, key);
      const wait = registerWait(effect, node, this.readWaits(runId));

      if (wait) {
        this.db
          .query("INSERT INTO waits VALUES (?,?,?,?)")
          .run(wait.token, runId, key, JSON.stringify(wait));
        this.emit(txn, { entity: "hook", kind: "created", runId, record: publicHook(wait) });
      }

      return;
    }

    if (effect.kind === "suspend_run") {
      const run = this.requireRow(runId);
      this.db
        .query(SQL.suspend)
        .run(earliestWakeAt(run.wake_at, effect.wakeAt), utc(effect.at), runId, run.owner_token);
      this.emitRun(txn, runId, "suspended");

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
    const key = executionKeyString(node.key);

    for (const wait of this.readWaits(node.key.runId)) {
      if (executionKeyString(wait.executionKey) === key) {
        this.expireWait(txn, wait, "endedAt" in node ? node.endedAt : this.timestamp());
      }
    }
  }

  async resolveWait({
    token,
    payload,
    at,
  }: Parameters<Store["resolveWait"]>[0]): Promise<WaitResolution> {
    return this.commit((txn) => {
      const wait = this.readWait(token);

      const node = wait && this.readNode(wait.runId, executionKeyString(wait.executionKey));

      const row = wait && this.row(wait.runId);

      const rejected = checkSignal({
        wait,
        node,
        run: row ? rowToRun(row) : undefined,
        payload,
        at,
      });

      if (rejected) {
        return rejected;
      }

      if (!wait || !node) {
        throw new Error("Validated wait disappeared.");
      }

      const resolved = { ...wait, payload, resolvedAt: utc(at) };
      this.writeWait(resolved);
      this.emit(txn, {
        entity: "hook",
        kind: "resolved",
        runId: wait.runId,
        record: publicHook(resolved),
      });
      this.applyEffect(txn, wait.runId, {
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
      this.db.query(SQL.wakeRun).run(utc(at), utc(at), wait.runId);
      this.emitRun(txn, wait.runId, "woken");

      return { kind: "resolved", runId: wait.runId };
    });
  }
}
