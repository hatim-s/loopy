import { expect, test } from "bun:test";
import type { AttemptRecord, Json, RunEvent, RunRecord, RunStatus } from "../src/core/model.js";
import { CommandExecutionError } from "../src/runtime/errors.js";
import type { RunRepository } from "../src/runtime/repository.js";
import { Runtime } from "../src/runtime/runtime.js";

const workflow = {
  version: 1 as const,
  slug: "portable",
  nodes: [{ id: "effect", kind: "command" as const, command: { program: "tool", args: [] } }],
};
const runOptions = {
  workspace: { kind: "managed" as const, id: "workspace-1" },
  mode: "full" as const,
};
const output = { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryRepository implements RunRepository {
  run?: RunRecord;
  owner?: string;
  attempts: AttemptRecord[] = [];
  events: RunEvent[] = [];
  beforeStart?: () => Promise<void>;
  beforeFinishAttempt?: () => Promise<void>;
  afterFinishAttempt?: () => Promise<void>;
  beforeHeartbeat?: () => Promise<void>;
  heartbeatCalls = 0;
  heartbeatConcurrent = 0;
  maxHeartbeatConcurrent = 0;
  finishAttemptCalls = 0;
  releases = 0;

  async createRun(run: RunRecord): Promise<void> {
    this.run = run;
  }
  async getRun(): Promise<RunRecord | undefined> {
    return this.run;
  }
  async listRuns(): Promise<RunRecord[]> {
    return this.run ? [this.run] : [];
  }
  async getAttempts(): Promise<AttemptRecord[]> {
    return [...this.attempts];
  }
  async getEvents(): Promise<RunEvent[]> {
    return this.events;
  }
  async claim(runId: string, token: string, options?: { resume?: boolean }): Promise<RunRecord> {
    if (!this.run || this.run.id !== runId) throw new Error("Unknown run");
    if (
      this.run.status === "succeeded" ||
      (options?.resume === false &&
        (this.run.status === "failed" || this.run.status === "interrupted"))
    )
      return this.run;
    if (this.owner) throw new Error("Busy");
    this.owner = token;
    this.run = { ...this.run, status: "running" };
    return this.run;
  }
  async heartbeat(_runId: string, token: string): Promise<boolean> {
    this.heartbeatCalls += 1;
    this.heartbeatConcurrent += 1;
    this.maxHeartbeatConcurrent = Math.max(this.maxHeartbeatConcurrent, this.heartbeatConcurrent);
    try {
      await this.beforeHeartbeat?.();
      return this.owner === token;
    } finally {
      this.heartbeatConcurrent -= 1;
    }
  }
  async startAttempt(
    runId: string,
    token: string,
    nodeId: string,
    input: Json,
  ): Promise<AttemptRecord> {
    await this.beforeStart?.();
    if (this.owner !== token) throw new Error("Lost owner");
    const attempt: AttemptRecord = {
      id: `attempt-${this.attempts.length + 1}`,
      runId,
      nodeId,
      number: this.attempts.length + 1,
      input,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.attempts.push(attempt);
    return attempt;
  }
  async finishAttempt(
    _runId: string,
    token: string,
    attemptId: string,
    status: Exclude<AttemptRecord["status"], "running">,
    output?: Json,
    error?: string,
  ): Promise<AttemptRecord> {
    this.finishAttemptCalls += 1;
    await this.beforeFinishAttempt?.();
    if (this.owner !== token) throw new Error("Lost owner");
    const index = this.attempts.findIndex((attempt) => attempt.id === attemptId);
    const prior = this.attempts[index];
    if (!prior) throw new Error("Unknown attempt");
    const next = { ...prior, status, output, error, endedAt: new Date().toISOString() };
    this.attempts[index] = next;
    await this.afterFinishAttempt?.();
    return next;
  }
  async finishRun(
    _runId: string,
    token: string,
    status: RunStatus,
    error?: string,
  ): Promise<RunRecord> {
    if (this.owner !== token || !this.run) throw new Error("Lost owner");
    this.run = { ...this.run, status, error };
    return this.run;
  }
  async release(_runId: string, token: string): Promise<void> {
    this.releases += 1;
    if (this.owner === token) this.owner = undefined;
  }
}

test("waits for a delayed attempt write and checks ownership before command launch", async () => {
  const store = new MemoryRepository();
  const gate = deferred<void>();
  const entered = deferred<void>();
  store.beforeStart = () => {
    entered.resolve();
    return gate.promise;
  };
  const aborter = new AbortController();
  let launches = 0;
  const runtime = new Runtime({
    store,
    executor: async () => {
      launches += 1;
      return output;
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);
  const execution = runtime.execute(run.id, { signal: aborter.signal });
  await entered.promise;
  aborter.abort();
  gate.resolve();
  expect((await execution).status).toBe("interrupted");
  expect(launches).toBe(0);
  expect(store.attempts[0]?.status).toBe("cancelled");
  expect(store.releases).toBe(1);
});

test("an initial delivery cancelled after attempt creation remains pending for redelivery", async () => {
  const store = new MemoryRepository();
  const gate = deferred<void>();
  const entered = deferred<void>();
  store.beforeStart = () => {
    store.beforeStart = undefined;
    entered.resolve();
    return gate.promise;
  };
  const aborter = new AbortController();
  let launches = 0;
  const runtime = new Runtime({
    store,
    executor: async () => {
      launches += 1;
      return output;
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);
  const first = runtime.execute(run.id, { resume: false, signal: aborter.signal });
  await entered.promise;
  aborter.abort();
  gate.resolve();

  expect((await first).status).toBe("pending");
  expect(store.attempts[0]?.status).toBe("cancelled");
  expect(launches).toBe(0);
  expect((await runtime.execute(run.id, { resume: false })).status).toBe("succeeded");
  expect(launches).toBe(1);
  expect(store.attempts.map((attempt) => attempt.status)).toEqual(["cancelled", "succeeded"]);
});

test("an executor that proves it never started can retry after worker cancellation", async () => {
  const store = new MemoryRepository();
  const aborter = new AbortController();
  let calls = 0;
  const runtime = new Runtime({
    store,
    executor: async () => {
      calls += 1;
      if (calls === 1) {
        aborter.abort();
        throw new CommandExecutionError("Worker cancelled", output, false);
      }
      return output;
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);

  expect((await runtime.execute(run.id, { resume: false, signal: aborter.signal })).status).toBe(
    "pending",
  );
  expect(store.attempts[0]?.status).toBe("cancelled");
  expect((await runtime.execute(run.id, { resume: false })).status).toBe("succeeded");
  expect(calls).toBe(2);
});

test("worker cancellation cannot redeliver a command that may have started", async () => {
  const store = new MemoryRepository();
  const aborter = new AbortController();
  let calls = 0;
  const runtime = new Runtime({
    store,
    executor: async () => {
      calls += 1;
      aborter.abort();
      throw new CommandExecutionError("Worker cancelled", output, true);
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);

  expect((await runtime.execute(run.id, { resume: false, signal: aborter.signal })).status).toBe(
    "interrupted",
  );
  expect(store.attempts[0]?.status).toBe("uncertain");
  expect((await runtime.execute(run.id, { resume: false })).status).toBe("interrupted");
  expect(calls).toBe(1);
});

test("a duplicate delivery cannot resume a terminal failure", async () => {
  const store = new MemoryRepository();
  let launches = 0;
  const runtime = new Runtime({
    store,
    executor: async () => {
      launches += 1;
      return { ...output, exitCode: 2 };
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);
  expect((await runtime.execute(run.id, { resume: false })).status).toBe("failed");
  expect((await runtime.execute(run.id, { resume: false })).status).toBe("failed");
  expect(launches).toBe(1);
  expect(store.attempts).toHaveLength(1);
});

test("marks an unknown executor failure uncertain and supplies stable command IDs", async () => {
  const store = new MemoryRepository();
  let context: { runId: string; nodeId: string; attemptId: string; ownerToken: string } | undefined;
  const runtime = new Runtime({
    store,
    executor: async (_command, options) => {
      context = options;
      throw new Error("Transport disconnected");
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);
  expect((await runtime.execute(run.id)).status).toBe("interrupted");
  expect(store.attempts[0]?.status).toBe("uncertain");
  expect(context).toMatchObject({ runId: run.id, nodeId: "effect", attemptId: "attempt-1" });
  expect(context?.ownerToken).toBeTruthy();
});

test("records a command that never started as failed", async () => {
  const store = new MemoryRepository();
  const runtime = new Runtime({
    store,
    executor: async () => {
      throw new CommandExecutionError("Program missing", output, false);
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);
  expect((await runtime.execute(run.id)).status).toBe("failed");
  expect(store.attempts[0]?.status).toBe("failed");
});

test("propagates a delayed storage commit failure without recording a second result", async () => {
  const store = new MemoryRepository();
  const gate = deferred<void>();
  store.beforeFinishAttempt = async () => {
    await gate.promise;
    throw new Error("Commit unavailable");
  };
  const runtime = new Runtime({ store, executor: async () => output });
  const run = await runtime.createRun(workflow, {}, runOptions);
  const execution = runtime.execute(run.id);
  await Bun.sleep(0);
  gate.resolve();
  await expect(execution).rejects.toThrow("Commit unavailable");
  expect(store.finishAttemptCalls).toBe(1);
  expect(store.attempts[0]?.status).toBe("running");
  expect(store.releases).toBe(1);
});

test("a lost failed-attempt acknowledgement cannot replay a command on initial redelivery", async () => {
  const store = new MemoryRepository();
  let launches = 0;
  store.afterFinishAttempt = async () => {
    store.afterFinishAttempt = undefined;
    throw new Error("Commit acknowledgement lost");
  };
  const runtime = new Runtime({
    store,
    executor: async () => {
      launches += 1;
      return { ...output, exitCode: 2 };
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);
  await expect(runtime.execute(run.id, { resume: false })).rejects.toThrow(
    "Commit acknowledgement lost",
  );
  expect(store.attempts[0]?.status).toBe("failed");
  expect(store.run?.status).toBe("running");

  expect((await runtime.execute(run.id, { resume: false })).status).toBe("failed");
  expect(launches).toBe(1);
  expect(store.attempts).toHaveLength(1);
});

test("heartbeats are single flight and finish before release", async () => {
  const store = new MemoryRepository();
  const heartbeatGate = deferred<void>();
  const entered = deferred<void>();
  store.beforeHeartbeat = () => {
    entered.resolve();
    return heartbeatGate.promise;
  };
  const runtime = new Runtime({ store, executor: async () => output, heartbeatIntervalMs: 1 });
  const run = await runtime.createRun(workflow, {}, runOptions);
  const execution = runtime.execute(run.id);
  await entered.promise;
  await Bun.sleep(10);
  expect(store.heartbeatCalls).toBe(1);
  expect(store.maxHeartbeatConcurrent).toBe(1);
  heartbeatGate.resolve();
  expect((await execution).status).toBe("succeeded");
  expect(store.heartbeatConcurrent).toBe(0);
  expect(store.releases).toBe(1);
});

test("a lost lease after attempt creation prevents command launch", async () => {
  const store = new MemoryRepository();
  store.beforeHeartbeat = async () => {
    store.owner = undefined;
  };
  let launches = 0;
  const runtime = new Runtime({
    store,
    executor: async () => {
      launches += 1;
      return output;
    },
  });
  const run = await runtime.createRun(workflow, {}, runOptions);
  await expect(runtime.execute(run.id)).rejects.toThrow("Run ownership lost");
  expect(launches).toBe(0);
  expect(store.attempts[0]?.status).toBe("running");
  expect(store.releases).toBe(1);
});
