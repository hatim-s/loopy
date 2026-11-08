import {
  executionKeyString,
  type HookRecord,
  type Json,
  type NodeRun,
  type StoreEffect,
  type WaitRecord,
  type WaitResolution,
} from "@loopy/core";
import { StoreInvariantError } from "../operation";
import { utc } from "../timestamps";
import { checkSignal, publicHook, registerWait } from "../wait";
import type { SqlContext, SqlWrite } from "./context";
import { emit } from "./events";
import { readNode, writeNodeRun } from "./nodes";
import { decodeWait, rowToRun } from "./rows";
import { markWoken, readRun } from "./runs";

export function readWaits(ctx: SqlContext, runId: string): WaitRecord[] {
  return ctx.db
    .query<{ record: string }, [string]>("SELECT record FROM waits WHERE run_id=? ORDER BY rowid")
    .all(runId)
    .map((row) => decodeWait(row.record));
}

export function readHooks(ctx: SqlContext, runId: string, limit: number): HookRecord[] {
  return ctx.db
    .query<{ record: string }, [string, number]>(
      "SELECT record FROM waits WHERE run_id=? ORDER BY rowid LIMIT ?",
    )
    .all(runId, limit)
    .map((row) => publicHook(decodeWait(row.record)));
}

function readWait(ctx: SqlContext, token: string): WaitRecord | undefined {
  const row = ctx.db
    .query<{ record: string }, [string]>("SELECT record FROM waits WHERE token=?")
    .get(token);

  return row ? decodeWait(row.record) : undefined;
}

function writeWait(write: SqlWrite, wait: WaitRecord): void {
  write.db.query("UPDATE waits SET record=? WHERE token=?").run(JSON.stringify(wait), wait.token);
}

function expireWait(write: SqlWrite, wait: WaitRecord, at: string): void {
  if (wait.resolvedAt || wait.expiredAt) {
    return;
  }

  const record = { ...wait, expiredAt: utc(at) };
  writeWait(write, record);
  emit(write, { entity: "hook", kind: "expired", runId: wait.runId, record: publicHook(record) });
}

export function expireWaits(write: SqlWrite, runId: string, at: string): void {
  for (const wait of readWaits(write, runId)) {
    expireWait(write, wait, at);
  }
}

// A node that leaves the waiting state closes the hook that was waiting on it.
export function expireNodeWait(write: SqlWrite, node: NodeRun): void {
  const key = executionKeyString(node.key);

  for (const wait of readWaits(write, node.key.runId)) {
    if (executionKeyString(wait.executionKey) === key) {
      expireWait(write, wait, "endedAt" in node ? node.endedAt : write.at);
    }
  }
}

export function insertWait(
  write: SqlWrite,
  runId: string,
  effect: Extract<StoreEffect, { kind: "register_wait" }>,
): void {
  if (effect.executionKey.runId !== runId) {
    throw new StoreInvariantError("Wait belongs to another run.");
  }

  const key = executionKeyString(effect.executionKey);
  const wait = registerWait(effect, readNode(write, runId, key), readWaits(write, runId));

  if (wait) {
    write.db
      .query("INSERT INTO waits VALUES (?,?,?,?)")
      .run(wait.token, runId, key, JSON.stringify(wait));
    emit(write, { entity: "hook", kind: "created", runId, record: publicHook(wait) });
  }
}

export function resolveWait(
  write: SqlWrite,
  { token, payload, at }: { token: string; payload: Json; at: string },
): WaitResolution {
  const wait = readWait(write, token);
  const node = wait && readNode(write, wait.runId, executionKeyString(wait.executionKey));
  const row = wait && readRun(write, wait.runId);
  const rejected = checkSignal({ wait, node, run: row ? rowToRun(row) : undefined, payload, at });

  if (rejected) {
    return rejected;
  }

  if (!wait || !node) {
    throw new StoreInvariantError("Validated wait disappeared.");
  }

  const resolved = { ...wait, payload, resolvedAt: utc(at) };
  writeWait(write, resolved);
  emit(write, {
    entity: "hook",
    kind: "resolved",
    runId: wait.runId,
    record: publicHook(resolved),
  });
  writeNodeRun(write, wait.runId, {
    key: node.key,
    attempt: node.attempt,
    maxAttempts: node.maxAttempts,
    startedAt: node.startedAt,
    receipt: node.receipt,
    status: "succeeded",
    output: payload,
    endedAt: utc(at),
  });
  markWoken(write, wait.runId, at);

  return { kind: "resolved", runId: wait.runId };
}
