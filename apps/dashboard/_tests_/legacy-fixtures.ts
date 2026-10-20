import type { LoopyView, RunSnapshotView, ScheduleView } from "loopy/contract";

export const at = "2026-10-20T10:00:00.000Z";

export const legacySnapshot = {
  run: {
    id: "recorded/1",
    slug: "approval",
    workspace: "/actual/old-cwd",
    loopy: { slug: "approval", description: "Recorded approval" },
    input: { request: "fixture" },
    status: "succeeded",
    output: { approved: true },
    createdAt: at,
    updatedAt: at,
    owner: null,
    ownerStale: false,
    waitingOn: null,
  },
  steps: [
    {
      runId: "recorded/1",
      seq: 1,
      key: "approve",
      kind: "hook",
      input: { name: "approval", token: "fixture-hook" },
      attempt: 2,
      maxAttempts: 3,
      startedAt: at,
      endedAt: at,
      finishOrder: 1,
      status: "succeeded",
      output: { approved: true },
    },
  ],
  logs: [
    {
      runId: "recorded/1",
      seq: 1,
      position: { kind: "step", seq: 1, attempt: 2, index: 0 },
      level: "info",
      message: "Recorded fixture log",
      at,
    },
  ],
  hooks: [
    {
      runId: "recorded/1",
      seq: 1,
      token: "fixture-hook",
      name: "approval",
      createdAt: at,
      resolvedAt: at,
      payload: { approved: true },
    },
  ],
  cursor: 10,
  epoch: "legacy-epoch",
} satisfies Omit<RunSnapshotView, "nodeRuns">;

export const legacyLoopy = {
  slug: "approval",
  description: "Recorded approval",
  scope: "project",
  mode: "sandbox",
  input: {},
  schedule: null,
  lastRun: legacySnapshot.run,
  counts: { queued: 0, running: 0, suspended: 0, succeeded: 1, failed: 0, cancelled: 0 },
} satisfies Omit<LoopyView, "workspace">;

export const legacySchedule = {
  revision: 7,
  workspace: "/scheduled/cwd",
  slug: "approval",
  cron: "@hourly",
  tz: "UTC",
  input: {},
  enabled: true,
  lastFireKey: null,
  nextFireAt: at,
} satisfies Omit<ScheduleView, "version"> & { revision: number };
