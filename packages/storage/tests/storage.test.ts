import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ProjectLockError, Storage } from "../src/index.js";

function project(): string {
  return mkdtempSync(join(tmpdir(), "loopy-storage-"));
}
function seeded(s: Storage): void {
  s.runtime.createWorkflowVersion({
    workflowId: "workflow",
    version: 1,
    definition: { id: "workflow", workflowVersion: 1 },
  });
}

describe("storage", () => {
  test("creates canonical database, applies idempotent migrations, and sets SQLite pragmas", () => {
    const dir = project();
    const first = new Storage({ projectDir: dir });
    seeded(first);
    expect(first.databasePath).toBe(join(dir, ".loopy", "loopy.db"));
    expect(first.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(first.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(first.db.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 1,
    });
    first.close();
    const second = new Storage({ projectDir: dir });
    expect(second.db.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 1,
    });
    second.close();
  });
  test("creates run and attempts with event sequences in order", () => {
    const s = new Storage({ projectDir: project() });
    seeded(s);
    const run = s.runtime.createRun({ id: "run", workflowId: "workflow", workflowVersion: 1 });
    const attempt = s.runtime.createAttempt({ runId: run.id, nodeId: "node" });
    s.runtime.transitionRun(run.id, "running", {
      type: "run.started",
      payload: { planHash: "a".repeat(64) },
    });
    s.runtime.transitionAttempt(
      attempt.id,
      "succeeded",
      { output: { ok: true } },
      { type: "node.completed", payload: { ok: true } },
    );
    expect(s.runtime.listEvents(run.id).map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    s.close();
  });
  test("rolls back a run and its event together on failure", () => {
    const s = new Storage({ projectDir: project() });
    seeded(s);
    expect(() =>
      s.runtime.createRun({ id: "run", workflowId: "missing", workflowVersion: 1 }),
    ).toThrow();
    expect(s.runtime.getRun("run")).toBeUndefined();
    expect(s.runtime.countEvents("run")).toBe(0);
    s.close();
  });
  test("does not silently steal a live or stale lock and releases owned locks", () => {
    const dir = project();
    const first = new Storage({ projectDir: dir });
    expect(() => new Storage({ projectDir: dir })).toThrow(ProjectLockError);
    first.close();
    const lock = join(dir, ".loopy", "loopy.lock");
    writeFileSync(
      lock,
      JSON.stringify({
        pid: 999_999_999,
        host: "not-this-host",
        token: "stale",
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    expect(() => new Storage({ projectDir: dir, staleLockAfterMs: 0 })).toThrow(/stale/);
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        host: "not-this-host",
        token: "foreign",
        acquiredAt: new Date().toISOString(),
      }),
    );
    expect(() => new Storage({ projectDir: dir })).toThrow(/live owner/);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("foreign");
  });
  test("recovers running attempts and paginates events", () => {
    const s = new Storage({ projectDir: project() });
    seeded(s);
    const run = s.runtime.createRun({ id: "run", workflowId: "workflow", workflowVersion: 1 });
    const attempt = s.runtime.createAttempt({ runId: run.id, nodeId: "node", status: "running" });
    for (let i = 0; i < 4; i++)
      s.runtime.appendEvent(run.id, { type: `test.${i}`, payload: { i } });
    expect(
      s.runtime.listEvents(run.id, { afterSequence: 1, limit: 2 }).map((e) => e.sequence),
    ).toEqual([2, 3]);
    expect(s.runtime.listRecoverableAttempts().map((a) => a.id)).toEqual([attempt.id]);
    expect(s.runtime.recoverRunningAttempts()[0]?.status).toBe("interrupted");
    s.close();
  });
});
