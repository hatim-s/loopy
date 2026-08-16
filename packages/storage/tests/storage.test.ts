import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ProjectLockError, SqliteRuntimeStore, Storage } from "../src/index.js";

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
      count: 2,
    });
    first.close();
    const second = new Storage({ projectDir: dir });
    expect(second.db.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 2,
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
  test("releases the project lock when database initialization fails", () => {
    const dir = project();
    mkdirSync(join(dir, ".loopy", "loopy.db"), { recursive: true });
    expect(() => new Storage({ projectDir: dir })).toThrow();
    expect(existsSync(join(dir, ".loopy", "loopy.lock"))).toBe(false);

    const migrationDir = project();
    mkdirSync(join(migrationDir, ".loopy"), { recursive: true });
    const broken = new Database(join(migrationDir, ".loopy", "loopy.db"));
    broken.run(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    broken.run("INSERT INTO schema_migrations VALUES (1, '2026-08-17T00:00:00.000Z')");
    broken.close();
    expect(() => new Storage({ projectDir: migrationDir })).toThrow();
    expect(existsSync(join(migrationDir, ".loopy", "loopy.lock"))).toBe(false);
  });
  test("upgrades a v1 approvals table without mutating the v1 migration", () => {
    const dir = project();
    const first = new Storage({ projectDir: dir });
    first.close();
    const db = new Database(join(dir, ".loopy", "loopy.db"));
    db.run("PRAGMA foreign_keys=OFF");
    db.run("ALTER TABLE approvals RENAME TO approvals_v2");
    db.run(
      "CREATE TABLE approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, node_id TEXT, approval_key TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, UNIQUE(run_id,approval_key))",
    );
    db.run(
      "INSERT INTO approvals SELECT id,run_id,node_id,approval_key,message,status,requested_at,resolved_at,resolved_by FROM approvals_v2",
    );
    db.run("DROP TABLE approvals_v2");
    db.run("DELETE FROM schema_migrations WHERE version=2");
    db.close();
    const upgraded = new Storage({ projectDir: dir });
    expect(
      upgraded.db.query("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(
      upgraded.db
        .query("SELECT name FROM pragma_table_info('approvals') WHERE name='attempt_id'")
        .get(),
    ).toEqual({ name: "attempt_id" });
    expect(upgraded.db.query("PRAGMA foreign_key_list(approvals)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "attempt_id",
          table: "node_attempts",
          on_delete: "SET NULL",
        }),
      ]),
    );
    upgraded.close();
  });
  test("persists approval attempt identity with the FK and round-trips it", () => {
    const s = new Storage({ projectDir: project() });
    seeded(s);
    const run = s.runtime.createRun({ id: "run", workflowId: "workflow", workflowVersion: 1 });
    const attempt = s.runtime.createAttempt({
      runId: run.id,
      nodeId: "approve",
      status: "blocked_approval",
    });
    const saved = s.runtime.recordApproval({
      id: "approval",
      runId: run.id,
      nodeId: attempt.nodeId,
      attemptId: attempt.id,
      approvalKey: "ship",
      message: "Ship?",
    });
    expect(saved.attemptId).toBe(attempt.id);
    expect(s.runtime.getApproval(saved.id)?.attemptId).toBe(attempt.id);
    expect(() =>
      s.runtime.recordApproval({
        runId: run.id,
        nodeId: "bad",
        attemptId: "missing",
        approvalKey: "bad",
        message: "bad",
      }),
    ).toThrow();
    s.close();
  });
  test("cancelling recovery only transitions legal pending, ready, and running attempts", () => {
    const s = new Storage({ projectDir: project() });
    seeded(s);
    const run = s.runtime.createRun({
      id: "run",
      workflowId: "workflow",
      workflowVersion: 1,
      status: "cancelling",
    });
    for (const [nodeId, status] of [
      ["pending", "pending"],
      ["ready", "ready"],
      ["running", "running"],
    ] as const)
      s.runtime.createAttempt({ runId: run.id, nodeId, status });
    expect(s.runtime.listCancellableAttempts(run.id).map((a) => a.status)).toEqual([
      "pending",
      "ready",
      "running",
    ]);
    expect(s.runtime.recoverCancellingRun(run.id).status).toBe("cancelled");
    expect(s.runtime.listAttempts(run.id).every((a) => a.status === "cancelled")).toBe(true);
    s.close();
  });
  test("approval resolution and terminal recovery expose conditional atomic seams", () => {
    const s = new Storage({ projectDir: project() });
    seeded(s);
    const run = s.runtime.createRun({ id: "run", workflowId: "workflow", workflowVersion: 1 });
    const attempt = s.runtime.createAttempt({
      runId: run.id,
      nodeId: "approve",
      status: "blocked_approval",
    });
    s.runtime.recordApproval({
      runId: run.id,
      nodeId: "approve",
      attemptId: attempt.id,
      approvalKey: "ship",
      message: "Ship?",
    });
    const store = new SqliteRuntimeStore(s);
    const resolved = store.resolveApprovalAtomically({
      runId: run.id,
      nodeId: "approve",
      decision: "approved",
      attemptStatus: "succeeded",
    });
    expect(resolved.approval.attemptId).toBe(attempt.id);
    expect(resolved.attempt?.status).toBe("succeeded");
    expect(() =>
      store.resolveApprovalAtomically({ runId: run.id, nodeId: "approve", decision: "approved" }),
    ).toThrow(/already/);
    s.runtime.transitionRun(run.id, "failed");
    expect(() =>
      store.compareAndSetRunStatus({
        runId: run.id,
        expectedStatus: "failed",
        nextStatus: "running",
      }),
    ).toThrow(/Illegal/);
    expect(
      store.compareAndSetRunStatus({
        runId: run.id,
        expectedStatus: "failed",
        nextStatus: "running",
        allowTerminalRecovery: true,
      }).status,
    ).toBe("running");
    s.close();
  });
  test("trace projection fails loudly when workflow identity or plan hash is absent", async () => {
    const s = new Storage({ projectDir: project() });
    seeded(s);
    const run = s.runtime.createRun({ id: "run", workflowId: "workflow", workflowVersion: 1 });
    const store = new SqliteRuntimeStore(s);
    await expect(
      store.commit([
        {
          type: "append_event",
          event: {
            sequence: 1,
            type: "run.created",
            runId: run.id,
            occurredAt: new Date().toISOString(),
            payload: { workflowVersion: 1 },
          },
        },
      ]),
    ).rejects.toThrow(/workflowId/);
    await expect(
      store.commit([
        {
          type: "append_event",
          event: {
            sequence: 1,
            type: "run.started",
            runId: run.id,
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        },
      ]),
    ).rejects.toThrow(/planHash/);
    s.close();
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
