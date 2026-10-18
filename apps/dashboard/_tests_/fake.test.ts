import { expect, test } from "bun:test";
import { fakeBackend } from "../src/backend/fake.ts";

test("an undeclared schedule can be created from the PUT body on an empty page", async () => {
  const backend = fakeBackend({
    epoch: "e1",
    runs: [],
    schedules: [],
    batches: [],
    intervalMs: 0,
    loopies: [
      {
        slug: "triage",
        description: null,
        scope: "project",
        mode: "sandbox",
        input: {},
        schedule: null,
        lastRun: null,
        counts: { queued: 0, running: 0, suspended: 0, succeeded: 0, failed: 0, cancelled: 0 },
      },
    ],
  });

  expect(await backend.schedules()).toEqual([]);
  const body = { cron: "@daily", tz: "Asia/Kolkata", input: { name: "Hatim" }, enabled: false };
  const created = await backend.putSchedule("triage", body);
  expect(created).toMatchObject({ ...body, slug: "triage", version: 1 });
  expect(await backend.schedules()).toEqual([created]);
});
