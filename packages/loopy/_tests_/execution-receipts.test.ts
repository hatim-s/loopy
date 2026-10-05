import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { ExecutionReceipt } from "../src/cloud/executor/controller.js";
import { RemoteLinuxExecutor } from "../src/cloud/executor/controller.js";
import {
  executionReceiptSchema,
  SqliteExecutionReceiptStore,
} from "../src/storage/execution-receipts.js";

import { sqliteSchema } from "../src/storage/schema.js";

const scope = { tenantId: "tenant" };
const key = { ...scope, runId: "run", attemptId: "attempt" };
const intent: ExecutionReceipt = {
  key,
  revision: 0,
  fingerprint: "fingerprint",
  cancelRequested: false,
  observation: { state: "unknown", reason: "pending" },
};

test("D1 receipt CAS has one winner, persists cancellation and isolates every key component", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "execution-receipts" },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of [...sqliteSchema, ...executionReceiptSchema]) await db.prepare(sql).run();
    const stores = Array.from({ length: 8 }, () => new SqliteExecutionReceiptStore(db, scope));
    const winners = await Promise.all(
      stores.map((store) => store.compareAndSwap(key, undefined, intent)),
    );
    expect(winners.filter(Boolean)).toHaveLength(1);
    const store = new SqliteExecutionReceiptStore(db, scope);
    const cancelled = {
      ...intent,
      revision: 1,
      cancelRequested: true,
      observation: { state: "cancelled-before-start" as const },
    };
    expect(await store.compareAndSwap(key, 0, cancelled)).toBe(true);
    expect(await store.compareAndSwap(key, 0, { ...intent, revision: 1 })).toBe(false);
    expect(await new SqliteExecutionReceiptStore(db, scope).read(key)).toEqual(cancelled);
    for (const other of [
      { ...key, runId: "other" },
      { ...key, attemptId: "other" },
    ]) {
      expect(await store.read(other)).toBeUndefined();
      expect(await store.compareAndSwap(other, undefined, { ...intent, key: other })).toBe(true);
    }
    const foreign = { ...key, tenantId: "foreign" };
    await expect(store.read(foreign)).rejects.toThrow("tenant mismatch");
    await expect(
      store.compareAndSwap(foreign, undefined, { ...intent, key: foreign }),
    ).rejects.toThrow("tenant mismatch");
    const foreignStore = new SqliteExecutionReceiptStore(db, { tenantId: "foreign" });
    expect(await foreignStore.read(foreign)).toBeUndefined();
    expect(await foreignStore.compareAndSwap(foreign, undefined, { ...intent, key: foreign })).toBe(
      true,
    );
    await expect(store.compareAndSwap(key, 1, { ...cancelled, revision: 3 })).rejects.toThrow(
      "CAS",
    );
  } finally {
    await mf.dispose();
  }
}, 30000);

test("new controllers never replay a lost launch acknowledgement or bypass durable cancel", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "execution-controller" },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of [...sqliteSchema, ...executionReceiptSchema]) await db.prepare(sql).run();
    let starts = 0;
    const provider = {
      workspace: async () => "available" as const,
      start: async () => {
        starts++;
        throw new Error("lost acknowledgement");
      },
      inspect: async () => ({ state: "not-started" as const }),
      cancel: async () => ({ state: "cancelled-before-start" as const }),
    };
    const controller = () =>
      new RemoteLinuxExecutor(new SqliteExecutionReceiptStore(db, scope), provider);
    const request = {
      key,
      fingerprint: "fp",
      command: { program: "true", args: [], maxOutputBytes: 10 },
      workspace: { workspaceId: "ws", generation: "generation" },
      deadline: "2099-01-01T00:00:00Z",
    };
    await Promise.all(Array.from({ length: 8 }, () => controller().start(request)));
    expect(starts).toBe(1);
    expect((await controller().inspect(key)).state).toBe("unknown");
    await controller().start(request);
    expect(starts).toBe(1);
    const nextKey = { ...key, attemptId: "cancelled" };
    expect((await controller().cancel(nextKey)).state).toBe("cancelled-before-start");
    expect((await controller().start({ ...request, key: nextKey })).state).toBe(
      "cancelled-before-start",
    );
    expect(starts).toBe(1);
  } finally {
    await mf.dispose();
  }
}, 30000);

test("D1 controllers persist escaped and accumulated output in bounded receipt artifacts", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "escaped-receipts" },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of [...sqliteSchema, ...executionReceiptSchema]) await db.prepare(sql).run();
    const workspace = { workspaceId: "ws", generation: "generation" };
    const limit = 1_048_576;
    let starts = 0;
    let output = { stdout: "\0".repeat(limit), stderr: "", exitCode: 0, durationMs: 1 };
    const provider = {
      workspace: async () => "available" as const,
      start: async () => {
        starts++;
        return { state: "running" as const, jobId: "job", workspace };
      },
      inspect: async () => ({ state: "completed" as const, jobId: "job", workspace, output }),
      cancel: async () => ({ state: "cancelled-before-start" as const }),
    };
    const controller = () =>
      new RemoteLinuxExecutor(new SqliteExecutionReceiptStore(db, scope), provider);
    const request = {
      key,
      fingerprint: "fp",
      command: { program: "true", args: [], maxOutputBytes: limit },
      workspace,
      deadline: "2099-01-01T00:00:00Z",
    };
    let accumulatedBytes = 0;
    for (let attempt = 0; attempt < 9; attempt++) {
      const attemptKey = { ...key, attemptId: `escaped-${attempt}` };
      // The first case is the review reproduction. Later cases split escaped bytes across both streams.
      output =
        attempt === 0
          ? { ...output, stdout: "\0".repeat(limit), stderr: "" }
          : { ...output, stdout: "\0".repeat(limit / 2), stderr: "\u0001".repeat(limit / 2) };
      const expected = { state: "completed" as const, jobId: "job", workspace, output };
      await controller().start({ ...request, key: attemptKey });
      expect(await controller().inspect(attemptKey)).toEqual(expected);
      expect(await controller().start({ ...request, key: attemptKey })).toEqual(expected);
      expect(await controller().inspect(attemptKey)).toEqual(expected);
      const receipt = await new SqliteExecutionReceiptStore(db, scope).read(attemptKey);
      expect(receipt?.revision).toBe(2);
      expect(new TextEncoder().encode(JSON.stringify(receipt)).length).toBeGreaterThan(6_000_000);
      accumulatedBytes += output.stdout.length + output.stderr.length;
    }
    expect(accumulatedBytes).toBeGreaterThan(8_000_000);
    expect(starts).toBe(9);
    const bounds = await db
      .prepare("SELECT max(length(payload)) AS pointer_bytes FROM loopy_execution_receipts")
      .first<{ pointer_bytes: number }>();
    expect(bounds?.pointer_bytes).toBeLessThan(256);
    const chunks = await db
      .prepare("SELECT max(length(content)) AS chunk_bytes FROM loopy_artifact_chunks")
      .first<{ chunk_bytes: number }>();
    expect(chunks?.chunk_bytes).toBeLessThanOrEqual(262144);

    const store = new SqliteExecutionReceiptStore(db, scope);
    const current = await store.read({ ...key, attemptId: "escaped-0" });
    if (!current) throw new Error("Receipt missing");
    // Oversized artifacts fail before CAS and leave the published revision intact.
    await expect(
      store.compareAndSwap(current.key, current.revision, {
        ...current,
        revision: current.revision + 1,
        observation: { state: "unknown", reason: "\0".repeat(1_400_000) },
      }),
    ).rejects.toThrow("Artifact exceeds limit");
    expect(await store.read(current.key)).toEqual(current);
  } finally {
    await mf.dispose();
  }
}, 60000);
