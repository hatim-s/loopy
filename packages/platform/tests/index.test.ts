import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSchedule,
  FileScheduleStore,
  fireSchedule,
  nextFireAt,
  platformFor,
  renderSchedulerArtifacts,
  tickSchedules,
  uninstallSchedulerArtifacts,
} from "../src/index";

const now = new Date("2026-01-01T00:00:00.000Z");

function schedule(id = "nightly") {
  return createSchedule({
    id,
    name: "Nightly check",
    workflowId: "workflow-1",
    expression: "0 0 * * *",
    timezone: "UTC",
    now,
  });
}

describe("local scheduler platform", () => {
  it("persists schedules atomically in the project state directory", () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-schedule-"));
    const store = new FileScheduleStore(project);
    const saved = store.put(schedule());

    expect(store.get("nightly")).toEqual(saved);
    expect(JSON.parse(readFileSync(join(project, ".loopy", "schedules.json"), "utf8"))).toEqual({
      schemaVersion: "1",
      schedules: [saved],
    });
    expect(store.remove("nightly")).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("validates timezone and calculates a deterministic next occurrence", () => {
    expect(nextFireAt("0 * * * *", "UTC", now)).toBe("2026-01-01T01:00:00.000Z");
    expect(() => createSchedule({ workflowId: "x", expression: "bad", timezone: "UTC" })).toThrow(
      "Invalid cron expression",
    );
    expect(() =>
      createSchedule({ workflowId: "x", expression: "* * * * *", timezone: "Nope/Zone" }),
    ).toThrow("Unknown schedule timezone");
  });

  it("fires and ticks enabled schedules while respecting skip for stale missed work", () => {
    const store = new FileScheduleStore(mkdtempSync(join(tmpdir(), "loopy-schedule-")));
    const hourly = store.put(schedule("hourly"));
    expect(fireSchedule(store, hourly.id, now).workflowId).toBe("workflow-1");
    expect(store.get(hourly.id)?.lastFireAt).toBe(now.toISOString());

    const stale = store.put({
      ...schedule("stale"),
      nextFireAt: "2025-12-31T22:00:00.000Z",
      missedPolicy: "skip",
    });
    const result = tickSchedules(store, now);
    expect(result.due.map((entry) => entry.scheduleId)).toEqual([]);
    expect(result.skipped).toEqual([stale.id]);
  });

  it("renders escaped, stable launchd, systemd, and cron artifacts", () => {
    const item = schedule("safe-id");
    const artifacts = renderSchedulerArtifacts(item, {
      executable: "/tmp/loopy agent/'bin",
      projectDir: "/tmp/project with spaces",
      platform: "darwin",
      targetDir: "/tmp/launchd",
    });
    expect(artifacts[0]?.path).toContain("dev.loopy.schedule.safe-id.plist");
    expect(artifacts[0]?.content).toContain("&apos;");
    expect(artifacts[0]?.content).toContain("LOOPY_TIMEZONE");

    const linux = renderSchedulerArtifacts(item, {
      executable: "/tmp/loopy agent/bin",
      projectDir: "/tmp/project with spaces",
      platform: "linux",
      targetDir: "/tmp/systemd",
    });
    expect(linux).toHaveLength(3);
    expect(linux[0]?.content).toContain("ExecStart=/tmp/loopy\\x20agent/bin");
    expect(linux[2]?.content).toContain("# loopy-managed:safe-id");
    expect(() => platformFor("win32")).toThrow("Windows Task Scheduler is not implemented yet");
  });

  it("uninstall is idempotent and only removes its explicit artifacts", () => {
    const item = schedule();
    const targetDir = mkdtempSync(join(tmpdir(), "loopy-schedule-"));
    const artifacts = renderSchedulerArtifacts(item, {
      executable: "/usr/local/bin/loopy",
      projectDir: targetDir,
      platform: "linux",
      targetDir,
    });
    // The files need not exist for a safe uninstall.
    expect(uninstallSchedulerArtifacts(artifacts)).toEqual([]);
  });
});
