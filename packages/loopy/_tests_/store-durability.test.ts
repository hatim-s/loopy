import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "../src/contract/index.js";
import type { NodeRun } from "../src/core/index.js";
import { SqliteRunStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loopy-durable-"));
  const file = join(root, "runs.sqlite");
  const store = new SqliteRunStore(file);
  const db = new Database(file);
  cleanups.push(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { store, db, file };
}

function node(): NodeRun {
  return {
    key: { runId: "run", nodeId: nodeIdSchema.parse("0:code"), scope: [] },
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
  await f.store.createRun(newRun());
  await f.store.claim("run", "owner");
  const record = node();
  await f.store.apply({
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
  });
  await f.store.acquireRateLimit({ key: "shared", limit: 1, window: "1m" }, newRun().createdAt);
  const expected = await f.store.snapshotRun("run");
  f.store.close();
  const reopened = new SqliteRunStore(f.file);

  try {
    expect(await reopened.snapshotRun("run")).toEqual(expected);
    expect(await reopened.getNodeRuns("run")).toEqual([record]);
    expect(
      await reopened.acquireRateLimit(
        { key: "shared", limit: 1, window: "1m" },
        newRun().createdAt,
      ),
    ).toEqual({
      ok: false,
      retryAt: "2026-10-16T00:01:00.000Z",
    });
    expect(await reopened.events(0, 100)).toMatchObject([
      { entity: "run", record: { revision: "bundle" } },
      { entity: "run" },
      { entity: "node" },
      { entity: "log" },
    ]);
  } finally {
    reopened.close();
  }
});

test("outbox insertion failure rolls back nodes, logs and outcomes without publishing", async () => {
  const f = fixture();
  await f.store.createRun(newRun());
  await f.store.claim("run", "owner");
  const before = await f.store.snapshotRun("run");
  let deliveries = 0;
  f.store.subscribe(() => {
    deliveries++;
  });
  f.db.exec(
    `CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.entity='run' BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`,
  );
  const record = node();
  await expect(
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
  ).rejects.toThrow("outbox unavailable");
  expect(await f.store.snapshotRun("run")).toEqual(before);
  expect(deliveries).toBe(0);
  f.db.exec("DROP TRIGGER reject_event");
  await f.store.apply({
    runId: "run",
    token: "owner",
    effects: [{ kind: "write_node_run", nodeRun: record }],
  });
  expect(deliveries).toBe(1);
});

test("event reads reject invalid JSON", async () => {
  const f = fixture();
  await f.store.createRun(newRun());
  f.db.query("UPDATE events SET record=?").run("{");
  await expect(f.store.events(0, 10)).rejects.toBeInstanceOf(SyntaxError);
});

for (const alive of [true, false]) {
  test(`${alive ? "live" : "dead"} local PID determines lease takeover`, async () => {
    const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });

    if (!alive) {
      child.kill("SIGKILL");
      await child.exited;
    }

    let now = Date.parse(newRun().createdAt);
    const store = new SqliteRunStore(":memory:", () => now, { leaseMs: 2000 });

    try {
      await store.createRun({
        ...newRun(),
        status: "running",
        owner: { token: "old", pid: child.pid, host: hostname(), heartbeatAt: newRun().createdAt },
      });
      expect(await store.dueRuns(newRun().createdAt)).toEqual([]);
      now += 2001;
      expect((await store.dueRuns(new Date(now).toISOString())).length).toBe(alive ? 0 : 1);

      if (alive) {
        await expect(store.claim("run", "new")).rejects.toMatchObject({ code: "owned_elsewhere" });
      } else {
        expect(await store.claim("run", "new")).toMatchObject({
          owner: { token: "new", pid: process.pid },
        });
        expect(await store.heartbeat("run", "old")).toBe(false);
      }
    } finally {
      child.kill();
      await child.exited;
      store.close();
    }
  });
}
