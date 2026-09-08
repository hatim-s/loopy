import { expect, test } from "bun:test";
import { MemorySchedulerStore, type ScheduleDefinition, SchedulerEngine } from "../src/index.ts";

const definition: ScheduleDefinition = {
  workflowId: "w",
  workflowVersion: 1,
  manual: true,
  schedule: {
    schemaVersion: "1",
    scheduleId: "s",
    expression: "* * * * *",
    timezone: "UTC",
    enabled: true,
    overlap: "skip",
    missed: "skip",
    input: {},
  },
};
test("offset polling starts once, idle polls do not write, and real outages skip", async () => {
  const store = new MemorySchedulerStore([definition]);
  let writes = 0;
  const save = store.saveState.bind(store);
  store.saveState = async (state) => {
    writes++;
    await save(state);
  };
  let starts = 0;
  const engine = new SchedulerEngine({
    store,
    executor: { start: async () => ({ executionId: `r${++starts}` }), cancel: async () => {} },
  });
  await engine.tick(new Date("2026-01-01T00:00:59.200Z"));
  const initialized = writes;
  await engine.tick(new Date("2026-01-01T00:00:59.500Z"));
  expect(writes).toBe(initialized);
  await engine.tick(new Date("2026-01-01T00:01:00.200Z"));
  await engine.tick(new Date("2026-01-01T00:01:00.500Z"));
  expect(starts).toBe(1);
  await engine.complete("s", "r1");
  await engine.tick(new Date("2026-01-01T00:04:00.200Z"));
  expect(starts).toBe(1);
});
test("manual and cron claim/start decisions serialize across a held start", async () => {
  const store = new MemorySchedulerStore([definition]);
  let release!: () => void;
  let starts = 0;
  const engine = new SchedulerEngine({
    store,
    executor: {
      start: async () => {
        starts++;
        await new Promise<void>((r) => {
          release = r;
        });
        return { executionId: "r" };
      },
      cancel: async () => {},
    },
  });
  const first = engine.fire("s", {}, new Date("2026-01-01T00:00:00Z"));
  for (let i = 0; i < 50 && !release; i++) await Bun.sleep(2);
  const second = engine.tick(new Date("2026-01-01T00:01:00Z"));
  await Bun.sleep(15);
  expect(starts).toBe(1);
  release();
  await Promise.all([first, second]);
  expect(starts).toBe(1);
});
