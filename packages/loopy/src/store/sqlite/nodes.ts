import { nodeRunSchema } from "../../contract/index.js";
import type { LogRecord, RunSnapshot } from "../../core/index.js";
import { executionKeyString, type NodeRun, type StoreEffect } from "../../core/index.js";
import { type EventTransaction } from "../event-outbox.js";
import { checkLogWrite, checkNodeWrite, logRecord } from "../node-write.js";
import { normalizeNode, utc } from "../timestamps.js";
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
      this.requireRunning(this.owned(runId, token));

      for (const effect of effects) {
        this.applyEffect(txn, runId, effect);
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
          );
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
    const previous = this.db
      .query<LogRow, [string, number]>(SQL.logs)
      .all(effect.executionKey.runId, 0)
      .map(rowToLog);

    const record = logRecord(previous, effect);
    checkLogWrite(previous, record);
    this.db
      .query(SQL.appendLog)
      .run(
        record.runId,
        record.position.executionKey,
        record.position.attempt,
        record.position.index,
        record.seq,
        JSON.stringify(record),
      );
    this.emit(txn, { entity: "log", kind: "written", runId: record.runId, record });
  }

  async getLogs(runId: string, after = 0): Promise<LogRecord[]> {
    return this.db.query<LogRow, [string, number]>(SQL.logs).all(runId, after).map(rowToLog);
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
          hooks: [],
          ...this.readEventCursor(),
        };
      })
      .deferred();
  }
}
