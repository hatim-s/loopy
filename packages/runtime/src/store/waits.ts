import {
  checkOutSchema,
  executionKeyString,
  type HookRecord,
  isTerminalRun,
  type Json,
  type NodeRun,
  outSchemaMessage,
  type RunRecord,
  type StoreEffect,
  type WaitRecord,
  type WaitResolution,
} from "@loopy/core";
import { Struct } from "effect";
import type { SqlContext, SqlWrite } from "./context";
import { emit } from "./events";
import { readNode, writeNodeRun } from "./nodes";
import { StoreInvariantError } from "./operation";
import { decodeWait, rowToRun } from "./rows";
import { markWoken, readRun } from "./runs";
import { utc } from "./timestamps";

function publicHook(wait: WaitRecord): HookRecord {
  return Struct.omit(wait, ["executionKey", "schema"]);
}

function registerWait(
  effect: Extract<StoreEffect, { kind: "register_wait" }>,
  node: NodeRun | undefined,
  waits: WaitRecord[],
): WaitRecord | undefined {
  if (!node || node.status !== "waiting") {
    throw new StoreInvariantError("Register a wait only after persisting its waiting node.");
  }

  if (
    waits.some((wait) => executionKeyString(wait.executionKey) === executionKeyString(node.key))
  ) {
    return undefined;
  }

  return {
    token: crypto.randomUUID(),
    executionKey: node.key,
    schema: effect.payload,
    runId: node.key.runId,
    seq: waits.reduce((max, wait) => Math.max(max, wait.seq), 0) + 1,
    name: effect.name,
    createdAt: utc(effect.at),
  };
}

function checkSignal({
  wait,
  node,
  run,
  payload,
  at,
}: {
  wait: WaitRecord | undefined;
  node: NodeRun | undefined;
  run: RunRecord | undefined;
  payload: Json;
  at: string;
}): Extract<WaitResolution, { kind: "rejected" }> | null {
  if (
    !wait ||
    !run ||
    isTerminalRun(run.status) ||
    wait.resolvedAt ||
    wait.expiredAt ||
    node?.status !== "waiting" ||
    (node.wakeAt !== null && Date.parse(at) >= Date.parse(node.wakeAt))
  ) {
    return {
      kind: "rejected",
      code: "unknown_hook",
      message: "The hook is unknown or no longer pending.",
    };
  }

  const issue = checkOutSchema(payload, wait.schema);

  return issue === null
    ? null
    : { kind: "rejected", code: "bad_request", message: outSchemaMessage("Wait payload", issue) };
}

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
