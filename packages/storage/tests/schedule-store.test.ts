import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Storage } from "../src/index.js";

const project = () => mkdtempSync(join(tmpdir(), "loopy-schedule-"));

describe("schedule persistence", () => {
  test("reopens schedules and claims duplicate fires once", () => {
    const dir = project();
    const first = new Storage({ projectDir: dir });
    first.runtime.createWorkflowVersion({
      workflowId: "wf",
      version: 1,
      definition: { id: "wf", workflowVersion: 1 },
    });
    const schedule = first.schedules.create({
      id: "schedule-1",
      name: "nightly",
      workflowId: "wf",
      workflowVersion: 1,
      expression: "0 0 * * *",
      nextFireAt: "2026-08-17T00:00:00.000Z",
    });
    const claimed = first.schedules.claimFire({
      scheduleId: schedule.id,
      fireKey: schedule.nextFireAt as string,
      scheduledAt: schedule.nextFireAt as string,
    });
    expect(
      first.schedules.claimFire({
        scheduleId: schedule.id,
        fireKey: schedule.nextFireAt as string,
        scheduledAt: schedule.nextFireAt as string,
      }).id,
    ).toBe(claimed.id);
    first.close();
    const reopened = new Storage({ projectDir: dir });
    expect(reopened.schedules.get(schedule.id)?.nextFireAt).toBe("2026-08-17T00:00:00.000Z");
    expect(reopened.schedules.listFires(schedule.id)).toHaveLength(1);
    reopened.close();
  });

  test("returns ownership for a fire claim and rejects stale scheduler state writes", async () => {
    const storage = new Storage({ projectDir: project() });
    storage.runtime.createWorkflowVersion({
      workflowId: "wf",
      version: 1,
      definition: { id: "wf", workflowVersion: 1 },
    });
    const schedule = storage.schedules.create({
      id: "cas-schedule",
      name: "cas",
      workflowId: "wf",
      workflowVersion: 1,
      expression: "0 0 * * *",
      nextFireAt: "2026-08-17T00:00:00.000Z",
    });
    const first = storage.schedules.claimFire({
      scheduleId: schedule.id,
      fireKey: "same",
      scheduledAt: "2026-08-17T00:00:00.000Z",
    });
    const second = storage.schedules.claimFire({
      scheduleId: schedule.id,
      fireKey: "same",
      scheduledAt: "2026-08-17T00:00:00.000Z",
    });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    const store = storage.schedules.schedulerStore();
    const state = (await store.getState(schedule.id)) as NonNullable<
      Awaited<ReturnType<typeof store.getState>>
    >;
    const stale = { ...state, nextDueAt: "2026-08-18T00:00:00.000Z" };
    await store.saveState(state);
    await expect(store.saveState(stale)).rejects.toThrow(/changed concurrently/);
    storage.close();
  });

  test("records overlap bookkeeping and protects active runs from retention preview", () => {
    const storage = new Storage({ projectDir: project() });
    storage.runtime.createWorkflowVersion({
      workflowId: "wf",
      version: 1,
      definition: { id: "wf", workflowVersion: 1 },
    });
    const schedule = storage.schedules.create({
      name: "manual",
      workflowId: "wf",
      workflowVersion: 1,
      expression: "manual",
    });
    const fire = storage.schedules.claimFire({
      scheduleId: schedule.id,
      fireKey: "manual-1",
      scheduledAt: "2026-08-17T00:00:00.000Z",
    });
    storage.runtime.createRun({
      id: "run-active",
      workflowId: "wf",
      workflowVersion: 1,
      status: "running",
      createdAt: "2026-08-17T00:00:00.000Z",
    });
    storage.schedules.linkRun({ scheduleId: schedule.id, fireId: fire.id, runId: "run-active" });
    expect(storage.schedules.listLinks(schedule.id, "active").map((item) => item.runId)).toEqual([
      "run-active",
    ]);
    expect(
      storage.schedules.previewRetention({ before: "2026-08-18T00:00:00.000Z" }).protectedRunIds,
    ).toContain("run-active");
    storage.close();
  });

  test("adapts durable schedules to the scheduler state port", async () => {
    const storage = new Storage({ projectDir: project() });
    storage.runtime.createWorkflowVersion({
      workflowId: "wf",
      version: 1,
      definition: { id: "wf", workflowVersion: 1 },
    });
    const schedule = storage.schedules.create({
      id: "durable-schedule",
      name: "durable",
      workflowId: "wf",
      workflowVersion: 1,
      expression: "0 0 * * *",
      nextFireAt: "2026-08-17T00:00:00.000Z",
    });
    const schedulerStore = storage.schedules.schedulerStore();
    expect((await schedulerStore.listSchedules())[0]?.schedule.scheduleId).toBe(schedule.id);
    expect((await schedulerStore.getState(schedule.id))?.nextDueAt).toBe(
      "2026-08-17T00:00:00.000Z",
    );
    expect(await schedulerStore.claimIdempotencyKey(schedule.id, `${schedule.id}:fire`)).toBe(true);
    expect(await schedulerStore.claimIdempotencyKey(schedule.id, `${schedule.id}:fire`)).toBe(
      false,
    );
    await schedulerStore.saveState({
      scheduleId: schedule.id,
      nextDueAt: "2026-08-18T00:00:00.000Z",
    });
    expect(storage.schedules.get(schedule.id)?.nextFireAt).toBe("2026-08-18T00:00:00.000Z");
    storage.close();
  });

  test("applies bounded retention with preview parity and removes only database records", () => {
    const dir = project();
    const sourcePath = join(dir, "artifact.txt");
    writeFileSync(sourcePath, "keep this source file");
    const storage = new Storage({ projectDir: dir });
    storage.runtime.createWorkflowVersion({
      workflowId: "wf",
      version: 1,
      definition: { id: "wf", workflowVersion: 1 },
    });
    const schedule = storage.schedules.create({
      id: "retention-schedule",
      name: "retention",
      workflowId: "wf",
      workflowVersion: 1,
      expression: "manual",
    });

    const old = storage.runtime.createRun({
      id: "old-terminal",
      workflowId: "wf",
      workflowVersion: 1,
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const attempt = storage.runtime.createAttempt({
      id: "old-attempt",
      runId: old.id,
      nodeId: "node",
      status: "succeeded",
    });
    storage.runtime.recordApproval({
      id: "old-approval",
      runId: old.id,
      nodeId: "node",
      attemptId: attempt.id,
      approvalKey: "approve",
      message: "approve",
      status: "approved",
    });
    storage.runtime.recordArtifact({
      id: "old-artifact",
      runId: old.id,
      sha256: "old-sha",
      mediaType: "text/plain",
      sizeBytes: 20,
      redacted: false,
      sourcePath,
    });
    storage.runtime.appendEvent(old.id, { type: "old.event", payload: {} });
    const fire = storage.schedules.claimFire({
      scheduleId: schedule.id,
      fireKey: "old-fire",
      scheduledAt: "2026-01-01T00:00:00.000Z",
    });
    storage.schedules.linkRun({
      scheduleId: schedule.id,
      fireId: fire.id,
      runId: old.id,
      state: "terminal",
    });

    storage.runtime.createRun({
      id: "newer-terminal",
      workflowId: "wf",
      workflowVersion: 1,
      status: "succeeded",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    storage.runtime.createRun({
      id: "oldest-terminal",
      workflowId: "wf",
      workflowVersion: 1,
      status: "failed",
      createdAt: "2025-12-31T00:00:00.000Z",
    });
    storage.runtime.createRun({
      id: "active-run",
      workflowId: "wf",
      workflowVersion: 1,
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const filter = {
      before: "2026-02-01T00:00:00.000Z",
      maxRuns: 1,
      batchSize: 1,
    };
    const preview = storage.schedules.previewRetention(filter);
    const applied = storage.schedules.applyRetention(filter);
    expect(applied.candidates.map((item) => item.runId)).toEqual(
      preview.candidates.map((item) => item.runId),
    );
    expect(applied.deletedRunIds).toEqual(["old-terminal"]);
    expect(applied.hasMore).toBe(true);
    expect(applied.deletedCounts).toEqual({
      runs: 1,
      events: 3,
      artifacts: 1,
      approvals: 1,
      nodeAttempts: 1,
      scheduleRunLinks: 1,
      scheduleFires: 1,
    });
    expect(storage.runtime.getRun("old-terminal")).toBeUndefined();
    expect(storage.runtime.getAttempt("old-attempt")).toBeUndefined();
    expect(storage.runtime.getApproval("old-approval")).toBeUndefined();
    expect(storage.runtime.getArtifact("old-artifact")).toBeUndefined();
    expect(storage.schedules.getFire(fire.id)).toBeUndefined();
    expect(storage.schedules.listLinks(schedule.id)).toHaveLength(0);
    expect(storage.runtime.getRun("active-run")?.status).toBe("running");
    expect(existsSync(sourcePath)).toBe(true);

    const repeated = storage.schedules.applyRetention(filter);
    expect(repeated.deletedRunIds).not.toContain("old-terminal");
    expect(storage.runtime.getRun("active-run")?.status).toBe("running");
    storage.close();
  });
});
