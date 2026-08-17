import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSchedule,
  FileScheduleStore,
  fireSchedule,
  installSchedulerArtifacts,
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

  it("filters a per-schedule tick so installed artifacts cannot fire every schedule", () => {
    const store = new FileScheduleStore(mkdtempSync(join(tmpdir(), "loopy-schedule-")));
    store.put({
      ...createSchedule({
        id: "hourly",
        workflowId: "workflow-1",
        expression: "* * * * *",
        timezone: "UTC",
        now,
      }),
      nextFireAt: now.toISOString(),
    });
    store.put({
      ...createSchedule({
        id: "nightly",
        workflowId: "workflow-1",
        expression: "* * * * *",
        timezone: "UTC",
        now,
      }),
      nextFireAt: now.toISOString(),
    });

    const result = tickSchedules(store, now, "hourly");
    expect(result.due.map((entry) => entry.scheduleId)).toEqual(["hourly"]);
    expect(() => tickSchedules(store, now, "missing")).toThrow("Unknown schedule 'missing'");
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

  it("renders a real CLI entrypoint instead of the invalid bare bun schedule command", () => {
    const item = schedule("entrypoint");
    const artifacts = renderSchedulerArtifacts(item, {
      executable: "/opt/homebrew/bin/bun",
      entrypoint: "/opt/loopy/dist/index.js",
      projectDir: "/tmp/project",
      platform: "darwin",
      targetDir: "/tmp/launchd",
    });
    const content = artifacts[0]?.content ?? "";
    expect(content).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(content).toContain("<string>/opt/loopy/dist/index.js</string>");
    expect(content).toContain("<string>schedule</string>");
    expect(content).toContain("<string>--schedule</string>");
    expect(() =>
      renderSchedulerArtifacts(item, {
        executable: "/opt/homebrew/bin/bun",
        projectDir: "/tmp/project",
        platform: "darwin",
        targetDir: "/tmp/launchd",
      }),
    ).toThrow("requires an explicit Loopy CLI entrypoint");
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

  it("refuses unmanaged collisions, updates owned artifacts, and removes only owned content", () => {
    const item = schedule("owned");
    const targetDir = mkdtempSync(join(tmpdir(), "loopy-schedule-"));
    const artifacts = renderSchedulerArtifacts(item, {
      executable: "/usr/local/bin/loopy",
      projectDir: targetDir,
      platform: "linux",
      targetDir,
    });
    const first = artifacts[0];
    if (!first) throw new Error("expected a scheduler artifact");
    writeFileSync(first.path, "user-owned configuration\n");
    expect(() => installSchedulerArtifacts(artifacts)).toThrow("Refusing to overwrite unmanaged");
    expect(readFileSync(first.path, "utf8")).toBe("user-owned configuration\n");

    // The other artifacts can be installed, then updated in place because
    // their embedded ownership marker matches.
    installSchedulerArtifacts(artifacts.slice(1));
    const updated = renderSchedulerArtifacts(
      { ...item, name: "Updated" },
      {
        executable: "/usr/local/bin/loopy",
        projectDir: targetDir,
        platform: "linux",
        targetDir,
      },
    );
    installSchedulerArtifacts(updated.slice(1));
    expect(readFileSync(updated[1]?.path ?? "", "utf8")).toContain("Updated");
    expect(uninstallSchedulerArtifacts(artifacts)).toEqual(updated.slice(1).map((a) => a.path));
    expect(existsSync(updated[1]?.path ?? "")).toBe(false);
    expect(existsSync(first.path)).toBe(true);
  });

  it("keeps atomic-write temporary files beside the destination and cleans them up", () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-schedule-"));
    const store = new FileScheduleStore(project);
    store.put(schedule("atomic"));
    const stateDir = join(project, ".loopy");
    expect(readdirSync(stateDir).filter((name) => name.includes("schedules.json.")).length).toBe(0);
  });
});
