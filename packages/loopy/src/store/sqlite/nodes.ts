import {
  executionKeyString,
  type LogRecord,
  type NodeRun,
  type RunSnapshot,
  type StoreEffect,
  StoreError,
} from "../../core/index.js";
import type { EventTransaction } from "../event-outbox.js";
import { checkLogWrite, checkNodeWrite, logRecord } from "../node-write.js";
import type { StoreContext } from "./context.js";
import { commit, emit, readEventCursor } from "./events.js";
import { getRow, owned, requireRunning, rowToRun, writeOutcome } from "./runs.js";
import type { LogRow } from "./store-schema.js";

const SQL = {
  putNode: `INSERT INTO node_runs VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,execution_key) DO UPDATE SET attempt=excluded.attempt,status=excluded.status,started_at=excluded.started_at,finished_at=excluded.finished_at,output=excluded.output,error=excluded.error,receipt=excluded.receipt,record=excluded.record`,
  appendLog: "INSERT INTO logs VALUES (?,?,?,?,?,?)",
  logs: "SELECT * FROM logs WHERE run_id=? AND seq>? ORDER BY seq",
};

export function rowToLog(row: LogRow): LogRecord {
  return JSON.parse(row.record);
}

export function readNodes(context: StoreContext, runId: string): NodeRun[] {
  return context.db
    .query<{ record: string }, [string]>(
      "SELECT record FROM node_runs WHERE run_id=? ORDER BY rowid",
    )
    .all(runId)
    .map((row) => JSON.parse(row.record));
}

export async function getNodeRuns(context: StoreContext, runId: string): Promise<NodeRun[]> {
  return readNodes(context, runId);
}

export async function apply(
  context: StoreContext,
  {
    runId,
    token,
    effects,
  }: {
    runId: string;
    token: string;
    effects: StoreEffect[];
  },
): Promise<void> {
  commit(context, (txn) => {
    requireRunning(owned(context, runId, token));

    for (const effect of effects) {
      applyEffect(context, txn, runId, effect);
    }
  });
}

export function applyEffect(
  context: StoreContext,
  txn: EventTransaction,
  runId: string,
  effect: StoreEffect,
): void {
  switch (effect.kind) {
    case "write_node_run": {
      const node = effect.nodeRun;

      checkNodeWrite(runId, node);

      if (node.status === "running") {
        context.db.query("UPDATE runs SET wake_at=NULL WHERE id=?").run(runId);
      }

      context.db
        .query(SQL.putNode)
        .run(
          runId,
          executionKeyString(node.key),
          node.attempt,
          node.status,
          node.startedAt,
          node.status === "succeeded" ||
            node.status === "failed" ||
            node.status === "retrying" ||
            node.status === "cancelled"
            ? node.endedAt
            : null,
          node.status === "succeeded" ? JSON.stringify(node.output) : null,
          node.status === "failed" || node.status === "retrying"
            ? JSON.stringify(node.error)
            : null,
          node.receipt,
          JSON.stringify(node),
        );
      emit(context, txn, { entity: "node", kind: node.status, runId, record: node });
      break;
    }

    case "finish_run": {
      const outcome = effect.outcome;
      writeOutcome(context, runId, outcome, effect.at, txn);
      break;
    }

    case "write_log": {
      if (effect.executionKey.runId !== runId) {
        throw new StoreError("wrong_run");
      }

      writeLog(context, txn, effect);
      break;
    }
  }
}

export function writeLog(
  context: StoreContext,
  txn: EventTransaction,
  effect: Extract<StoreEffect, { kind: "write_log" }>,
): void {
  const previous = context.db
    .query<LogRow, [string, number]>(SQL.logs)
    .all(effect.executionKey.runId, 0)
    .map(rowToLog);

  const record = logRecord(previous, effect);
  checkLogWrite(previous, record);
  context.db
    .query(SQL.appendLog)
    .run(
      record.runId,
      record.position.executionKey,
      record.position.attempt,
      record.position.index,
      record.seq,
      JSON.stringify(record),
    );
  emit(context, txn, { entity: "log", kind: "written", runId: record.runId, record });
}

export async function getLogs(
  context: StoreContext,
  runId: string,
  after = 0,
): Promise<LogRecord[]> {
  return context.db.query<LogRow, [string, number]>(SQL.logs).all(runId, after).map(rowToLog);
}

export async function snapshotRun(
  context: StoreContext,
  id: string,
): Promise<RunSnapshot | undefined> {
  return context.db
    .transaction(() => {
      const row = getRow(context, id);

      if (!row) {
        return undefined;
      }

      return {
        run: rowToRun(row),
        nodeRuns: readNodes(context, id),
        steps: [],
        logs: context.db.query<LogRow, [string, number]>(SQL.logs).all(id, 0).map(rowToLog),
        hooks: [],
        ...readEventCursor(context),
      };
    })
    .deferred();
}
