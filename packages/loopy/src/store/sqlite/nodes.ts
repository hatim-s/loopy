import { nodeRunSchema } from "../../contract/index.js";
import type { LogRecord, RunSnapshot } from "../../core/index.js";
import { executionKeyString, type NodeRun, type StoreEffect } from "../../core/index.js";
import { type EventTransaction } from "../event-outbox.js";
import { checkLogWrite, checkNodeWrite } from "../node-write.js";
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
        const node = effect.nodeRun;

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
            effect.at,
            runId,
            this.requireRow(runId).owner_token,
          );
        this.emitRun(txn, runId, "finished");
        break;
      }

      case "schedule_retry": {
        this.db
          .query("UPDATE runs SET next_retry_at=?,wake_at=?,updated_at=? WHERE id=?")
          .run(effect.at, effect.at, this.timestamp(), runId);
        break;
      }

      case "emit_event": {
        if (effect.event.runId !== runId) {
          throw new Error("Event belongs to another run.");
        }

        if (effect.event.entity === "log") {
          this.writeLog(txn, effect.event.record);
        } else {
          this.emit(txn, effect.event);
        }

        break;
      }
    }
  }

  protected writeLog(txn: EventTransaction, log: LogRecord): void {
    if (log.position.kind !== "node") {
      throw new Error("Attempt logs require a node execution key.");
    }

    const seq =
      this.db
        .query<{ seq: number }, [string]>(
          "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM logs WHERE run_id=?",
        )
        .get(log.runId)?.seq ?? 1;

    checkLogWrite(
      this.db
        .query<LogRow, [string, number]>(
          "SELECT record FROM logs WHERE execution_key=? AND attempt=?",
        )
        .all(log.position.executionKey, log.position.attempt)
        .map(rowToLog),
      log,
    );
    const record = { ...log, seq };
    this.db
      .query(SQL.appendLog)
      .run(
        log.runId,
        log.position.executionKey,
        log.position.attempt,
        log.position.index,
        seq,
        JSON.stringify(record),
      );
    this.emit(txn, { entity: "log", kind: "written", runId: log.runId, record });
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
