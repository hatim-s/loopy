import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "@loopy/contract";
import type { NodeRun } from "@loopy/core";
import { Effect, Schema } from "effect";
import { StorageError } from "../../core/src/store";
import { newRun } from "./fixture";
import { createTestStores } from "./store-fixture";

const { openTestStore, closeTestStore, closeTestStores } = createTestStores();

const cleanups: (() => void)[] = [];

afterEach(() => {
  closeTestStores();

  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loopy-durable-"));
  const file = join(root, "runs.sqlite");
  const store = openTestStore(file);
  const db = new Database(file);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

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
  const expected = await Effect.runPromise(f.store.snapshotRun("run"));
  closeTestStore(f.store);
  const reopened = openTestStore(f.file);

  expect(await Effect.runPromise(reopened.snapshotRun("run"))).toEqual(expected);
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
  const before = await Effect.runPromise(f.store.snapshotRun("run"));
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
  expect(await Effect.runPromise(f.store.snapshotRun("run"))).toEqual(before);
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

for (const malformed of [
  { ...newRun(), status: "unknown" },
  {
    ...newRun(),
    owner: { token: "x", pid: "wrong", host: "host", heartbeatAt: newRun().createdAt },
  },
  [],
]) {
  test("event reads reject malformed run records", async () => {
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
    const store = openTestStore(":memory:", () => now, { leaseMs: 2000 });

    try {
      await Effect.runPromise(
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
        await expect(Effect.runPromise(store.claim("run", "new"))).rejects.toThrow("not owned");
      } else {
        expect(await Effect.runPromise(store.claim("run", "new"))).toMatchObject({
          owner: { token: "new", pid: process.pid },
        });
        expect(await Effect.runPromise(store.heartbeat("run", "old"))).toBe(false);
      }
    } finally {
      child.kill();
      await child.exited;
    }
  });
}

test("persisted schema failures expose a corrupt reason and field diagnostics", () => {
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
