import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore, Storage } from "../src/index.ts";

test("summary cursors, retention batches and interleaved live event order stay bounded", async () => {
  const path = mkdtempSync(join(tmpdir(), "loopy-history-"));
  const storage = new Storage({ projectDir: path, acquireLock: false });
  try {
    storage.runtime.createWorkflowVersion({
      workflowId: "w",
      version: 1,
      definition: { id: "w", workflowVersion: 1 },
    });
    for (let i = 0; i < 120; i++)
      storage.runtime.createRun({
        id: `r${String(i).padStart(3, "0")}`,
        workflowId: "w",
        workflowVersion: 1,
        status: "succeeded",
        input: { big: "x".repeat(10000) },
      });
    const first = storage.runtime.listRunSummaries({ limit: 25 });
    const second = storage.runtime.listRunSummaries({ limit: 25, cursor: first.nextCursor });
    expect(first.runs).toHaveLength(25);
    expect(second.runs).toHaveLength(25);
    expect(new Set([...first.runs, ...second.runs].map((r) => r.id)).size).toBe(50);
    expect(JSON.stringify(first)).not.toContain("big");
    const preview = storage.schedules.previewRetention({ batchSize: 10, maxRuns: 100 });
    expect(preview.candidates).toHaveLength(10);
    expect(preview.hasMore).toBe(true);
    const applied = storage.schedules.applyRetention({ batchSize: 10, maxRuns: 100 });
    expect(applied.deletedRunIds).toEqual(preview.candidates.map((r) => r.runId));
    const run = storage.runtime.createRun({
      id: crypto.randomUUID(),
      workflowId: "w",
      workflowVersion: 1,
      status: "running",
      input: {},
    });
    const store = new SqliteRuntimeStore(storage);
    for (let i = 0; i < 100; i++) {
      store.appendProviderTraceEvent(run.id, {
        schemaVersion: "1",
        monotonicOffsetMs: 0,
        redaction: { status: "none", removedFields: [] },
        id: crypto.randomUUID(),
        runId: run.id,
        nodeId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        sessionId: "session",
        occurredAt: new Date().toISOString(),
        type: "provider.message",
        provider: "codex",
        payload: { role: "assistant", content: "event" },
      });
      await store.commit([
        {
          type: "append_event",
          event: {
            runId: run.id,
            sequence: 0,
            type: "run.paused",
            occurredAt: new Date().toISOString(),
          },
        },
      ]);
    }
    const events = await store.listEvents(run.id);
    expect(events.map((e) => e.sequence)).toEqual(Array.from({ length: 201 }, (_, i) => i));
  } finally {
    storage.close();
    rmSync(path, { recursive: true, force: true });
  }
});
