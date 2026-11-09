import { executionKeyString, type NodeRun, type StoreEffect } from "@loopy/core";
import { checkLogBytes, checkNodeWrite, logRecord } from "../node-write";
import { normalizeNode } from "../timestamps";
import type { SqlContext, SqlWrite } from "./context";
import { emit, emitLog } from "./events";
import { decodeLog, decodeNodeRun } from "./rows";

export function readNodes(ctx: SqlContext, runId: string): NodeRun[] {
  return ctx.db
    .query<{ record: string }, [string]>(
      "SELECT record FROM node_runs WHERE run_id=? ORDER BY rowid",
    )
    .all(runId)
    .map((row) => decodeNodeRun(row.record));
}

export function readNode(ctx: SqlContext, runId: string, key: string): NodeRun | undefined {
  const row = ctx.db
    .query<{ record: string }, [string, string]>(
      "SELECT record FROM node_runs WHERE run_id=? AND execution_key=?",
    )
    .get(runId, key);

  return row ? decodeNodeRun(row.record) : undefined;
}

export function writeNodeRun(write: SqlWrite, runId: string, nodeRun: NodeRun): void {
  const node = normalizeNode(nodeRun);
  const key = executionKeyString(node.key);
  const record = JSON.stringify(node);

  checkNodeWrite(runId, node);

  if (node.status === "running") {
    write.db.query("UPDATE runs SET next_retry_at=NULL,wake_at=NULL WHERE id=?").run(runId);
  }

  write.db
    .query(
      `INSERT INTO node_runs(run_id,execution_key,attempt,status,started_at,finished_at,output,error,receipt,record,node_id,scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,execution_key) DO UPDATE SET attempt=excluded.attempt,status=excluded.status,started_at=excluded.started_at,finished_at=excluded.finished_at,output=excluded.output,error=excluded.error,receipt=excluded.receipt,record=excluded.record,node_id=excluded.node_id,scope=excluded.scope`,
    )
    .run(
      runId,
      key,
      node.attempt,
      node.status,
      node.startedAt,
      "endedAt" in node ? node.endedAt : null,
      node.status === "succeeded" ? JSON.stringify(node.output) : null,
      "error" in node ? JSON.stringify(node.error) : null,
      node.receipt,
      record,
      node.key.nodeId,
      JSON.stringify(node.key.scope),
    );
  write.db
    .query(
      "INSERT INTO node_attempts VALUES (?,?,?,?) ON CONFLICT(run_id,execution_key,attempt) DO UPDATE SET record=excluded.record",
    )
    .run(runId, key, node.attempt, record);

  for (const [depth, scope] of node.key.scope.entries()) {
    write.db
      .query(
        "INSERT INTO node_scopes VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,execution_key,map_node,parent_scope) DO UPDATE SET status=excluded.status",
      )
      .run(
        runId,
        key,
        scope.nodeId,
        JSON.stringify(node.key.scope.slice(0, depth)),
        scope.index,
        node.status,
      );
  }

  emit(write, { entity: "node", kind: node.status, runId, record: node });
}

export function writeLog(write: SqlWrite, effect: Extract<StoreEffect, { kind: "write_log" }>) {
  const runId = effect.executionKey.runId;
  const key = executionKeyString(effect.executionKey);

  const seq =
    write.db
      .query<{ seq: number }, [string]>(
        "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM logs WHERE run_id=?",
      )
      .get(runId)?.seq ?? 1;

  const index =
    write.db
      .query<{ idx: number }, [string, number]>(
        "SELECT COALESCE(MAX(log_index),-1)+1 AS idx FROM logs WHERE execution_key=? AND attempt=?",
      )
      .get(key, effect.attempt)?.idx ?? 0;

  const previousBytes =
    write.db
      .query<{ bytes: number }, [string, number]>(
        "SELECT bytes FROM log_attempt_usage WHERE execution_key=? AND attempt=?",
      )
      .get(key, effect.attempt)?.bytes ?? 0;

  const record = logRecord({ seq, index }, effect);
  const bytes = checkLogBytes(previousBytes, record);
  write.db
    .query(
      "INSERT INTO log_attempt_usage VALUES (?,?,?) ON CONFLICT(execution_key,attempt) DO UPDATE SET bytes=excluded.bytes",
    )
    .run(key, effect.attempt, bytes);
  write.db
    .query(
      "INSERT INTO logs(run_id,execution_key,attempt,log_index,seq,record,node_id,at,level,message,data_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
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
  emitLog(write, record, effect.executionKey.nodeId);
}

export function readLogs(ctx: SqlContext, runId: string, after: number, limit: number) {
  return ctx.db
    .query<{ record: string }, [string, number, number]>(
      "SELECT record FROM logs WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
    )
    .all(runId, after, limit)
    .map((row) => decodeLog(row.record));
}

export function readLog(ctx: SqlContext, id: number) {
  const row = ctx.db
    .query<{ record: string }, [number]>("SELECT record FROM logs WHERE id=?")
    .get(id);

  return row ? { id, log: decodeLog(row.record) } : undefined;
}
