import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeBoundary, nodeIdSchema, runSnapshotViewSchema } from "@loopy/contract";
import { type Executor, type StoreEffect } from "@loopy/core";
import { code, finally_, loopy, parallel, sleep, uuid, wait } from "@loopy/sdk/graph";
import { Deferred, Effect, Exit, Schema, Scope } from "effect";
import { FakeExecutor, newRun } from "../../core/_tests_/fixtures/run";
import { activate } from "../src/host";
import { makeLocalService, Registry } from "../src/local";
import { makeSqliteRunStore } from "../src/store";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { MemorySqlStore, runAt } from "./fixtures/stores";
import { fixtureScope } from "./fixtures/test-scope";

async function fixture() {
  const home = qualityTestRoot("wait-host");
  let now = Date.parse("2026-10-20T00:00:00.000Z");

  const clock = { now: () => now };
  // The service, store and host share this clock.
  const run = runAt(clock.now);

  const file = join(home, "runs.sqlite");
  // Its own scope, so a test can close the store and reopen the file.
  const scope = Scope.forkUnsafe(fixtureScope());

  const store = await Effect.runPromise(
    makeSqliteRunStore(file).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const service = makeLocalService({ home, store });

  const graph = loopy("approval", {
    input: {},
    run: () =>
      wait("approve", {
        timeout: "1s",
        payload: { kind: "record", fields: { approved: "boolean" } },
      }),
  });

  const registry = await Effect.runPromise(Registry.make(home, home));
  mkdirSync(dirname(registry.graphPath("a".repeat(64))), { recursive: true });
  writeFileSync(registry.graphPath("a".repeat(64)), JSON.stringify(graph));

  return {
    home,
    run,
    scope,
    registry,
    clock,
    store,
    service,
    graph,
    file,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("approval suspends without executing, a named signal wakes once, and restart continues", async () => {
  const f = await fixture();
  await Effect.runPromise(
    f.store.createRun({ ...newRun(), slug: "approval", input: {}, workspace: f.home }),
  );
  const executor = new FakeExecutor();
  expect(await f.run(activate({ ...f, executor, runId: "run" }))).toEqual({ status: "suspended" });
  expect(executor.calls).toEqual([]);
  expect((await Effect.runPromise(f.store.getRun("run")))?.owner).toBeUndefined();
  expect(
    await Effect.runPromise(f.store.dueRuns(new Date(f.clock.now()).toISOString())),
  ).toHaveLength(0);
  const view = (await f.run(f.service.runSnapshot("run"))).run;
  expect(view.waitingOn?.hook).toBe("approve");

  const send = (approved: boolean | string) =>
    f.run(f.service.resolveNamedHook("run", "approve", { approved }));

  await expect(send("bad")).rejects.toMatchObject({ code: "bad_request" });
  expect((await send(true)).waitingOn).toBeNull();
  await expect(send(false)).rejects.toMatchObject({ code: "unknown_hook" });
  Schema.decodeUnknownSync(runSnapshotViewSchema)(await f.run(f.service.runSnapshot("run")));
  await Effect.runPromise(Scope.close(f.scope, Exit.void));
  const reopenScope = fixtureScope();

  const reopened = await Effect.runPromise(
    makeSqliteRunStore(f.file).pipe(Effect.provideService(Scope.Scope, reopenScope)),
  );

  expect(
    await f.run(activate({ store: reopened, graph: f.graph, executor, runId: "run" })),
  ).toEqual({ status: "succeeded", output: { approved: true } });
  expect(executor.calls).toEqual([]);
});

test("an opaque token resolves and timeout rehydration preserves the original deadline", async () => {
  const f = await fixture();
  await Effect.runPromise(f.store.createRun({ ...newRun(), input: {}, workspace: f.home }));
  const executor = new FakeExecutor();
  await f.run(activate({ ...f, executor, runId: "run" }));
  const original = await Effect.runPromise(f.store.getRun("run"));
  f.advance(500);
  await f.run(activate({ ...f, executor, runId: "run" }));
  expect(await Effect.runPromise(f.store.getRun("run"))).toMatchObject({
    wakeAt: original?.status === "suspended" ? original.wakeAt : "missing",
  });
  const hook = (await Effect.runPromise(f.store.getWaits("run")))[0];

  if (!hook) {
    throw new Error("Missing hook.");
  }

  await f.run(f.service.resolveHook(hook.token, { approved: false }));
  expect(await f.run(activate({ ...f, executor, runId: "run" }))).toEqual({
    status: "succeeded",
    output: { approved: false },
  });
});

test("wait deadline fails on resume and sleep resumes once from its persisted deadline", async () => {
  const f = await fixture();
  const executor = new FakeExecutor();
  await Effect.runPromise(f.store.createRun({ ...newRun(), input: {} }));
  await f.run(activate({ ...f, executor, runId: "run" }));
  f.advance(1000);
  expect(await f.run(activate({ ...f, executor, runId: "run" }))).toEqual({
    status: "failed",
    error: "Wait timed out.",
  });
  expect(await Effect.runPromise(f.store.getWaits("run"))).toMatchObject([
    { expiredAt: new Date(f.clock.now()).toISOString() },
  ]);

  const graph = loopy("sleeping", {
    input: {},
    run: () => {
      sleep("1s");

      return "awake";
    },
  });

  await Effect.runPromise(f.store.createRun({ ...newRun(), id: "sleep", input: {} }));
  expect(await f.run(activate({ ...f, graph, executor, runId: "sleep" }))).toEqual({
    status: "suspended",
  });
  const slept = await Effect.runPromise(f.store.getRun("sleep"));
  f.advance(500);
  await f.run(activate({ ...f, graph, executor, runId: "sleep" }));
  expect(await Effect.runPromise(f.store.getRun("sleep"))).toMatchObject({
    wakeAt: slept?.status === "suspended" ? slept.wakeAt : "missing",
  });
  f.advance(500);
  expect(await f.run(activate({ ...f, graph, executor, runId: "sleep" }))).toEqual({
    status: "succeeded",
    output: "awake",
  });
  expect(executor.calls).toEqual([]);
});

test("a signal accepted while a parallel execution runs survives its completion", async () => {
  const f = await fixture();

  const graph = loopy("both", {
    input: {},
    run: () =>
      parallel({
        approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
        work: () =>
          code("work", { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" }),
      }),
  });

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  await Effect.runPromise(f.store.createRun({ ...newRun(), input: {} }));

  const executor: Executor = {
    lookup: () => {
      return Effect.gen(function* () {
        return { kind: "none" as const };
      });
    },
    execute: () => {
      return Effect.gen(function* () {
        const hook = (yield* f.store.getWaits("run"))[0];

        if (!hook) {
          throw new Error("Wait was not persisted before dispatch.");
        }

        expect(
          (yield* f.store.resolveWait({
            token: hook.token,
            payload: true,
            at: new Date(f.clock.now()).toISOString(),
          })).kind,
        ).toBe("resolved");

        return { kind: "succeeded" as const, output: 42, logs: [] };
      }).pipe(Effect.orDie);
    },
  };

  expect(await f.run(activate({ ...f, graph, executor, runId: "run" }))).toEqual({
    status: "succeeded",
    output: { approval: true, work: 42 },
  });
});

test("parallel dispatches run concurrently and sampling completes without an executor", async () => {
  const store = new MemorySqlStore();
  let active = 0;
  let peak = 0;

  const graph = loopy("concurrent", {
    input: {},
    run: () =>
      parallel({
        a: () => code("a", { in: {}, out: { kind: "value", type: "number" }, module: "./a.ts" }),
        b: () => code("b", { in: {}, out: { kind: "value", type: "number" }, module: "./b.ts" }),
        entropy: () => uuid(),
      }),
  });

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  const executor: Executor = {
    lookup: () => {
      return Effect.gen(function* () {
        return { kind: "none" as const };
      });
    },
    execute: () => {
      return Effect.gen(function* () {
        active++;
        peak = Math.max(peak, active);
        yield* Effect.sleep(5);
        active--;

        return { kind: "succeeded" as const, output: 1, logs: [] };
      }).pipe(Effect.orDie);
    },
  };

  await Effect.runPromise(store.createRun(newRun()));
  expect((await Effect.runPromise(activate({ store, executor, graph, runId: "run" }))).status).toBe(
    "succeeded",
  );
  expect(peak).toBe(2);
});

test("cancelling a suspended approval expires its token and cancels its pending node", async () => {
  const f = await fixture();
  await Effect.runPromise(
    f.store.createRun({ ...newRun(), revision: "a".repeat(64), input: {}, workspace: f.home }),
  );
  await f.run(activate({ ...f, executor: new FakeExecutor(), runId: "run" }));
  const wait = (await Effect.runPromise(f.store.getWaits("run")))[0];

  if (!wait) {
    throw new Error("Missing wait.");
  }

  expect((await f.run(f.service.cancelRun("run"))).status).toBe("cancelled");
  expect(await Effect.runPromise(f.store.getNodeRuns("run"))).toMatchObject([
    { status: "cancelled" },
  ]);
  expect((await Effect.runPromise(f.store.getWaits("run")))[0]?.expiredAt).toBeDefined();
  await expect(f.run(f.service.resolveHook(wait.token, { approved: true }))).rejects.toMatchObject({
    code: "unknown_hook",
  });
});

test("cancellation refuses suspended finally graphs without changing their wait", async () => {
  const f = await fixture();

  const graph = loopy("cleanup", {
    input: {},
    run: () =>
      finally_(
        () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
        () => null,
      ),
  });

  writeFileSync(f.registry.graphPath("a".repeat(64)), JSON.stringify(graph));
  await Effect.runPromise(
    f.store.createRun({ ...newRun(), revision: "a".repeat(64), input: {}, workspace: f.home }),
  );
  await f.run(activate({ ...f, graph, executor: new FakeExecutor(), runId: "run" }));
  const before = await Effect.runPromise(f.store.dashboardSnapshot("run"));
  await expect(f.run(f.service.cancelRun("run"))).rejects.toMatchObject({
    code: "not_claimable",
    message:
      "This run requires finally cleanup. Cancellation with cleanup is not available; resume the run instead.",
  });
  expect(await Effect.runPromise(f.store.dashboardSnapshot("run"))).toEqual(before);
});

test("an indefinite signal advances its branch before a long sibling completes", async () => {
  const f = await fixture();

  const graph = loopy("prompt", {
    input: {},
    run: () =>
      parallel({
        approval: () => {
          const decision = wait("approve", { payload: { kind: "value", type: "boolean" } });

          return code("after", {
            in: { decision },
            out: { kind: "value", type: "number" },
            module: "./after.ts",
          });
        },
        long: () =>
          code("long", { in: {}, out: { kind: "value", type: "number" }, module: "./long.ts" }),
      }),
  });

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = node.label === "long" ? "b".repeat(64) : "a".repeat(64);
    }
  }

  await Effect.runPromise(f.store.createRun({ ...newRun(), input: {} }));
  const gate = Deferred.makeUnsafe<void>();

  const executor: Executor = {
    lookup: () => {
      return Effect.gen(function* () {
        return { kind: "none" as const };
      });
    },
    execute: (...args) => {
      return Effect.gen(function* () {
        const [, , spec] = args;

        if (spec.kind !== "code") {
          throw new Error("Expected code.");
        }

        if (spec.bundleHash === "a".repeat(64)) {
          expect(spec.input).toEqual({ decision: true });
          yield* Deferred.succeed(gate, undefined);

          return { kind: "succeeded" as const, output: 1, logs: [] };
        }

        const hook = (yield* f.store.getWaits("run"))[0];

        if (!hook) {
          throw new Error("Missing hook.");
        }

        yield* f.store.resolveWait({
          token: hook.token,
          payload: true,
          at: new Date(f.clock.now()).toISOString(),
        });

        yield* Deferred.await(gate);

        return { kind: "succeeded" as const, output: 2, logs: [] };
      }).pipe(Effect.orDie);
    },
  };

  expect(await f.run(activate({ ...f, graph, executor, runId: "run" }))).toEqual({
    status: "succeeded",
    output: { approval: 1, long: 2 },
  });
}, 1000);

test("a named signal skips a timed-out wait the reducer has not expired yet", async () => {
  const f = await fixture();
  await f.run(f.store.createRun({ ...newRun(), slug: "approval", input: {}, workspace: f.home }));
  await f.run(f.store.claim("run", "owner"));
  const at = new Date(f.clock.now()).toISOString();

  const waiting = (nodeId: string, wakeAt: string | null): StoreEffect[] => {
    const key = { runId: "run", nodeId: decodeBoundary(nodeIdSchema)(nodeId), scope: [] };

    return [
      {
        kind: "write_node_run",
        nodeRun: {
          key,
          attempt: 1,
          maxAttempts: 1,
          startedAt: at,
          status: "waiting",
          wakeAt,
          receipt: "none",
        },
      },
      {
        kind: "register_wait",
        executionKey: key,
        name: "approve",
        payload: { kind: "record", fields: { approved: "boolean" } },
        at,
      },
    ];
  };

  const deadline = new Date(f.clock.now() + 1000).toISOString();
  await f.run(
    f.store.apply({
      runId: "run",
      token: "owner",
      effects: [
        ...waiting("0:timed", deadline),
        ...waiting("0:open", null),
        { kind: "suspend_run", wakeAt: deadline },
      ],
    }),
  );
  await f.run(f.store.release("run", "owner"));
  const send = () => f.run(f.service.resolveNamedHook("run", "approve", { approved: true }));
  await expect(send()).rejects.toMatchObject({ code: "bad_request" });
  f.advance(1000);
  await send();

  const waits = await f.run(f.store.getWaits("run"));
  expect(waits.map((wait) => [wait.executionKey.nodeId, wait.resolvedAt ?? null])).toEqual([
    ["0:timed", null],
    ["0:open", new Date(f.clock.now()).toISOString()],
  ]);
  await expect(send()).rejects.toMatchObject({ code: "unknown_hook" });
});
