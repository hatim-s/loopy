import { nodeRunSchema } from "../../contract/index.js";
import type { LogRecord, RunSnapshot } from "../../core/index.js";
import { executionKeyString, type NodeRun, type StoreEffect } from "../../core/index.js";
import { type EventTransaction } from "../event-outbox.js";
import { checkLogBytes, checkNodeWrite, logRecord } from "../node-write.js";
import { earliestWakeAt, normalizeNode, utc } from "../timestamps.js";
import { SqliteRuns } from "./runs.js";
import { rowToLog, rowToRun, SQL } from "./store-rows.js";
import { type LogRow } from "./store-schema.js";

export class SqliteNodes extends SqliteRuns {
  protected readNodes(runId: string): NodeRun[] {
    return this.db
      .query<{ record: string }, [string]>(
        "SELECT record FROM node_runs WHERE run_id=? ORDER BY rowid",
      )
      .all(runId)
      .map((row) => nodeRunSchema.parse(JSON.parse(row.record)));
  }

  protected readNode(runId: string, key: string): NodeRun | undefined {
    const row = this.db
      .query<{ record: string }, [string, string]>(
        "SELECT record FROM node_runs WHERE run_id=? AND execution_key=?",
      )
      .get(runId, key);

    return row ? nodeRunSchema.parse(JSON.parse(row.record)) : undefined;
  }

  async getNodeRuns(runId: string): Promise<NodeRun[]> {
    return this.readNodes(runId);
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
      const wakeAtBeforeApply = run.wake_at;

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
    switch (effect.kind) {
      case "write_node_run": {
        const node = normalizeNode(effect.nodeRun);

        checkNodeWrite(runId, node);

        if (node.status === "running") {
          this.db.query("UPDATE runs SET next_retry_at=NULL,wake_at=NULL WHERE id=?").run(runId);
        }

        this.db
          .query(SQL.putNode)
          .run(
            runId,
            executionKeyString(node.key),
            node.attempt,
            node.status,
            node.startedAt,
            "endedAt" in node ? node.endedAt : null,
            node.status === "succeeded" ? JSON.stringify(node.output) : null,
            "error" in node ? JSON.stringify(node.error) : null,
            node.receipt,
            JSON.stringify(node),
            node.key.nodeId,
            JSON.stringify(node.key.scope),
          );
        this.db
          .query(
            "INSERT INTO node_attempts VALUES (?,?,?,?) ON CONFLICT(run_id,execution_key,attempt) DO UPDATE SET record=excluded.record",
          )
          .run(runId, executionKeyString(node.key), node.attempt, JSON.stringify(node));

        for (const [depth, scope] of node.key.scope.entries()) {
          this.db
            .query(
              "INSERT INTO node_scopes VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,execution_key,map_node,parent_scope) DO UPDATE SET status=excluded.status",
            )
            .run(
              runId,
              executionKeyString(node.key),
              scope.nodeId,
              JSON.stringify(node.key.scope.slice(0, depth)),
              scope.index,
              node.status,
            );
        }

        this.emit(txn, { entity: "node", kind: node.status, runId, record: node });
        break;
      }

      case "finish_run": {
        const outcome = effect.outcome;
        this.db
          .query(SQL.finish)
          .run(
            outcome.status,
            outcome.status === "succeeded" ? JSON.stringify(outcome.output) : null,
            outcome.status === "failed" ? outcome.error : null,
            utc(effect.at),
            runId,
            this.requireRow(runId).owner_token,
          );
        this.emitRun(txn, runId, "finished");
        break;
      }

      case "schedule_retry": {
        this.db
          .query("UPDATE runs SET next_retry_at=?,wake_at=?,updated_at=? WHERE id=?")
          .run(utc(effect.at), utc(effect.at), this.timestamp(), runId);
        break;
      }

      case "write_log": {
        if (effect.executionKey.runId !== runId) {
          throw new Error("Log belongs to another run.");
        }

        this.writeLog(txn, effect);
        break;
      }
    }
  }

  protected writeLog(
    txn: EventTransaction,
    effect: Extract<StoreEffect, { kind: "write_log" }>,
  ): void {
    const runId = effect.executionKey.runId;
    const key = executionKeyString(effect.executionKey);

    const seq =
      this.db
        .query<{ seq: number }, [string]>(
          "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM logs WHERE run_id=?",
        )
        .get(runId)?.seq ?? 1;

    const index =
      this.db
        .query<{ idx: number }, [string, number]>(
          "SELECT COALESCE(MAX(log_index),-1)+1 AS idx FROM logs WHERE execution_key=? AND attempt=?",
        )
        .get(key, effect.attempt)?.idx ?? 0;

    const previousBytes =
      this.db
        .query<{ bytes: number }, [string, number]>(
          "SELECT bytes FROM log_attempt_usage WHERE execution_key=? AND attempt=?",
        )
        .get(key, effect.attempt)?.bytes ?? 0;

    const record = logRecord({ seq, index }, effect);
    const bytes = checkLogBytes(previousBytes, record);
    this.db
      .query(
        "INSERT INTO log_attempt_usage VALUES (?,?,?) ON CONFLICT(execution_key,attempt) DO UPDATE SET bytes=excluded.bytes",
      )
      .run(key, effect.attempt, bytes);
    this.db
      .query(SQL.appendLog)
      .run(
        runId,
        key,
        effect.attempt,
        index,
        seq,
        JSON.stringify(record),
        effect.executionKey.nodeId,
        record.at,
        record.level,
        record.message,
        record.data === undefined
          ? 0
          : new TextEncoder().encode(JSON.stringify(record.data)).byteLength,
      );
    this.emit(txn, { entity: "log", kind: "written", runId: record.runId, record });
  }

  async getLogs(runId: string, after = 0, limit = 200): Promise<LogRecord[]> {
    return this.db
      .query<LogRow, [string, number, number]>(`${SQL.logs} LIMIT ?`)
      .all(runId, after, Math.min(limit, 200))
      .map(rowToLog);
  }

  async snapshotRun(id: string): Promise<RunSnapshot | undefined> {
    return this.db
      .transaction(() => {
        const row = this.row(id);

        if (!row) {
          return undefined;
        }

        return {
          run: rowToRun(row),
          nodeRuns: this.readNodes(id),
          steps: [],
          logs: this.db.query<LogRow, [string, number]>(SQL.logs).all(id, 0).map(rowToLog),
          hooks: this.readHooks(id),
          ...this.readEventCursor(),
        };
      })
      .deferred();
  }
}
