import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LogRecord, StepRecord } from "../src/core/index.js";
import { SqliteRunStore } from "../src/local/index.js";
import { newRun } from "./fixture.js";
import { storeContract } from "./store-contract.js";

function runningStep(): Extract<StepRecord, { status: "running" }> {
  return {
    runId: "run",
    seq: 1,
    key: "step-1",
    kind: "function",
    input: null,
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    startedAt: newRun().createdAt,
  };
}

const clock = () => Date.parse("2026-10-16T00:00:00.000Z");

storeContract("SqliteRunStore", (options) => new SqliteRunStore(":memory:", options?.now, options));

test("schema version mismatch recreates tables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-engine-schema-"));
  const file = join(directory, "runs.sqlite");

  try {
    const original = new SqliteRunStore(file, clock);
    await original.createRun(newRun());
    await original.claim("run", "owner");
    await original.putStep("run", "owner", {
      runId: "run",
      seq: 1,
      key: "sleep",
      kind: "sleep",
      input: null,
      status: "sleeping",
      wakeAt: newRun().createdAt,
      attempt: 1,
      maxAttempts: 1,
      startedAt: newRun().createdAt,
    });
    original.close();
    const database = new Database(file);
    database.exec("CREATE TABLE obsolete (value TEXT); PRAGMA user_version=4");
    database.close();
    const store = new SqliteRunStore(file, clock);

    try {
      expect(await store.listRuns()).toEqual([]);
      expect(await store.getSteps("run")).toEqual([]);
      const inspection = new Database(file);

      try {
        expect(inspection.query("PRAGMA user_version").get()).toEqual({ user_version: 11 });
        expect(
          inspection.query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
        ).toEqual(
          [
            "events",
            "hooks",
            "logs",
            "meta",
            "rate_limits",
            "runs",
            "schedules",
            "sqlite_sequence",
            "steps",
          ].map((name) => ({ name })),
        );
      } finally {
        inspection.close();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a reopened file store returns the same runs steps and logs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-engine-reopen-"));
  const file = join(directory, "runs.sqlite");
  const run = newRun();

  const base = {
    runId: run.id,
    key: "test",
    kind: "function",
    input: null,
    attempt: 1,
    maxAttempts: 3,
    startedAt: run.createdAt,
  } satisfies Omit<StepRecord, "seq" | "status">;

  const steps: StepRecord[] = [
    { ...base, seq: 1, status: "running" },
    { ...base, seq: 2, status: "succeeded", output: null, endedAt: run.createdAt, finishOrder: 1 },
    {
      ...base,
      seq: 3,
      status: "failed",
      error: "Failed. Retry it.",
      endedAt: run.createdAt,
      finishOrder: 2,
    },
    {
      ...base,
      seq: 4,
      status: "retrying",
      error: "Failed. Retry it.",
      endedAt: run.createdAt,
      nextRetryAt: run.createdAt,
    },
    { ...base, seq: 5, status: "sleeping", wakeAt: run.createdAt },
  ];

  const logs: LogRecord[] = [
    {
      runId: run.id,
      seq: 1,
      position: { kind: "workflow", afterStep: 3, afterFinish: 2, index: 1 },
      level: "info",
      message: "hello",
      data: null,
      at: run.createdAt,
    },
    {
      runId: run.id,
      seq: 2,
      position: { kind: "step", seq: 3, attempt: 2, index: 2 },
      level: "warn",
      message: "waiting",
      at: run.createdAt,
    },
  ];

  try {
    const original = new SqliteRunStore(file, clock);
    let storedRun = run;

    try {
      await original.createRun(run);
      storedRun = await original.claim(run.id, "owner");

      for (const step of steps) {
        await original.putStep(run.id, "owner", step);
      }

      for (const log of logs) {
        await original.appendLog(run.id, "owner", log);
      }
    } finally {
      original.close();
    }

    const reopened = new SqliteRunStore(file, clock);

    try {
      expect(await reopened.getRun(run.id)).toEqual(storedRun);
      expect(await reopened.listRuns()).toEqual([storedRun]);
      expect(await reopened.getSteps(run.id)).toEqual(steps);
      expect(await reopened.getLogs(run.id)).toEqual(logs);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("due runs sort chronologically when creation timestamps use different offsets", async () => {
  const store = new SqliteRunStore(":memory:", clock);

  try {
    await store.createRun({ ...newRun(), id: "later", createdAt: "2026-10-16T01:00:00.000Z" });
    await store.createRun({ ...newRun(), id: "earlier", createdAt: "2026-10-16T05:00:00+05:00" });
    expect((await store.dueRuns(newRun().createdAt)).map((run) => run.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect((await store.getRun("earlier"))?.createdAt).toBe(newRun().createdAt);
  } finally {
    store.close();
  }
});

test("timestamp writes use UTC and due comparisons accept offsets", async () => {
  const store = new SqliteRunStore(":memory:", clock);
  const offset = "2026-10-16T05:00:00+05:00";
  const utc = newRun().createdAt;

  try {
    await store.createRun({
      ...newRun(),
      status: "suspended",
      wakeAt: offset,
      createdAt: offset,
      updatedAt: offset,
      owner: { token: "owner", pid: 1, host: "test", heartbeatAt: offset },
    });
    expect(await store.getRun("run")).toMatchObject({
      wakeAt: utc,
      createdAt: utc,
      updatedAt: utc,
      owner: { heartbeatAt: utc },
    });

    const step = {
      runId: "run",
      seq: 1,
      key: "test",
      kind: "function",
      input: null,
      attempt: 1,
      maxAttempts: 2,
      startedAt: offset,
    } satisfies Omit<StepRecord, "status">;

    await store.putStep("run", "owner", {
      ...step,
      status: "retrying",
      error: "Failed. Retry it.",
      endedAt: offset,
      nextRetryAt: offset,
    });
    expect(await store.getSteps("run")).toMatchObject([
      { startedAt: utc, endedAt: utc, nextRetryAt: utc },
    ]);
    await store.putStep("run", "owner", { ...step, status: "sleeping", wakeAt: offset });
    expect(await store.getSteps("run")).toMatchObject([{ startedAt: utc, wakeAt: utc }]);
    await store.appendLog("run", "owner", {
      runId: "run",
      seq: 1,
      position: { kind: "step", seq: 1, attempt: 1, index: 1 },
      level: "info",
      message: "hello",
      at: offset,
    });
    expect(await store.getLogs("run")).toMatchObject([{ at: utc }]);
    await store.release("run", "owner");
    expect((await store.dueRuns(offset)).map((run) => run.id)).toEqual(["run"]);
    await store.claim("run", "owner");
    await store.suspend("run", "owner", offset);
    await store.release("run", "owner");
    expect((await store.getRun("run"))?.wakeAt).toBe(utc);
    expect((await store.dueRuns(offset)).map((run) => run.id)).toEqual(["run"]);
  } finally {
    store.close();
  }
});

test("a dead same-host PID permits takeover after lease expiry", async () => {
  const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  child.kill("SIGKILL");
  await child.exited;
  let now = clock();
  const store = new SqliteRunStore(":memory:", () => now, { leaseMs: 2000 });

  try {
    await store.createRun({
      ...newRun(),
      status: "running",
      owner: {
        token: "dead",
        pid: child.pid,
        host: hostname(),
        heartbeatAt: newRun().createdAt,
      },
    });
    expect(await store.dueRuns(newRun().createdAt)).toEqual([]);
    now += 2001;
    expect((await store.dueRuns(new Date(now).toISOString())).map((run) => run.id)).toEqual([
      "run",
    ]);
    expect(await store.claim("run", "alive")).toMatchObject({
      owner: { token: "alive", pid: process.pid },
    });
    expect(await store.heartbeat("run", "dead")).toBe(false);
  } finally {
    store.close();
  }
});

test("a live local PID remains owned after its heartbeat lease expires", async () => {
  let now = clock();
  const store = new SqliteRunStore(":memory:", () => now, { leaseMs: 2000 });

  try {
    await store.createRun(newRun());
    await store.claim("run", "live");
    now += 2001;
    expect(await store.dueRuns(new Date(now).toISOString())).toEqual([]);
    await expect(store.claim("run", "thief")).rejects.toThrow("not owned by this token");
    expect((await store.getRun("run"))?.owner?.token).toBe("live");
  } finally {
    store.close();
  }
});

test("rate windows and hook payloads survive reopening the SQLite file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-hooks-reopen-"));
  const file = join(directory, "runs.sqlite");
  const store = new SqliteRunStore(file, clock);

  try {
    await store.createRun(newRun());
    await store.claim("run", "owner");
    await store.createHook("run", "owner", {
      runId: "run",
      seq: 1,
      key: "hook:approve",
      kind: "hook",
      status: "waiting",
      input: { name: "approve", token: "hook-token" },
      attempt: 1,
      maxAttempts: 1,
      startedAt: newRun().createdAt,
    });
    await store.acquireRateLimit("codex", 1, 60_000, newRun().createdAt);
    await store.suspend("run", "owner");
    await store.release("run", "owner");
  } finally {
    store.close();
  }

  const reopened = new SqliteRunStore(file, clock);

  try {
    expect(await reopened.acquireRateLimit("codex", 1, 60_000, newRun().createdAt)).toEqual({
      ok: false,
      retryAt: "2026-10-16T00:01:00.000Z",
    });
    expect(await reopened.resolveHook("hook-token", { ok: true })).toBe(true);
    expect(await reopened.getSteps("run")).toMatchObject([{ status: "waiting" }]);
    expect(await reopened.listHooks("run")).toMatchObject([
      { token: "hook-token", payload: { ok: true }, resolvedAt: newRun().createdAt },
    ]);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("event history and epoch persist across connections and reset with the schema", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-events-epoch-"));
  const file = join(directory, "runs.sqlite");

  try {
    const first = new SqliteRunStore(file, clock);
    await first.createRun(newRun());
    const epoch = await first.epoch();
    const events = await first.events(0, 10);
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/);
    const second = new SqliteRunStore(file, clock);

    try {
      expect(await second.epoch()).toBe(epoch);
      expect(await second.events(0, 10)).toEqual(events);
      let readable: Promise<ReturnType<typeof newRun> | undefined> | undefined;
      let visibleEvents: ReturnType<typeof second.events> | undefined;
      first.subscribe(() => {
        readable = second.getRun("another");
        visibleEvents = second.events(1, 10);
      });
      await first.createRun({ ...newRun(), id: "another" });
      expect(await readable).toMatchObject({ id: "another" });
      expect(await visibleEvents).toMatchObject([{ sequence: 2, entity: "run", kind: "created" }]);
    } finally {
      first.close();
      second.close();
    }

    const database = new Database(file);
    database.exec("PRAGMA user_version=9");
    database.close();
    const reset = new SqliteRunStore(file, clock);

    try {
      expect(await reset.epoch()).not.toBe(epoch);
      expect(await reset.events(0, 10)).toEqual([]);
      expect(await reset.getRun("run")).toBeUndefined();
      await reset.createRun(newRun());
      expect((await reset.events(0, 10))[0]?.sequence).toBe(1);
    } finally {
      reset.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an event append failure rolls back state and never notifies subscribers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-events-rollback-"));
  const file = join(directory, "runs.sqlite");
  const store = new SqliteRunStore(file, clock);
  const database = new Database(file);

  try {
    let deliveries = 0;
    store.subscribe(() => {
      deliveries++;
    });
    database.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON events
      BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`);
    await expect(store.createRun(newRun())).rejects.toThrow("outbox unavailable");
    expect(await store.getRun("run")).toBeUndefined();
    expect(await store.events(0, 10)).toEqual([]);
    expect(deliveries).toBe(0);
    database.exec("DROP TRIGGER reject_event");
    await store.createRun(newRun());
    expect(deliveries).toBe(1);
    expect((await store.events(0, 10))[0]?.sequence).toBe(1);
  } finally {
    database.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite event reads reject malformed entity records at the JSON boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-events-validation-"));
  const file = join(directory, "runs.sqlite");
  const store = new SqliteRunStore(file, clock);
  const database = new Database(file);

  try {
    await store.createRun(newRun());
    database
      .query("UPDATE events SET record=?")
      .run(JSON.stringify({ ...newRun(), status: "unknown" }));
    await expect(store.events(0, 10)).rejects.toThrow(z.ZodError);
    database.query("UPDATE events SET record=?").run(
      JSON.stringify({
        ...newRun(),
        input: null,
        owner: { token: "owner", pid: "wrong", host: "host", heartbeatAt: newRun().createdAt },
      }),
    );
    await expect(store.events(0, 10)).rejects.toThrow(z.ZodError);
    database.query("UPDATE events SET record=?").run("[]");
    await expect(store.events(0, 10)).rejects.toThrow(z.ZodError);
    await store.claim("run", "owner");
    await store.putStep("run", "owner", runningStep());
    database
      .query("UPDATE events SET record=? WHERE entity='step'")
      .run(JSON.stringify({ ...runningStep(), seq: -1 }));
    await expect(store.events(0, 10)).rejects.toThrow(z.ZodError);
    database
      .query("UPDATE events SET record=? WHERE entity='step'")
      .run(JSON.stringify({ ...runningStep(), attempt: 1.5 }));
    await expect(store.events(0, 10)).rejects.toThrow(z.ZodError);
    database.query("UPDATE events SET record=?").run("{");
    await expect(store.events(0, 10)).rejects.toThrow(SyntaxError);
  } finally {
    database.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
