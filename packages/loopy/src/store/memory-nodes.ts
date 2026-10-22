import type { HookRecord, LogRecord, RunSnapshot } from "../core/index.js";
import { executionKeyString, type NodeRun, type StoreEffect } from "../core/index.js";
import { type EventTransaction } from "./event-outbox.js";
import { MemoryRuns } from "./memory-runs.js";
import { checkLogBytes, checkNodeWrite, logRecord } from "./node-write.js";
import { earliestWakeAt, normalizeNode, utc } from "./timestamps.js";
import { publicHook } from "./wait.js";

export class MemoryNodes extends MemoryRuns {
  async getNodeRuns(runId: string): Promise<NodeRun[]> {
    return structuredClone([...(this.nodes.get(runId)?.values() ?? [])]);
  }

  async apply({
    runId,
    token,
    effects,
  }: {
    runId: string;
    token: string;
    effects: StoreEffect[];
  }): Promise<void> {
    this.commit((txn) => {
      const run = this.owned(runId, token);
      this.requireRunning(run);
      // A stale batch may clear the signal wake before it reaches its suspend effect.
      const wakeAtBeforeApply = run.wakeAt;

      for (const effect of effects) {
        this.applyEffect(
          txn,
          runId,
          effect.kind === "suspend_run"
            ? { ...effect, wakeAt: earliestWakeAt(wakeAtBeforeApply, effect.wakeAt) }
            : effect,
        );
      }
    });
  }

  protected applyEffect(txn: EventTransaction, runId: string, effect: StoreEffect): void {
    const run = this.requireRun(runId);

    switch (effect.kind) {
      case "write_node_run": {
        const node = normalizeNode(effect.nodeRun);

        checkNodeWrite(runId, node);

        if (node.status === "running") {
          delete run.nextRetryAt;
          delete run.wakeAt;
        }

        const nodes = this.nodes.get(runId) ?? new Map<string, NodeRun>();
        nodes.set(executionKeyString(node.key), structuredClone(node));
        this.nodes.set(runId, nodes);
        const key = executionKeyString(node.key);
        const attempts = this.attempts.get(key) ?? new Map<number, NodeRun>();
        attempts.set(node.attempt, structuredClone(node));
        this.attempts.set(key, attempts);
        this.emit(txn, { entity: "node", kind: node.status, runId, record: node });
        break;
      }

      case "finish_run": {
        run.status = effect.outcome.status;

        if (effect.outcome.status === "succeeded") {
          run.output = structuredClone(effect.outcome.output);
        }

        if (effect.outcome.status === "failed") {
          run.error = effect.outcome.error;
        }

        delete run.wakeAt;
        delete run.nextRetryAt;
        run.updatedAt = utc(effect.at);
        this.emit(txn, { entity: "run", kind: "finished", runId, record: run });
        break;
      }

      case "schedule_retry": {
        run.nextRetryAt = utc(effect.at);
        run.wakeAt = utc(effect.at);
        break;
      }

      case "write_log": {
        if (effect.executionKey.runId !== runId) {
          throw new Error("Log belongs to another run.");
        }

        const logs = this.logs.get(runId) ?? new Map<number, LogRecord>();
        const usageKey = JSON.stringify([executionKeyString(effect.executionKey), effect.attempt]);
        const usage = this.logUsage.get(usageKey) ?? { bytes: 0, index: -1 };
        const record = logRecord({ seq: logs.size + 1, index: usage.index + 1 }, effect);
        this.logUsage.set(usageKey, {
          bytes: checkLogBytes(usage.bytes, record),
          index: record.position.index,
        });
        logs.set(record.seq, structuredClone(record));
        this.logs.set(runId, logs);
        this.logIds.set(++this.logSequence, structuredClone(record));
        this.logNodeIds.set(this.logSequence, effect.executionKey.nodeId);
        this.emit(txn, { entity: "log", kind: "written", runId, record });
        break;
      }
    }
  }

  async getLogs(runId: string, after = 0, limit = 200): Promise<LogRecord[]> {
    return structuredClone(
      [...(this.logs.get(runId)?.values() ?? [])]
        .filter((log) => log.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, Math.min(limit, 200)),
    );
  }

  protected readHooks(runId: string): HookRecord[] {
    return [...this.waits.values()].flatMap((wait) =>
      wait.runId === runId ? [publicHook(wait)] : [],
    );
  }

  async snapshotRun(id: string): Promise<RunSnapshot | undefined> {
    const run = this.runs.get(id);

    if (!run) {
      return undefined;
    }

    return structuredClone({
      run,
      nodeRuns: [...(this.nodes.get(id)?.values() ?? [])],
      steps: [],
      hooks: this.readHooks(id),
      logs: [...(this.logs.get(id)?.values() ?? [])].sort((left, right) => left.seq - right.seq),
      cursor: this.sequence,
      epoch: this.storeEpoch,
    });
  }
}
