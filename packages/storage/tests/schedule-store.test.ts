import { mkdtempSync } from "node:fs";
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
});
