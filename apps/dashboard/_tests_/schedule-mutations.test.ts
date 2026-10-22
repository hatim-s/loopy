import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ScheduleView } from "loopy/contract";
import { fakeBackend } from "../src/backend/fake.ts";
import { keys } from "../src/lib/keys.ts";
import { toggleSchedule } from "../src/lib/mutations.ts";
import { applyBatch } from "../src/lib/stream.ts";

const schedule: ScheduleView = {
  workspace: "/work",
  slug: "triage",
  cron: "@hourly",
  tz: "UTC",
  input: {},
  enabled: true,
  version: 2,
  nextFireAt: "2026-10-17T11:00:00.000Z",
  lastFireKey: null,
};

function pendingToggle(client: QueryClient) {
  const reply = Promise.withResolvers<ScheduleView>();
  const started = Promise.withResolvers<void>();

  const backend = fakeBackend({
    epoch: "e1",
    loopies: [],
    schedules: [],
    runs: [],
    graphs: [],
    pins: {},
    batches: [],
    intervalMs: 0,
  });

  const request = toggleSchedule(
    client,
    {
      ...backend,
      setScheduleEnabled: () => {
        started.resolve();

        return reply.promise;
      },
    },
    { slug: schedule.slug, workspace: schedule.workspace, enabled: false },
  );

  return { reply, started: started.promise, request };
}

function saved(client: QueryClient, view: ScheduleView) {
  const { lastFireKey, ...record } = view;
  applyBatch(client, [
    {
      entity: "schedule",
      kind: "saved",
      runId: null,
      sequence: 11,
      txn: "t1",
      at: "2026-10-17T10:00:00.000Z",
      record: lastFireKey === null ? record : { ...record, lastFireKey },
    },
  ]);
}

test("a failed toggle preserves version 4 delivered while its POST is pending", async () => {
  const client = new QueryClient();
  client.setQueryData(keys.schedules("/work"), [schedule]);
  const pending = pendingToggle(client);
  await pending.started;
  const newer = { ...schedule, version: 4, enabled: false };
  saved(client, newer);
  pending.reply.reject(new Error("POST failed."));
  await expect(pending.request).rejects.toThrow("POST failed.");
  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([newer]);
});

test("a failed toggle restores only its row and preserves another row's stream update", async () => {
  const client = new QueryClient();
  const other = { ...schedule, slug: "digest" };
  client.setQueryData(keys.schedules("/work"), [schedule, other]);
  const pending = pendingToggle(client);
  await pending.started;
  const newer = { ...other, version: 4 };
  saved(client, newer);
  pending.reply.reject(new Error("POST failed."));
  await expect(pending.request).rejects.toThrow("POST failed.");
  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([schedule, newer]);
});

test("a failed toggle preserves a same-version fire delivered during its POST", async () => {
  const client = new QueryClient();
  client.setQueryData(keys.schedules("/work"), [schedule]);
  const pending = pendingToggle(client);
  await pending.started;

  const fired = {
    ...schedule,
    enabled: false,
    lastFireKey: "fire-1",
    nextFireAt: "2026-10-17T12:00:00.000Z",
  };

  applyBatch(client, [
    {
      entity: "schedule",
      kind: "fired",
      runId: null,
      sequence: 11,
      txn: "t1",
      at: "2026-10-17T10:00:00.000Z",
      record: fired,
    },
  ]);
  pending.reply.reject(new Error("POST failed."));
  await expect(pending.request).rejects.toThrow("POST failed.");
  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([fired]);
});
