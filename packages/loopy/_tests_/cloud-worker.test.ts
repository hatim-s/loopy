import { describe, expect, test } from "bun:test";
import { CloudWorker } from "../src/cloud/worker.js";
import type { RunRecord } from "../src/core/model.js";
import { RunBusyError } from "../src/runtime/errors.js";

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
