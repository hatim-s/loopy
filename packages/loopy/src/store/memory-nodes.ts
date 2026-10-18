import type { LogRecord, RunSnapshot } from "../core/index.js";
import { executionKeyString, type NodeRun, type StoreEffect } from "../core/index.js";
import { type EventTransaction } from "./event-outbox.js";
import { MemoryRuns } from "./memory-runs.js";
import { checkLogWrite, checkNodeWrite, logRecord } from "./node-write.js";

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
      this.requireRunning(this.owned(runId, token));

      for (const effect of effects) {
        this.applyEffect(txn, runId, effect);
      }
    });
  }

  protected applyEffect(txn: EventTransaction, runId: string, effect: StoreEffect): void {
    const run = this.requireRun(runId);

    switch (effect.kind) {
      case "write_node_run": {
        const node = effect.nodeRun;

        checkNodeWrite(runId, node);

        if (node.status === "running") {
          delete run.nextRetryAt;
          delete run.wakeAt;
        }

        const nodes = this.nodes.get(runId) ?? new Map<string, NodeRun>();
        nodes.set(executionKeyString(node.key), structuredClone(node));
        this.nodes.set(runId, nodes);
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
        run.updatedAt = effect.at;
        this.emit(txn, { entity: "run", kind: "finished", runId, record: run });
        break;
      }

      case "schedule_retry": {
        run.nextRetryAt = effect.at;
        run.wakeAt = effect.at;
        break;
      }

      case "write_log": {
        if (effect.executionKey.runId !== runId) {
          throw new Error("Log belongs to another run.");
        }

        const logs = this.logs.get(runId) ?? new Map<number, LogRecord>();
        const record = logRecord([...logs.values()], effect);
        checkLogWrite([...logs.values()], record);
        logs.set(record.seq, structuredClone(record));
        this.logs.set(runId, logs);
        this.emit(txn, { entity: "log", kind: "written", runId, record });
        break;
      }
    }
  }

  async getLogs(runId: string, after = 0): Promise<LogRecord[]> {
    return structuredClone(
      [...(this.logs.get(runId)?.values() ?? [])]
        .filter((log) => log.seq > after)
        .sort((a, b) => a.seq - b.seq),
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
      hooks: [],
      logs: [...(this.logs.get(id)?.values() ?? [])].sort((left, right) => left.seq - right.seq),
      cursor: this.sequence,
      epoch: this.storeEpoch,
    });
  }
}
