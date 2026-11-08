import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "@loopy/contract";
import type { NodeRun, Store } from "@loopy/core";
import { activate } from "@loopy/runtime/host";
import { makeSqliteRunStore } from "@loopy/runtime/store";
import { loopy, wait } from "@loopy/sdk/graph";
import { Effect, Exit, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { FakeExecutor, newRun } from "./fixture";
import { runAt } from "./store-fixture";

const scopes: Scope.Closeable[] = [];

function fixtureScope() {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);

  return scope;
}

const homes: string[] = [];

const at = "2026-10-20T00:00:00.000Z";

const future = "2026-10-20T00:01:00.000Z";

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) {
    await run(Scope.close(scope, Exit.void));
  }

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const run = runAt(() => Date.parse(at));

async function createStore(): Promise<Store> {
  const home = mkdtempSync(join(tmpdir(), "loopy-wait-race-"));
  homes.push(home);

  const store = await run(
    makeSqliteRunStore(join(home, "runs.sqlite")).pipe(
      Effect.provideService(Scope.Scope, fixtureScope()),
    ),
  );

  return store;
}

const graph = loopy("race", {
  input: {},
  run: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
});

async function prepare(store: Store) {
  await run(store.createRun({ ...newRun(), input: {} }));
  expect(
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at));

        return yield* activate({ store, graph, executor: new FakeExecutor(), runId: "run" });
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  ).toEqual({ status: "suspended" });
  const hook = (await run(store.getWaits("run")))[0];

  if (!hook) {
    throw new Error("Expected a persisted wait.");
  }

  return hook;
}

for (const wakeAt of [null, future]) {
  test(`stale ${wakeAt === null ? "indefinite" : "finite"} suspension preserves a signal across running-node writes`, async () => {
    const store = await createStore();
    const hook = await prepare(store);
    await run(store.claim("run", "owner"));
    expect((await run(store.resolveWait({ token: hook.token, payload: true, at }))).kind).toBe(
      "resolved",
    );

    const sibling: NodeRun = {
      key: { runId: "run", nodeId: Schema.decodeUnknownSync(nodeIdSchema)("sibling"), scope: [] },
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: at,
      receipt: "none",
    };

    await run(
      store.apply({
        runId: "run",
        token: "owner",
        effects: [
          { kind: "write_node_run", nodeRun: sibling },
          {
            kind: "write_node_run",
            nodeRun: { ...sibling, status: "succeeded", output: null, endedAt: at },
          },
          { kind: "suspend_run", wakeAt, at },
        ],
      }),
    );
    await run(store.release("run", "owner"));
    expect(await run(store.getRun("run"))).toMatchObject({
      status: "suspended",
      wakeAt: at,
    });
    expect(await run(store.nextWakeAt())).toBe(at);
    expect((await run(store.dueRuns(at))).map((run) => run.id)).toEqual(["run"]);
    expect(
      (await run(store.getWaits("run"))).find((wait) => wait.token === hook.token),
    ).toMatchObject({
      resolvedAt: at,
      payload: true,
    });
    expect((await run(store.resolveWait({ token: hook.token, payload: false, at }))).kind).toBe(
      "rejected",
    );
  });
}

test(`stale suspension keeps an earlier deadline instead of postponing it`, async () => {
  const store = await createStore();
  await prepare(store);
  await run(store.claim("run", "owner"));
  await run(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [
        { kind: "schedule_retry", at: future },
        { kind: "suspend_run", wakeAt: at, at },
      ],
    }),
  );
  await run(store.release("run", "owner"));
  expect(await run(store.nextWakeAt())).toBe(at);
});

test(`signal between activation reload and suspension remains due and completes`, async () => {
  const store = await createStore();
  const hook = await prepare(store);
  const apply = store.apply.bind(store);
  let injected = false;
  store.apply = (batch) =>
    Effect.gen(function* () {
      if (!injected && batch.effects.some((effect) => effect.kind === "suspend_run")) {
        injected = true;
        expect((yield* store.resolveWait({ token: hook.token, payload: true, at })).kind).toBe(
          "resolved",
        );
      }

      yield* apply(batch);
    });

  expect(
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at));

        return yield* activate({ store, graph, executor: new FakeExecutor(), runId: "run" });
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  ).toEqual({ status: "suspended" });
  expect(injected).toBe(true);
  expect((await run(store.getNodeRuns("run")))[0]?.status).toBe("succeeded");
  expect(await run(store.nextWakeAt())).toBe(at);
  expect((await run(store.dueRuns(at))).map((run) => run.id)).toEqual(["run"]);
  expect(
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at));

        return yield* activate({ store, graph, executor: new FakeExecutor(), runId: "run" });
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  ).toEqual({ status: "succeeded", output: true });
});
