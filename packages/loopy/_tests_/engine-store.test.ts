import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineLog, EngineStep } from "../src/core/index.js";
import { SqliteRunStore } from "../src/local/index.js";
import { newRun } from "./engine-fixture.js";
import { storeContract } from "./store-contract.js";

const clock = () => Date.parse("2026-10-16T00:00:00.000Z");

storeContract("SqliteRunStore", () => new SqliteRunStore(":memory:", clock));

test("schema version mismatch recreates tables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-engine-schema-"));
  const file = join(directory, "engine.sqlite");

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
    database.exec("CREATE TABLE obsolete (value TEXT); PRAGMA user_version=2");
    database.close();
    const store = new SqliteRunStore(file, clock);

    try {
      expect(await store.listRuns()).toEqual([]);
      expect(await store.getSteps("run")).toEqual([]);
      const inspection = new Database(file);

      try {
        expect(inspection.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
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
  const file = join(directory, "engine.sqlite");
  const run = newRun();

  const base = {
    runId: run.id,
    key: "test",
    kind: "function",
    input: null,
    attempt: 1,
    maxAttempts: 3,
    startedAt: run.createdAt,
  } satisfies Omit<EngineStep, "seq" | "status">;

  const steps: EngineStep[] = [
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

  const logs: EngineLog[] = [
    {
      runId: run.id,
      seq: 1,
      position: { afterStep: 3, afterFinish: 2, index: 1 },
      level: "info",
      message: "hello",
      data: null,
      at: run.createdAt,
    },
    {
      runId: run.id,
      seq: 2,
      position: { afterStep: 3, afterFinish: 2, index: 2 },
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
