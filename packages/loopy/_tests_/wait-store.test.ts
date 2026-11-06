import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Schema, Scope } from "effect";
import { nodeIdSchema } from "../src/contract";
import { type NodeRun, type Store } from "../src/core";
import { MemoryStore, makeSqliteRunStore } from "../src/store";
import { SCHEMA, WAIT_SCHEMA } from "../src/store/sqlite/store-schema";
import { newRun } from "./fixture";

const scopes: Scope.Closeable[] = [];

function fixtureScope() {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);

  return scope;
}

const homes: string[] = [];

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const at = "2026-10-20T00:00:00.000Z";

const deadline = "2026-10-20T00:00:01.000Z";

async function sqlite() {
  const home = mkdtempSync(join(tmpdir(), "loopy-wait-"));
  homes.push(home);
  const file = join(home, "runs.sqlite");

  const store = await Effect.runPromise(
    makeSqliteRunStore(file, () => Date.parse(at)).pipe(
      Effect.provideService(Scope.Scope, fixtureScope()),
    ),
  );

  return { store, file };
}

function waiting(index = 0): NodeRun {
  return {
    key: {
      runId: "run",
      nodeId: Schema.decodeUnknownSync(nodeIdSchema)("approval"),
      scope: [{ nodeId: Schema.decodeUnknownSync(nodeIdSchema)("map"), index }],
    },
    attempt: 1,
    maxAttempts: 1,
    receipt: "none",
    startedAt: at,
    status: "waiting",
    wakeAt: deadline,
  };
}

async function prepare(store: Store) {
  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.claim("run", "owner"));
  await Effect.runPromise(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [
        { kind: "write_node_run", nodeRun: waiting() },
        {
          kind: "register_wait",
          executionKey: waiting().key,
          name: "approve",
          payload: { kind: "record", fields: { approved: "boolean" } },
          at,
        },
        { kind: "suspend_run", wakeAt: deadline, at },
      ],
    }),
  );
}

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind} signal validates payload, resolves once, and commits node/hook/wake together`, async () => {
    const store =
      kind === "memory" ? new MemoryStore(() => Date.parse(at)) : (await sqlite()).store;

    await prepare(store);
    const wait = (await Effect.runPromise(store.getWaits("run")))[0];

    if (!wait) {
      throw new Error("Missing wait.");
    }

    const cursor = await Effect.runPromise(store.eventCursor());
    expect(
      await Effect.runPromise(
        store.resolveWait({ token: wait.token, payload: { approved: "yes" }, at }),
      ),
    ).toMatchObject({ kind: "rejected", code: "bad_request" });
    expect(await Effect.runPromise(store.eventCursor())).toEqual(cursor);
    expect(
      await Effect.runPromise(
        store.resolveWait({
          token: wait.token,
          payload: { approved: true, oversized: "x".repeat(1024 * 1024) },
          at,
        }),
      ),
    ).toMatchObject({
      kind: "rejected",
      code: "bad_request",
      message: "Wait payload exceeds the 1 MiB inline limit.",
    });
    expect(await Effect.runPromise(store.eventCursor())).toEqual(cursor);

    const results = await Promise.all([
      Effect.runPromise(store.resolveWait({ token: wait.token, payload: { approved: true }, at })),
      Effect.runPromise(store.resolveWait({ token: wait.token, payload: { approved: false }, at })),
    ]);

    expect(results.map((result) => result.kind)).toEqual(["resolved", "rejected"]);
    await Effect.runPromise(store.release("run", "owner"));
    expect(await Effect.runPromise(store.getRun("run"))).toMatchObject({
      status: "suspended",
      wakeAt: at,
    });
    expect((await Effect.runPromise(store.getRun("run")))?.owner).toBeUndefined();
    expect(await Effect.runPromise(store.dueRuns(at))).toHaveLength(1);
    expect(await Effect.runPromise(store.getNodeRuns("run"))).toMatchObject([
      { status: "succeeded", output: { approved: true } },
    ]);
    expect(await Effect.runPromise(store.getWaits("run"))).toMatchObject([
      { resolvedAt: at, payload: { approved: true } },
    ]);
    const events = await Effect.runPromise(store.events(cursor.cursor, 20));
    const resolved = events.find((event) => event.entity === "hook" && event.kind === "resolved");
    expect(
      events.filter((event) => event.txn === resolved?.txn).map((event) => event.entity),
    ).toEqual(["hook", "node", "run"]);
  });
  test(`${kind} deadline wins at equality, timeout expires hook, and cancellation rejects signals`, async () => {
    const store =
      kind === "memory" ? new MemoryStore(() => Date.parse(at)) : (await sqlite()).store;

    await prepare(store);
    const wait = (await Effect.runPromise(store.getWaits("run")))[0];

    if (!wait) {
      throw new Error("Missing wait.");
    }

    expect(
      await Effect.runPromise(
        store.resolveWait({ token: wait.token, payload: { approved: true }, at: deadline }),
      ),
    ).toMatchObject({ kind: "rejected", code: "unknown_hook" });
    await Effect.runPromise(store.release("run", "owner"));
    await Effect.runPromise(store.claim("run", "timeout"));
    await Effect.runPromise(
      store.apply({
        runId: "run",
        token: "timeout",
        effects: [
          {
            kind: "write_node_run",
            nodeRun: {
              key: waiting().key,
              attempt: 1,
              maxAttempts: 1,
              receipt: "none",
              startedAt: at,
              status: "failed",
              endedAt: deadline,
              error: { code: "execution", message: "Wait timed out." },
            },
          },
        ],
      }),
    );
    expect(await Effect.runPromise(store.getWaits("run"))).toMatchObject([{ expiredAt: deadline }]);
    await Effect.runPromise(store.finishRun("run", "timeout", { status: "cancelled" }));
    expect(
      await Effect.runPromise(
        store.resolveWait({ token: wait.token, payload: { approved: true }, at }),
      ),
    ).toMatchObject({ kind: "rejected", code: "unknown_hook" });
  });
  test(`${kind} wait registration is idempotent and scoped, and failed batches roll back`, async () => {
    const store =
      kind === "memory" ? new MemoryStore(() => Date.parse(at)) : (await sqlite()).store;

    await prepare(store);
    await Effect.runPromise(store.release("run", "owner"));
    await Effect.runPromise(store.claim("run", "owner2"));

    const register = {
      kind: "register_wait",
      executionKey: waiting().key,
      name: "approve",
      payload: { kind: "value", type: "boolean" },
      at,
    } as const;

    await Effect.runPromise(store.apply({ runId: "run", token: "owner2", effects: [register] }));
    expect(await Effect.runPromise(store.getWaits("run"))).toHaveLength(1);

    const rejected = await Effect.runPromiseExit(
      store.apply({
        runId: "run",
        token: "owner2",
        effects: [
          { kind: "write_node_run", nodeRun: waiting(1) },
          { ...register, executionKey: waiting(1).key },
          { ...register, executionKey: { ...waiting().key, runId: "other" } },
        ],
      }),
    );

    expect(Exit.isFailure(rejected)).toBe(true);

    if (!Exit.isFailure(rejected)) {
      throw new Error("Expected a rejected cross-run wait batch.");
    }

    expect(Cause.hasDies(rejected.cause)).toBe(true);
    expect(Cause.squash(rejected.cause)).toMatchObject({ message: "Wait belongs to another run." });
    expect(await Effect.runPromise(store.getWaits("run"))).toHaveLength(1);
    expect(await Effect.runPromise(store.getNodeRuns("run"))).toHaveLength(1);
    await Effect.runPromise(
      store.apply({
        runId: "run",
        token: "owner2",
        effects: [
          { kind: "write_node_run", nodeRun: waiting(1) },
          { ...register, executionKey: waiting(1).key },
        ],
      }),
    );
    const waits = await Effect.runPromise(store.getWaits("run"));
    expect(waits).toHaveLength(2);
    expect(waits[0]?.token).not.toEqual(waits[1]?.token);
    await Effect.runPromise(store.finishRun("run", "owner2", { status: "cancelled" }));
    expect(
      (await Effect.runPromise(store.getWaits("run"))).every((wait) => wait.expiredAt === at),
    ).toBe(true);
  });
}

test("sqlite reopen retains accepted payload and wake without a second resolution", async () => {
  const { store, file } = await sqlite();
  await prepare(store);
  await Effect.runPromise(store.release("run", "owner"));
  const wait = (await Effect.runPromise(store.getWaits("run")))[0];

  if (!wait) {
    throw new Error("Missing wait.");
  }

  expect(
    (
      await Effect.runPromise(
        store.resolveWait({ token: wait.token, payload: { approved: true }, at }),
      )
    ).kind,
  ).toBe("resolved");
  await Effect.runPromise(store.close());

  const reopened = await Effect.runPromise(
    makeSqliteRunStore(file).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

  expect(await Effect.runPromise(reopened.getNodeRuns("run"))).toMatchObject([
    { status: "succeeded", output: { approved: true } },
  ]);
  expect(await Effect.runPromise(reopened.dueRuns(at))).toHaveLength(1);
  expect(
    (
      await Effect.runPromise(
        reopened.resolveWait({ token: wait.token, payload: { approved: false }, at }),
      )
    ).kind,
  ).toBe("rejected");
});

test("schema 13 upgrade preserves records and legacy schema rejection never resets data", async () => {
  const home = mkdtempSync(join(tmpdir(), "loopy-schema13-"));
  homes.push(home);
  const file = join(home, "runs.sqlite");
  const epoch = crypto.randomUUID();
  const db = new Database(file);
  db.exec(SCHEMA.replace(WAIT_SCHEMA, ""));
  db.query("INSERT INTO meta VALUES ('epoch',?)").run(epoch);
  db.query(
    "INSERT INTO runs(id,slug,revision,workspace,input_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("run", "test", "bundle", "/workspace", "{}", "queued", at, at);
  db.exec("PRAGMA user_version=13");
  db.close();

  const upgraded = await Effect.runPromise(
    makeSqliteRunStore(file).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

  expect(await Effect.runPromise(upgraded.getRun("run"))).toMatchObject({ id: "run" });
  expect(await Effect.runPromise(upgraded.epoch())).toBe(epoch);
  expect(await Effect.runPromise(upgraded.getWaits("run"))).toEqual([]);
  const legacy = join(homes[0] ?? tmpdir(), "legacy.sqlite");
  const old = new Database(legacy);
  old.exec(
    "CREATE TABLE sacred (value TEXT); INSERT INTO sacred VALUES ('retain'); PRAGMA user_version=11",
  );
  old.close();
  await expect(
    Effect.runPromise(
      makeSqliteRunStore(legacy).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
    ),
  ).rejects.toMatchObject({
    _tag: "StorageError",
    cause: expect.objectContaining({
      message: expect.stringContaining("Database schema 11 cannot be opened"),
    }),
  });
  const read = new Database(legacy, { readonly: true });
  expect(read.query("SELECT value FROM sacred").get()).toEqual({ value: "retain" });
  expect(read.query("PRAGMA user_version").get()).toEqual({ user_version: 11 });
  read.close();
});
