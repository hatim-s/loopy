import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "@loopy/contract";
import { type NodeRun, StorageError } from "@loopy/core";
import { Effect, Schema } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { runAt } from "./fixtures/clock";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { closeTestStore, openTestStore } from "./fixtures/stores";
import { onCleanup } from "./fixtures/test-scope";

function fixture() {
  const file = join(qualityTestRoot("durable"), "runs.sqlite");
  const store = openTestStore(file);
  const db = new Database(file);
  onCleanup(() => db.close());

  return { store, db, file };
}

function node(): NodeRun {
  return {
    key: { runId: "run", nodeId: Schema.decodeUnknownSync(nodeIdSchema)("0:code"), scope: [] },
    attempt: 1,
    maxAttempts: 3,
    startedAt: newRun().createdAt,
    status: "succeeded",
    endedAt: newRun().createdAt,
    output: { count: 42 },
    receipt: "finished",
  };
}

test("node runs, logs, event revisions and rate windows survive reopening", async () => {
  const f = fixture();
  await Effect.runPromise(f.store.createRun(newRun()));
  await Effect.runPromise(f.store.claim("run", "owner"));
  const record = node();
  await Effect.runPromise(
    f.store.apply({
      runId: "run",
      token: "owner",
      effects: [
        { kind: "write_node_run", nodeRun: record },
        {
          kind: "write_log",
          executionKey: record.key,
          attempt: 1,
          log: { message: "saved", data: { nested: [true] } },
          at: newRun().createdAt,
        },
      ],
    }),
  );
  await Effect.runPromise(f.store.acquireRateLimit("shared", 1, 60_000, newRun().createdAt));
  const expected = await Effect.runPromise(f.store.dashboardSnapshot("run"));
  const logs = await Effect.runPromise(f.store.getLogs("run"));
  closeTestStore(f.store);
  const reopened = openTestStore(f.file);

  expect(await Effect.runPromise(reopened.dashboardSnapshot("run"))).toEqual(expected);
  expect(await Effect.runPromise(reopened.getLogs("run"))).toEqual(logs);
  expect(await Effect.runPromise(reopened.getNodeRuns("run"))).toEqual([record]);
  expect(
    await Effect.runPromise(reopened.acquireRateLimit("shared", 1, 60_000, newRun().createdAt)),
  ).toEqual({
    ok: false,
    retryAt: "2026-10-16T00:01:00.000Z",
  });
  expect(await Effect.runPromise(reopened.events(0, 100))).toMatchObject([
    { entity: "run", record: { revision: "bundle" } },
    { entity: "run" },
    { entity: "node" },
    { entity: "log" },
  ]);
});

test("outbox insertion failure rolls back nodes, logs and outcomes without publishing", async () => {
  const f = fixture();
  await Effect.runPromise(f.store.createRun(newRun()));
  await Effect.runPromise(f.store.claim("run", "owner"));
  const before = await Effect.runPromise(f.store.dashboardSnapshot("run"));
  let deliveries = 0;
  f.store.subscribe(() => {
    deliveries++;
  });
  f.db.exec(
    `CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.entity='run' BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`,
  );
  const record = node();
  await expect(
    Effect.runPromise(
      f.store.apply({
        runId: "run",
        token: "owner",
        effects: [
          { kind: "write_node_run", nodeRun: record },
          {
            kind: "write_log",
            executionKey: record.key,
            attempt: 1,
            log: { message: "rollback", data: null },
            at: newRun().createdAt,
          },
          {
            kind: "finish_run",
            outcome: { status: "succeeded", output: 42 },
            at: newRun().createdAt,
          },
        ],
      }),
    ),
  ).rejects.toThrow("outbox unavailable");
  expect(await Effect.runPromise(f.store.dashboardSnapshot("run"))).toEqual(before);
  expect(await Effect.runPromise(f.store.getLogs("run"))).toEqual([]);
  expect(deliveries).toBe(0);
  f.db.exec("DROP TRIGGER reject_event");
  await Effect.runPromise(
    f.store.apply({
      runId: "run",
      token: "owner",
      effects: [{ kind: "write_node_run", nodeRun: record }],
    }),
  );
  expect(deliveries).toBe(1);
});

for (const [name, malformed] of [
  [
    "an owner pid of the wrong type",
    {
      ...newRun(),
      owner: { token: "x", pid: "wrong", host: "host", heartbeatAt: newRun().createdAt },
    },
  ],
  ["a non-object record", []],
] as const) {
  test(`event reads reject a run record with ${name}`, async () => {
    const f = fixture();
    await Effect.runPromise(f.store.createRun(newRun()));
    f.db.query("UPDATE events SET record=?").run(JSON.stringify(malformed));
    await expect(Effect.runPromise(f.store.events(0, 10))).rejects.toBeInstanceOf(StorageError);
  });
}

test("event reads reject malformed node attempts and invalid JSON", async () => {
  const f = fixture();
  await Effect.runPromise(f.store.createRun(newRun()));
  await Effect.runPromise(f.store.claim("run", "owner"));
  await Effect.runPromise(
    f.store.apply({
      runId: "run",
      token: "owner",
      effects: [{ kind: "write_node_run", nodeRun: node() }],
    }),
  );
  f.db
    .query("UPDATE events SET record=? WHERE entity='node'")
    .run(JSON.stringify({ ...node(), attempt: 1.5 }));
  await expect(Effect.runPromise(f.store.events(0, 10))).rejects.toBeInstanceOf(StorageError);
  f.db.query("UPDATE events SET record=?").run("{");
  await expect(Effect.runPromise(f.store.events(0, 10))).rejects.toBeInstanceOf(StorageError);
});

for (const alive of [true, false]) {
  test(`${alive ? "live" : "dead"} local PID determines lease takeover`, async () => {
    const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });

    if (!alive) {
      child.kill("SIGKILL");
      await child.exited;
    }

    let now = Date.parse(newRun().createdAt);
    const run = runAt(() => now);
    const store = openTestStore(":memory:", { leaseMs: 2000 });

    try {
      await run(
        store.createRun({
          ...newRun(),
          status: "running",
          owner: {
            token: "old",
            pid: child.pid,
            host: hostname(),
            heartbeatAt: newRun().createdAt,
          },
        }),
      );
      expect(await Effect.runPromise(store.dueRuns(newRun().createdAt))).toEqual([]);
      now += 2001;
      expect((await Effect.runPromise(store.dueRuns(new Date(now).toISOString()))).length).toBe(
        alive ? 0 : 1,
      );

      if (alive) {
        await expect(run(store.claim("run", "new"))).rejects.toThrow("not owned");
      } else {
        expect(await run(store.claim("run", "new"))).toMatchObject({
          owner: { token: "new", pid: process.pid },
        });
        expect(await run(store.heartbeat("run", "old"))).toBe(false);
      }
    } finally {
      child.kill();
      await child.exited;
    }
  });
}

test("event reads reject an unknown run status as corrupt with field diagnostics", () => {
  const f = fixture();
  Effect.runSync(f.store.createRun(newRun()));
  f.db.query("UPDATE events SET record=?").run(JSON.stringify({ ...newRun(), status: "unknown" }));
  const result = Effect.runSync(Effect.result(f.store.events(0, 10)));
  expect(result._tag).toBe("Failure");

  if (result._tag === "Failure") {
    expect(result.failure.reason).toBe("corrupt");
    expect(result.failure.message).toContain("Storage operation 'events' failed");
    expect(result.failure.message).toContain("events");
    expect(result.failure.message).toContain("status");
  }
});
