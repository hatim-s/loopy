import { expect, test } from "bun:test";
import {
  type ExecutionKey,
  type ExecutionResult,
  executionKeyString,
  type Graph,
  type Receipt,
} from "@loopy/core";
import {
  activateDurable,
  type DurableActivationOptions,
  type DurableExecutionProvider,
  DurableProviderError,
} from "@loopy/runtime/host";
import { code, loopy, parallel, random, sh, sleep, uuid, wait } from "@loopy/sdk/graph";
import { Effect } from "effect";
import { newRun } from "./fixture";
import { MemorySqlStore, runAt } from "./store-fixture";

const success: ExecutionResult = {
  kind: "succeeded",
  output: 42,
  logs: [{ message: "completed", data: null }],
};

const temporary: ExecutionResult = {
  kind: "failed",
  error: { code: "execution", message: "Temporary failure." },
  exitCode: null,
  logs: [{ message: "retry", data: null }],
};

function work() {
  return code("work", { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" });
}

function compiled(graph = loopy("test", { input: {}, run: work }).graph) {
  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  return graph;
}

class Provider implements DurableExecutionProvider {
  receipts = new Map<string, Receipt>();
  starts: { key: ExecutionKey; attempt: number }[] = [];
  lookups: number[] = [];
  result: Receipt = { kind: "started" };

  id(key: ExecutionKey, attempt: number) {
    return `${executionKeyString(key)}/${attempt}`;
  }

  lookup(key: ExecutionKey, attempt: number): Effect.Effect<Receipt, DurableProviderError> {
    return Effect.gen({ self: this }, function* () {
      this.lookups.push(attempt);

      return this.receipts.get(this.id(key, attempt)) ?? { kind: "none" as const };
    });
  }

  start(key: ExecutionKey, attempt: number): Effect.Effect<Receipt, DurableProviderError> {
    return Effect.gen({ self: this }, function* () {
      this.starts.push({ key, attempt });
      this.receipts.set(this.id(key, attempt), this.result);

      return this.result;
    });
  }

  finish(result = success) {
    const started = this.starts.at(-1);

    if (!started) {
      throw new Error("Expected a started execution.");
    }

    this.receipts.set(this.id(started.key, started.attempt), { kind: "finished", result });
  }
}

async function fixture(graph = compiled(), store = new MemorySqlStore({ leaseMs: 10_000 })) {
  let now = Date.parse(newRun().createdAt);
  const run = runAt(() => now);
  const provider = new Provider();
  await run(store.createRun(newRun()));

  const options = {
    store,
    provider,
    graph,
    runId: "run",
    token: "session-1",
    maxWork: 32,
    pollMs: 1000,
  };

  return {
    store,
    provider,
    run,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    turn: (changes: Partial<DurableActivationOptions> = {}) =>
      run(activateDurable({ ...options, at: new Date(now).toISOString(), ...changes })),
  };
}

test("persists running before start, returns promptly and renews the same session lease", async () => {
  const f = await fixture();
  const start = f.provider.start.bind(f.provider);
  f.provider.start = (key, attempt) => {
    return Effect.gen(function* () {
      expect(yield* f.store.getNodeRuns("run")).toMatchObject([
        { key, attempt, status: "running" },
      ]);

      return yield* start(key, attempt);
    }).pipe(Effect.orDie);
  };

  expect(await f.turn()).toMatchObject({
    status: "pending",
    nextWakeAt: "2026-10-16T00:00:01.000Z",
  });
  expect(await f.run(f.store.getNodeRuns("run"))).toMatchObject([{ receipt: "started" }]);
  f.advance(1000);
  await f.turn();
  expect(await f.run(f.store.getRun("run"))).toMatchObject({
    status: "running",
    owner: { token: "session-1", heartbeatAt: "2026-10-16T00:00:01.000Z" },
  });
  expect(f.provider.starts).toHaveLength(1);
});

test("reconstruction waits for the stale lease then reconciles the same external attempt", async () => {
  const f = await fixture();
  await f.turn();
  await expect(f.turn({ token: "session-2" })).rejects.toThrow("not owned by this token");
  f.advance(10_001);
  f.provider.finish();
  expect(await f.turn({ token: "session-2" })).toMatchObject({
    status: "finished",
    outcome: { status: "succeeded", output: 42 },
  });
  expect(f.provider.starts).toHaveLength(1);
  expect((await f.run(f.store.getRun("run")))?.owner).toBeUndefined();
});

test("lost start responses preserve running state and reconcile without repeating the effect", async () => {
  const f = await fixture();
  const start = f.provider.start.bind(f.provider);
  f.provider.start = (key, attempt) => {
    return Effect.gen(function* () {
      yield* start(key, attempt);
      throw new Error("Transport response lost.");
    }).pipe(Effect.orDie);
  };

  await expect(f.turn()).rejects.toThrow("Transport response lost.");
  expect(await f.run(f.store.getRun("run"))).toMatchObject({
    status: "running",
    owner: { token: "session-1" },
  });
  expect(await f.run(f.store.getNodeRuns("run"))).toMatchObject([
    { status: "running", attempt: 1, receipt: "none" },
  ]);
  expect(await f.turn()).toMatchObject({ status: "pending" });
  expect(f.provider.starts).toHaveLength(1);
  f.provider.finish();
  expect(await f.turn()).toMatchObject({ outcome: { status: "succeeded" } });
});

test("a disappeared started receipt fails uncertain without a retry", async () => {
  const f = await fixture();
  await f.turn();
  f.provider.receipts.clear();
  expect(await f.turn()).toMatchObject({ outcome: { status: "failed" } });
  expect(await f.run(f.store.getNodeRuns("run"))).toMatchObject([
    { attempt: 1, status: "failed", error: { code: "uncertain" } },
  ]);
  expect(f.provider.starts).toHaveLength(1);
});

test("controlled retries retain ownership and fence old receipts and duplicate logs", async () => {
  const f = await fixture();
  f.provider.result = { kind: "finished" as const, result: temporary };
  expect(await f.turn()).toMatchObject({
    status: "pending",
    nextWakeAt: "2026-10-16T00:00:01.000Z",
  });
  expect(await f.run(f.store.getRun("run"))).toMatchObject({
    status: "running",
    owner: { token: "session-1" },
  });
  f.advance(500);
  await f.turn();
  expect(f.provider.starts).toHaveLength(1);
  f.advance(500);
  f.provider.result = { kind: "finished" as const, result: success };
  expect(await f.turn()).toMatchObject({ outcome: { status: "succeeded" } });
  const calls = f.provider.lookups.length;
  await f.turn();
  expect(f.provider.lookups).toHaveLength(calls);
  expect(f.provider.starts.map((start) => start.attempt)).toEqual([1, 2]);
  expect((await f.run(f.store.getLogs("run"))).map((log) => log.message)).toEqual([
    "retry",
    "completed",
  ]);
});

test("an in-flight old completion cannot overwrite a newer persisted attempt", async () => {
  const f = await fixture();
  await f.turn();
  const lookup = f.provider.lookup.bind(f.provider);
  f.provider.lookup = (key, attempt) => {
    return Effect.gen(function* () {
      if (attempt === 1) {
        const previous = (yield* f.store.getNodeRuns("run"))[0];

        if (!previous) {
          throw new Error("Expected persisted attempt.");
        }

        yield* f.store.apply({
          runId: "run",
          token: "session-1",
          effects: [
            { kind: "write_node_run", nodeRun: { ...previous, attempt: 2, receipt: "none" } },
          ],
        });

        return { kind: "finished" as const, result: success };
      }

      return yield* lookup(key, attempt);
    }).pipe(Effect.orDie);
  };

  expect(await f.turn()).toMatchObject({ status: "pending" });
  expect(await f.run(f.store.getNodeRuns("run"))).toMatchObject([
    { attempt: 2, status: "running" },
  ]);
  expect(await f.run(f.store.getLogs("run"))).toEqual([]);
  f.provider.result = { kind: "finished" as const, result: success };
  expect(await f.turn()).toMatchObject({ outcome: { status: "succeeded" } });
  expect(f.provider.starts.map((start) => start.attempt)).toEqual([1, 2]);
});

test("hook waits release ownership and resume from the same persisted store", async () => {
  const graph = loopy("approval", {
    input: {},
    run: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
  }).graph;

  const f = await fixture(graph);
  expect(await f.turn()).toEqual({ status: "suspended", nextWakeAt: null, cursor: null });
  expect((await f.run(f.store.getRun("run")))?.owner).toBeUndefined();
  const hook = (await f.run(f.store.getWaits("run")))[0];

  if (!hook) {
    throw new Error("Expected hook.");
  }

  await f.run(
    f.store.resolveWait({
      token: hook.token,
      payload: true,
      at: new Date(f.now()).toISOString(),
    }),
  );
  expect(await f.turn({ token: "session-2" })).toMatchObject({
    outcome: { status: "succeeded", output: true },
  });
  expect(await f.run(f.store.getWaits("run"))).toHaveLength(1);
});

test("sleep returns its deadline and releases ownership until the next alarm", async () => {
  const f = await fixture(loopy("sleep", { input: {}, run: () => sleep("2s") }).graph);
  expect(await f.turn()).toMatchObject({
    status: "suspended",
    nextWakeAt: "2026-10-16T00:00:02.000Z",
  });
  expect((await f.run(f.store.getRun("run")))?.owner).toBeUndefined();
  f.advance(2000);
  expect(await f.turn({ token: "session-2" })).toMatchObject({ outcome: { status: "succeeded" } });
});

test("a waiting sibling does not surrender a retry's lease or concurrency slot", async () => {
  const graph = compiled(
    loopy("retry-wait", {
      input: {},
      run: () =>
        parallel({
          work,
          approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
        }),
    }).graph,
  );

  const f = await fixture(graph);
  f.provider.result = { kind: "finished" as const, result: temporary };
  expect(await f.turn()).toMatchObject({ status: "pending" });
  expect(await f.run(f.store.getRun("run"))).toMatchObject({
    status: "running",
    owner: { token: "session-1" },
  });
  f.advance(1000);
  f.provider.result = { kind: "finished" as const, result: success };
  expect(await f.turn()).toMatchObject({ status: "suspended" });
  expect((await f.run(f.store.getRun("run")))?.owner).toBeUndefined();
});

test("small budgets preserve all dispatches and entropy samples across turns", async () => {
  const graph = compiled(
    loopy("bounded", {
      input: {},
      run: () => parallel({ one: work, two: work, id: uuid, value: random }),
    }).graph,
  );

  const f = await fixture(graph);
  let result = await f.turn({ maxWork: 1 });
  expect(result).toMatchObject({ status: "pending", nextWakeAt: newRun().createdAt });
  expect(
    (await f.run(f.store.getNodeRuns("run"))).filter((node) => node.status === "running"),
  ).toHaveLength(4);

  for (let turn = 0; turn < 12 && result.status !== "finished"; turn++) {
    for (const started of f.provider.starts) {
      f.provider.receipts.set(f.provider.id(started.key, started.attempt), {
        kind: "finished",
        result: success,
      });
    }

    result = await f.turn({ maxWork: 1, cursor: result.cursor });
  }

  expect(result).toMatchObject({
    outcome: {
      status: "succeeded",
      output: { one: 42, two: 42, id: expect.any(String), value: expect.any(Number) },
    },
  });
  expect(f.provider.starts).toHaveLength(2);
  expect(await f.run(f.store.getLogs("run"))).toHaveLength(2);
});

test("failed admission consumes quota without creating a new attempt or releasing ownership", async () => {
  const graph = loopy("limited-admission", {
    input: {},
    run: () => sh(["echo", "ok"], { rateLimit: { key: "shared", limit: 1, window: "1m" } }),
  }).graph;

  const f = await fixture(graph);
  let admissions = 0;
  f.provider.start = () => {
    return Effect.gen(function* () {
      admissions++;
      throw new Error("Provider unavailable before admission.");
    }).pipe(Effect.orDie);
  };

  await expect(f.turn()).rejects.toThrow("Provider unavailable before admission.");
  f.advance(1000);
  expect(await f.turn()).toMatchObject({ status: "pending" });
  expect(await f.run(f.store.getNodeRuns("run"))).toMatchObject([
    { attempt: 1, status: "rate_limited", nextRetryAt: "2026-10-16T00:01:00.000Z" },
  ]);
  expect(await f.run(f.store.getRun("run"))).toMatchObject({
    status: "running",
    owner: { token: "session-1" },
  });
  expect(admissions).toBe(1);
  f.advance(58_999);
  await f.turn();
  expect(admissions).toBe(1);
  f.advance(1);
  await expect(f.turn()).rejects.toThrow("Provider unavailable before admission.");
  expect(admissions).toBe(2);
  expect(await f.run(f.store.getNodeRuns("run"))).toMatchObject([{ attempt: 1 }]);
});

test("rate limited dispatch retains the attempt and bounds the next alarm by the lease", async () => {
  const graph: Graph = loopy("limited", {
    input: {},
    run: () => sh(["echo", "ok"], { rateLimit: { key: "shared", limit: 1, window: "1m" } }),
  }).graph;

  const f = await fixture(graph);
  await f.run(f.store.acquireRateLimit("shared", 1, 60_000, newRun().createdAt));
  expect(await f.turn()).toMatchObject({
    status: "pending",
    nextWakeAt: "2026-10-16T00:00:02.500Z",
  });
  expect(f.provider.starts).toHaveLength(0);
  expect(await f.run(f.store.getNodeRuns("run"))).toMatchObject([
    { attempt: 1, status: "rate_limited" },
  ]);
  f.advance(60_000);
  await f.turn();
  expect(f.provider.starts.map((start) => start.attempt)).toEqual([1]);
});

test("wide started graphs poll fairly without an immediate-alarm loop", async () => {
  const f = await fixture(
    compiled(
      loopy("wide", { input: {}, run: () => parallel({ first: work, second: work, third: work }) })
        .graph,
    ),
  );

  let result = await f.turn({ maxWork: 1 });

  for (let turn = 0; turn < 2; turn++) {
    result = await f.turn({ maxWork: 1, cursor: result.cursor });
  }

  expect(f.provider.starts).toHaveLength(3);
  expect(result).toMatchObject({ status: "pending", nextWakeAt: "2026-10-16T00:00:01.000Z" });
  f.provider.finish();

  for (let turn = 0; turn < 3; turn++) {
    result = await f.turn({ maxWork: 1, cursor: result.cursor });
    expect(result.nextWakeAt).toBe("2026-10-16T00:00:01.000Z");
  }

  expect(
    (await f.run(f.store.getNodeRuns("run"))).find(
      (node) => node.key.nodeId === f.provider.starts.at(-1)?.key.nodeId,
    ),
  ).toMatchObject({ status: "succeeded", attempt: 1 });
  expect(f.provider.starts).toHaveLength(3);
});

test("interrupted suspension releases ownership when the same session resumes", async () => {
  class InterruptedReleaseStore extends MemorySqlStore {
    interrupted = true;

    override release(runId: string, token: string) {
      const release = super.release(runId, token);

      return Effect.gen({ self: this }, function* () {
        if (this.interrupted) {
          this.interrupted = false;
          throw new Error("Release interrupted.");
        }

        return yield* release;
      });
    }
  }

  const graph = loopy("wait", {
    input: {},
    run: () => wait("approval", { payload: { kind: "value", type: "boolean" } }),
  }).graph;

  const f = await fixture(graph, new InterruptedReleaseStore());
  await expect(f.turn()).rejects.toThrow("Release interrupted.");
  expect(await f.turn()).toMatchObject({ status: "suspended" });
  expect((await f.run(f.store.getRun("run")))?.owner).toBeUndefined();
  expect(await f.run(f.store.getWaits("run"))).toHaveLength(1);
});

test("a persistence failure prevents dispatch and retains ownership for reconciliation", async () => {
  class UnavailableStore extends MemorySqlStore {
    override apply() {
      return Effect.gen(function* () {
        throw new Error("Storage unavailable.");
      });
    }
  }

  const f = await fixture(compiled(), new UnavailableStore());
  await expect(f.turn()).rejects.toThrow("Storage unavailable.");
  expect(f.provider.starts).toHaveLength(0);
  expect(await f.run(f.store.getRun("run"))).toMatchObject({
    status: "running",
    owner: { token: "session-1" },
  });
});

test("provider transport failure remains typed and never becomes absent receipt", async () => {
  const f = await fixture();

  const failure = new DurableProviderError({
    operation: "lookup",
    reason: "transport",
    message: "Provider unavailable",
    cause: "fixture",
  });

  f.provider.lookup = () => Effect.fail(failure);

  const exit = await Effect.runPromiseExit(
    activateDurable({
      store: f.store,
      provider: f.provider,
      graph: compiled(),
      runId: "run",
      token: "session-1",
      at: newRun().createdAt,
      maxWork: 32,
      pollMs: 1000,
    }),
  );

  expect(exit._tag).toBe("Failure");

  if (exit._tag === "Failure") {
    expect(
      exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error === failure),
    ).toBe(true);
  }

  expect(f.provider.starts).toHaveLength(0);
  expect(await f.run(f.store.getRun("run"))).toMatchObject({
    status: "running",
    owner: { token: "session-1" },
  });
});
