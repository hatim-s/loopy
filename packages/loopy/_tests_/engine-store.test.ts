import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord, StepRecord } from "../src/core/index.js";
import { SqliteRunStore } from "../src/local/index.js";
import { newRun } from "./engine-fixture.js";
import { storeContract } from "./store-contract.js";

const clock = () => Date.parse("2026-10-16T00:00:00.000Z");

storeContract("SqliteRunStore", () => new SqliteRunStore(":memory:"));

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
        expect(inspection.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
        expect(
          inspection.query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
        ).toEqual(
          ["hooks", "logs", "rate_limits", "runs", "schedules", "steps"].map((name) => ({ name })),
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
