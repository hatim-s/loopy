import { expect, test } from "bun:test";
import {
  type ExecutionReceipt,
  type ExecutionReceiptStore,
  type LinuxExecutionProvider,
  RemoteLinuxExecutor,
} from "../src/cloud/executor/controller.js";
import type {
  ExecutionKey,
  ExecutionObservation,
  StartCommand,
} from "../src/runtime/remote-executor.js";

class Store implements ExecutionReceiptStore {
  rows = new Map<string, ExecutionReceipt>();
  id(key: ExecutionKey) {
    return JSON.stringify([key.tenantId, key.runId, key.attemptId]);
  }
  async read(key: ExecutionKey) {
    return this.rows.get(this.id(key));
  }
  async compareAndSwap(key: ExecutionKey, revision: number | undefined, next: ExecutionReceipt) {
    if (this.rows.get(this.id(key))?.revision !== revision) return false;
    this.rows.set(this.id(key), structuredClone(next));
    return true;
  }
}
const request: StartCommand = {
  key: { tenantId: "t", runId: "r", attemptId: "a" },
  fingerprint: "sha256-command",
  command: { program: "bash", args: ["-c", "bun run task.ts"], maxOutputBytes: 20 },
  workspace: { workspaceId: "w", generation: "1" },
  deadline: "2030-01-01T00:00:00Z",
};
function setup(overrides: Partial<LinuxExecutionProvider> = {}) {
  const store = new Store();
  let starts = 0;
  const running = { state: "running", jobId: "job", workspace: request.workspace } as const;
  const provider: LinuxExecutionProvider = {
    workspace: async () => "available",
    start: async () => {
      starts++;
      return running;
    },
    inspect: async () => running,
    cancel: async () => ({ state: "cancelled-before-start" }),
    ...overrides,
  };
  return { store, executor: new RemoteLinuxExecutor(store, provider), starts: () => starts };
}
test("concurrent starts reserve one launch and reject changed fingerprints", async () => {
  const { executor, starts } = setup();
  await Promise.all([executor.start(request), executor.start(request)]);
  expect(starts()).toBe(1);
  await expect(executor.start({ ...request, fingerprint: "changed" })).rejects.toThrow("conflict");
});
test("lost acknowledgement reconciles with inspect and never repeats launch", async () => {
  let launches = 0;
  const { executor } = setup({
    start: async () => {
      launches++;
      throw Error("response lost");
    },
  });
  expect((await executor.start(request)).state).toBe("unknown");
  await executor.start(request);
  expect(launches).toBe(1);
  expect((await executor.inspect(request.key)).state).toBe("running");
});
test("provider absence after ambiguous launch stays unknown", async () => {
  const { executor } = setup({
    start: async () => {
      throw Error("lost");
    },
    inspect: async () => ({ state: "not-started" }),
  });
  await executor.start(request);
  expect((await executor.inspect(request.key)).state).toBe("unknown");
});
test("cancel before launch prevents any provider start", async () => {
  const { executor, starts } = setup();
  await executor.cancel(request.key);
  expect((await executor.start(request)).state).toBe("cancelled-before-start");
  expect(starts()).toBe(0);
});
test("cancel during pending launch is reconciled again after acknowledgement", async () => {
  let acknowledge!: (value: ExecutionObservation & { state: "running" }) => void;
  let launched!: () => void;
  const begun = new Promise<void>((resolve) => {
    launched = resolve;
  });
  let cancellations = 0;
  const { executor } = setup({
    start: async () => {
      launched();
      return await new Promise((resolve) => {
        acknowledge = resolve;
      });
    },
    cancel: async () => {
      cancellations++;
      return { state: "unknown", reason: "kill pending" };
    },
  });
  const pending = executor.start(request);
  await begun;
  await executor.cancel(request.key);
  acknowledge({ state: "running", jobId: "job", workspace: request.workspace });
  expect((await pending).state).toBe("unknown");
  expect(cancellations).toBe(2);
});
test("missing workspace blocks launch and changed generation blocks observation", async () => {
  const lost = setup({ workspace: async () => "lost" });
  expect(await lost.executor.start(request)).toEqual({
    state: "unknown",
    reason: "workspace-lost: expected generation unavailable",
  });
  expect(lost.starts()).toBe(0);
  const changed = setup({
    inspect: async () => ({
      state: "running",
      jobId: "job",
      workspace: { workspaceId: "w", generation: "2" },
    }),
  });
  await changed.executor.start(request);
  expect((await changed.executor.inspect(request.key)).state).toBe("unknown");
});
test("oversized output is rejected and tenant keys stay separate", async () => {
  const { executor, starts, store } = setup({
    inspect: async () => ({
      state: "completed",
      jobId: "job",
      workspace: request.workspace,
      output: { stdout: "x".repeat(21), stderr: "", exitCode: 0, durationMs: 1 },
    }),
  });
  await executor.start(request);
  expect((await executor.inspect(request.key)).state).toBe("unknown");
  await executor.start({ ...request, key: { ...request.key, tenantId: "other" } });
  expect(starts()).toBe(2);
  expect(JSON.stringify([...store.rows.values()])).not.toContain("bun run");
});
test("expired deadline prevents launch", async () => {
  const { executor, starts } = setup();
  expect((await executor.start({ ...request, deadline: "2000-01-01T00:00:00Z" })).state).toBe(
    "cancelled-before-start",
  );
  expect(starts()).toBe(0);
});
test("terminal completion survives stale cancellation results", async () => {
  let calls = 0;
  const { executor } = setup({
    inspect: async () => ({
      state: "completed",
      jobId: "job",
      workspace: request.workspace,
      output: { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 },
    }),
    cancel: async () => {
      calls++;
      return { state: "unknown", reason: "lost" };
    },
  });
  await executor.start(request);
  expect((await executor.inspect(request.key)).state).toBe("completed");
  expect((await executor.cancel(request.key)).state).toBe("completed");
  expect(calls).toBe(0);
});
test("CAS storage failure never launches a command", async () => {
  let starts = 0;
  const store: ExecutionReceiptStore = {
    read: async () => undefined,
    compareAndSwap: async () => {
      throw Error("database unavailable");
    },
  };
  const provider: LinuxExecutionProvider = {
    workspace: async () => "available",
    start: async () => {
      starts++;
      return { state: "unknown", reason: "unused" };
    },
    inspect: async () => ({ state: "not-started" }),
    cancel: async () => ({ state: "not-started" }),
  };
  await expect(new RemoteLinuxExecutor(store, provider).start(request)).rejects.toThrow(
    "database unavailable",
  );
  expect(starts).toBe(0);
});
