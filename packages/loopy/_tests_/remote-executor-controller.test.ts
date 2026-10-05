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
  readonly maxOutputBytes = 1_048_576;
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
    maxOutputBytes: 1_048_576,
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

const completed = {
  state: "completed",
  jobId: "job",
  workspace: request.workspace,
  output: { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 },
} as const;

test.each(["inspect", "cancel"] as const)(
  "%s provider failure returns completion persisted by a concurrent inspection",
  async (operation) => {
    let entered!: () => void;
    const pendingProvider = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reject!: (reason: Error) => void;
    const failedResponse = new Promise<ExecutionObservation>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    let complete!: (value: ExecutionObservation) => void;
    let inspecting!: () => void;
    const completionPending = new Promise<void>((resolve) => {
      inspecting = resolve;
    });
    let firstInspect = true;
    const { executor } = setup({
      inspect: async () => {
        if (firstInspect) {
          firstInspect = false;
          inspecting();
          return await new Promise<ExecutionObservation>((resolve) => {
            complete = resolve;
          });
        }
        entered();
        return await failedResponse;
      },
      cancel: async () => {
        entered();
        return await failedResponse;
      },
    });
    await executor.start(request);
    const concurrent = executor.inspect(request.key);
    await completionPending;
    const pending = executor[operation](request.key);
    await pendingProvider;
    complete(completed);
    expect(await concurrent).toEqual(completed);
    reject(Error("provider response lost"));
    expect(await pending).toEqual(completed);
  },
);

test.each(["cancel", "deadline"] as const)(
  "%s keeps reconciling cancellation after workspace loss",
  async (cause) => {
    let lost = false;
    let cancellations = 0;
    let now = Date.parse("2029-01-01T00:00:00Z");
    const { store } = setup();
    const executor = new RemoteLinuxExecutor(
      store,
      {
        workspace: async () => (lost ? "lost" : "available"),
        start: async () => ({ state: "running", jobId: "job", workspace: request.workspace }),
        inspect: async () => {
          throw Error("cancel should reconcile this attempt");
        },
        cancel: async () => {
          cancellations++;
          return { state: "unknown", reason: "kill pending" };
        },
      },
      () => now,
    );
    await executor.start(request);
    if (cause === "cancel") await executor.cancel(request.key);
    else now = Date.parse(request.deadline);
    lost = true;
    expect((await executor.inspect(request.key)).state).toBe("unknown");
    expect((await executor.inspect(request.key)).state).toBe("unknown");
    expect(cancellations).toBe(cause === "cancel" ? 3 : 2);
    expect((await store.read(request.key))?.cancelRequested).toBe(true);
  },
);

for (const operation of ["start", "inspect", "cancel"] as const) {
  test.each(["read", "compareAndSwap"] as const)(
    `${operation} propagates %s failure after provider acknowledgement`,
    async (storeOperation) => {
      let fail = false;
      const acknowledge = async () => {
        fail = true;
        return completed;
      };
      const { executor, store } = setup({ [operation]: acknowledge });
      if (operation !== "start") await executor.start(request);
      if (storeOperation === "read") {
        const original = store.read.bind(store);
        store.read = async (key) => {
          if (fail) throw Error("receipt read unavailable");
          return await original(key);
        };
      } else {
        const original = store.compareAndSwap.bind(store);
        store.compareAndSwap = async (key, revision, next) => {
          if (fail) throw Error("receipt CAS unavailable");
          return await original(key, revision, next);
        };
      }
      await expect(
        operation === "start" ? executor.start(request) : executor[operation](request.key),
      ).rejects.toThrow(storeOperation === "read" ? "receipt read" : "receipt CAS");
    },
  );
}

test("start propagates receipt read failure after workspace validation", async () => {
  let fail = false;
  const { executor, store, starts } = setup({
    workspace: async () => {
      fail = true;
      return "available";
    },
  });
  const read = store.read.bind(store);
  store.read = async (key) => {
    if (fail) throw Error("receipt read unavailable");
    return await read(key);
  };
  await expect(executor.start(request)).rejects.toThrow("receipt read");
  expect(starts()).toBe(0);
});

test("output limit counts isolated surrogates in each stream separately", async () => {
  const { executor } = setup({
    inspect: async () => ({
      ...completed,
      output: { ...completed.output, stdout: "\ud800", stderr: "\udc00" },
    }),
  });
  await executor.start({ ...request, command: { ...request.command, maxOutputBytes: 4 } });
  expect(await executor.inspect(request.key)).toEqual({
    state: "unknown",
    reason: "Provider exceeded output limit; result rejected",
  });
});

test("expired deadline propagates completed receipt persistence failure without cancelling", async () => {
  let now = Date.parse(request.deadline) - 1000;
  let cancellations = 0;
  const store = new Store();
  const executor = new RemoteLinuxExecutor(
    store,
    {
      async workspace() {
        return "available";
      },
      async start() {
        return { state: "running", jobId: "job", workspace: request.workspace };
      },
      async inspect() {
        return completed;
      },
      async cancel() {
        cancellations++;
        return { state: "cancelled-before-start" };
      },
    },
    () => now,
  );
  await executor.start(request);
  now = Date.parse(request.deadline) + 1000;
  store.compareAndSwap = async () => {
    throw new Error("receipt CAS unavailable");
  };
  await expect(executor.inspect(request.key)).rejects.toThrow("receipt CAS unavailable");
  expect(cancellations).toBe(0);
});

test.each([undefined, 0, Number.NaN, -1, 1.5])(
  "untyped receipt store capacity %s fails closed before any receipt or launch",
  (maxOutputBytes) => {
    let writes = 0;
    let launches = 0;
    const store = {
      maxOutputBytes,
      async read() {
        return undefined;
      },
      async compareAndSwap() {
        writes++;
        return true;
      },
    };
    const provider: LinuxExecutionProvider = {
      async workspace() {
        return "available";
      },
      async start() {
        launches++;
        return completed;
      },
      async inspect() {
        return completed;
      },
      async cancel() {
        return { state: "cancelled-before-start" };
      },
    };
    expect(() => new RemoteLinuxExecutor(store as ExecutionReceiptStore, provider)).toThrow(
      "capacity",
    );
    expect(writes).toBe(0);
    expect(launches).toBe(0);
  },
);
