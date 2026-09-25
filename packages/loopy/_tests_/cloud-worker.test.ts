import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudWorker } from "../src/cloud/worker.js";
import type { AttemptRecord, Json, RunRecord } from "../src/core/model.js";
import { SqliteRunStore } from "../src/local/store.js";
import { RunBusyError } from "../src/runtime/errors.js";
import { Runtime } from "../src/runtime/runtime.js";

const managedRun = (status: RunRecord["status"] = "pending"): RunRecord => ({
  id: "run-1",
  slug: "cloud-test",
  workflow: { version: 1, slug: "cloud-test", nodes: [] },
  workflowHash: "hash",
  input: {},
  options: { workspace: { kind: "managed", id: "workspace-1" }, mode: "full" },
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("cloud worker", () => {
  test("dispatches a managed run without resume permission", async () => {
    const calls: unknown[] = [];
    const worker = new CloudWorker({
      getRun: async () => managedRun(),
      execute: async (id, options) => {
        calls.push([id, options]);
        return managedRun("succeeded");
      },
    });

    expect(await worker.handle({ runId: "run-1" })).toEqual({
      disposition: "ack",
      run: managedRun("succeeded"),
    });
    expect(calls).toEqual([["run-1", { resume: false }]]);
  });

  test("acknowledges terminal runs through the atomic claim", async () => {
    for (const status of ["succeeded", "failed", "interrupted"] as const) {
      let called = false;
      const worker = new CloudWorker({
        getRun: async () => managedRun(status),
        execute: async (_id, options) => {
          expect(options?.resume).toBe(false);
          called = true;
          return managedRun(status);
        },
      });
      expect(await worker.handle({ runId: "run-1" })).toEqual({
        disposition: "ack",
        run: managedRun(status),
      });
      expect(called).toBe(true);
    }
  });

  test("redelivery cannot grant permission to replay uncertain work", async () => {
    const options: unknown[] = [];
    const worker = new CloudWorker({
      getRun: async () => managedRun(),
      execute: async (_id, input) => {
        options.push(input);
        return managedRun("interrupted");
      },
    });

    expect((await worker.handle({ runId: "run-1" })).disposition).toBe("ack");
    expect((await worker.handle({ runId: "run-1" })).disposition).toBe("ack");
    expect(options).toEqual([{ resume: false }, { resume: false }]);
  });

  test("acknowledges a run that settles between lookup and claim", async () => {
    const worker = new CloudWorker({
      getRun: async () => managedRun(),
      execute: async (_id, options) => {
        expect(options?.resume).toBe(false);
        return managedRun("failed");
      },
    });

    expect(await worker.handle({ runId: "run-1" })).toEqual({
      disposition: "ack",
      run: managedRun("failed"),
    });
  });

  test("reports a claim collision as retryable and propagates other failures", async () => {
    const busy = new CloudWorker({
      getRun: async () => managedRun(),
      execute: async () => {
        throw new RunBusyError("run-1");
      },
    });
    expect(await busy.handle({ runId: "run-1" })).toEqual({
      disposition: "retry",
      reason: "busy",
      runId: "run-1",
    });

    const unavailable = new Error("repository unavailable");
    const broken = new CloudWorker({
      getRun: async () => {
        throw unavailable;
      },
      execute: async () => managedRun("succeeded"),
    });
    await expect(broken.handle({ runId: "run-1" })).rejects.toBe(unavailable);

    const failedExecution = new CloudWorker({
      getRun: async () => managedRun(),
      execute: async () => {
        throw unavailable;
      },
    });
    await expect(failedExecution.handle({ runId: "run-1" })).rejects.toBe(unavailable);
  });

  test("retries an already-cancelled delivery without claiming the run", async () => {
    const controller = new AbortController();
    controller.abort();
    let executions = 0;
    const worker = new CloudWorker({
      getRun: async () => managedRun(),
      execute: async () => {
        executions += 1;
        return managedRun("succeeded");
      },
    });

    expect(await worker.handle({ runId: "run-1" }, { signal: controller.signal })).toEqual({
      disposition: "retry",
      reason: "cancelled",
      runId: "run-1",
    });
    expect(executions).toBe(0);
  });

  test("retries a pending result after cancellation during initial execution", async () => {
    const worker = new CloudWorker({
      getRun: async () => managedRun(),
      execute: async (_id, options) => {
        expect(options?.resume).toBe(false);
        return managedRun("pending");
      },
    });

    expect(await worker.handle({ runId: "run-1" })).toEqual({
      disposition: "retry",
      reason: "cancelled",
      runId: "run-1",
    });
  });

  test("SQLite keeps an unlaunched command retryable after worker cancellation", async () => {
    class AbortingStore extends SqliteRunStore {
      abortAfterStart?: () => void;

      override async startAttempt(
        runId: string,
        token: string,
        nodeId: string,
        input: Json,
      ): Promise<AttemptRecord> {
        const attempt = await super.startAttempt(runId, token, nodeId, input);
        this.abortAfterStart?.();
        this.abortAfterStart = undefined;
        return attempt;
      }
    }

    const home = mkdtempSync(join(tmpdir(), "loopy-cloud-cancel-"));
    const store = new AbortingStore(home);
    try {
      let launches = 0;
      const runtime = new Runtime({
        store,
        executor: async () => {
          launches += 1;
          return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };
        },
      });
      const run = await runtime.createRun(
        {
          version: 1,
          slug: "cancelled-cloud-run",
          nodes: [{ id: "effect", kind: "command", command: { program: "tool", args: [] } }],
        },
        {},
        { workspace: { kind: "managed", id: "workspace-1" }, mode: "full" },
      );
      const controller = new AbortController();
      store.abortAfterStart = () => controller.abort();
      const worker = new CloudWorker(runtime);

      expect(await worker.handle({ runId: run.id }, { signal: controller.signal })).toEqual({
        disposition: "retry",
        reason: "cancelled",
        runId: run.id,
      });
      expect((await runtime.getRun(run.id))?.status).toBe("pending");
      expect((await runtime.getAttempts(run.id))[0]?.status).toBe("cancelled");
      expect(launches).toBe(0);

      expect((await worker.handle({ runId: run.id })).disposition).toBe("ack");
      expect((await runtime.getRun(run.id))?.status).toBe("succeeded");
      expect(launches).toBe(1);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects malformed messages, unknown runs, and local workspaces", async () => {
    const worker = new CloudWorker({
      getRun: async (id) => {
        if (id === "missing") return undefined;
        return {
          ...managedRun(),
          options: { workspace: { kind: "local", path: "/tmp/work" }, mode: "full" },
        } as RunRecord;
      },
      execute: async () => {
        throw new Error("must not execute invalid work");
      },
    });
    for (const message of [
      null,
      [],
      {},
      { runId: " " },
      { runId: "run-1", retryUncertain: true },
      { runId: "run-1", extra: true },
    ])
      await expect(worker.handle(message)).rejects.toThrow();
    await expect(worker.handle({ runId: "missing" })).rejects.toThrow("Unknown run");
    await expect(worker.handle({ runId: "run-1" })).rejects.toThrow("local workspace");
  });
});
