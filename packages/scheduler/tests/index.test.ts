import { describe, expect, test } from "bun:test";
import { CronTriggerV1Schema, WorkflowDefinitionSchema } from "@loopy/contracts";
import {
  MemorySchedulerStore,
  nextOccurrence,
  occurrencesBetween,
  previousOccurrence,
  type ScheduleDefinition,
  type ScheduleExecution,
  type ScheduleInvocation,
  SchedulerEngine,
  type SchedulerExecutor,
} from "../src/index.js";

const scheduleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workflowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function definition(
  expression = "*/5 * * * *",
  overrides: Partial<ScheduleDefinition["schedule"]> = {},
): ScheduleDefinition {
  return {
    workflowId,
    workflowVersion: 2,
    manual: true,
    schedule: {
      schemaVersion: "1",
      scheduleId,
      expression,
      timezone: "UTC",
      enabled: true,
      overlap: "skip",
      missed: "run_once",
      input: { from: "cron" },
      ...overrides,
    },
  };
}

function harness(schedule: ScheduleDefinition) {
  const started: ScheduleInvocation[] = [];
  const cancelled: ScheduleExecution[] = [];
  let nextId = 0;
  const executor: SchedulerExecutor = {
    async start(invocation) {
      started.push(invocation);
      nextId += 1;
      return { executionId: `execution-${nextId}` };
    },
    async cancel(execution) {
      cancelled.push(execution);
    },
  };
  const store = new MemorySchedulerStore([schedule]);
  const engine = new SchedulerEngine({ store, executor, id: () => `id-${nextId + 1}` });
  return { engine, store, started, cancelled };
}

describe("versioned schedule contracts", () => {
  test("accepts five fields and rejects aliases, six fields, ranges, and invalid zones", () => {
    expect(
      CronTriggerV1Schema.safeParse({
        schemaVersion: "1",
        scheduleId,
        expression: "0 9 * * 1-5",
        timezone: "America/New_York",
      }).success,
    ).toBe(true);
    for (const expression of ["@daily", "0 9 * * * *", "0 9 0 * *", "0 9 * 13 *"]) {
      expect(
        CronTriggerV1Schema.safeParse({
          schemaVersion: "1",
          scheduleId,
          expression,
          timezone: "UTC",
        }).success,
      ).toBe(false);
    }
    expect(
      CronTriggerV1Schema.safeParse({
        schemaVersion: "1",
        scheduleId,
        expression: "0 9 * * *",
        timezone: "Mars/Olympus",
      }).success,
    ).toBe(false);
  });

  test("workflow defaults preserve manual-only workflows while accepting cron", () => {
    const workflow = {
      schemaVersion: "1",
      workflowVersion: 1,
      id: workflowId,
      name: "scheduled",
      nodes: [
        {
          id: scheduleId,
          name: "verify",
          kind: "verify",
          commands: [{ command: "bun" }],
        },
      ],
      defaults: { provider: "codex" },
      metadata: {
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
      triggers: {
        manual: { enabled: true, input: { source: "button" } },
        cron: {
          schemaVersion: "1",
          scheduleId,
          expression: "0 9 * * 1-5",
          timezone: "UTC",
          overlap: "queue",
          missed: "run_once",
        },
      },
    };
    expect(WorkflowDefinitionSchema.parse(workflow).triggers.cron?.overlap).toBe("queue");
    expect(
      WorkflowDefinitionSchema.parse({ ...workflow, triggers: undefined }).triggers.manual,
    ).toBe(true);
  });
});

describe("schedule calculations", () => {
  test("calculates deterministic UTC next/previous occurrences", () => {
    const schedule = definition("0 9 * * 1-5").schedule;
    expect(nextOccurrence(schedule, new Date("2026-08-17T08:00:00.000Z")).toISOString()).toBe(
      "2026-08-17T09:00:00.000Z",
    );
    expect(previousOccurrence(schedule, new Date("2026-08-18T08:00:00.000Z")).toISOString()).toBe(
      "2026-08-17T09:00:00.000Z",
    );
    expect(
      occurrencesBetween(
        definition("0 * * * *").schedule,
        new Date("2026-08-17T00:00:00.000Z"),
        new Date("2026-08-17T03:00:00.000Z"),
      ),
    ).toHaveLength(4);
  });

  test("handles spring-forward by advancing a nonexistent local time", () => {
    const schedule = definition("0 2 * * *", { timezone: "America/New_York" }).schedule;
    expect(nextOccurrence(schedule, new Date("2026-03-08T06:00:00.000Z")).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
  });

  test("handles fall-back without firing the repeated local hour twice", () => {
    const schedule = definition("30 1 * * *", { timezone: "America/New_York" }).schedule;
    const occurrences = occurrencesBetween(
      schedule,
      new Date("2026-11-01T04:00:00.000Z"),
      new Date("2026-11-01T08:00:00.000Z"),
    );
    expect(occurrences.map((date) => date.toISOString())).toEqual(["2026-11-01T05:30:00.000Z"]);
  });
});

describe("scheduler policy", () => {
  test("fires at most one missed run and duplicate ticks are idempotent", async () => {
    const { engine, started } = harness(definition());
    const first = await engine.tick(new Date("2026-08-17T00:01:00.000Z"));
    expect(first.decisions[0]?.action).toBe("not_due");
    const result = await engine.tick(new Date("2026-08-17T00:17:00.000Z"));
    expect(result.decisions[0]?.action).toBe("started");
    expect(started).toHaveLength(1);
    expect(started[0]?.scheduledFor).toBe("2026-08-17T00:15:00.000Z");
    const duplicate = await engine.tick(new Date("2026-08-17T00:17:00.000Z"));
    expect(duplicate.decisions[0]?.action).toBe("not_due");
    expect(started).toHaveLength(1);
  });

  test("skip missed policy advances without starting", async () => {
    const { engine, started } = harness(definition("*/5 * * * *", { missed: "skip" }));
    await engine.tick(new Date("2026-08-17T00:01:00.000Z"));
    const result = await engine.tick(new Date("2026-08-17T00:17:00.000Z"));
    expect(result.decisions[0]?.action).toBe("not_due");
    expect(started).toHaveLength(0);
  });

  test("queue permits one pending invocation and hands it off on completion", async () => {
    const { engine, started } = harness(definition("*/5 * * * *", { overlap: "queue" }));
    await engine.tick(new Date("2026-08-17T00:01:00.000Z"));
    await engine.tick(new Date("2026-08-17T00:05:00.000Z"));
    await engine.tick(new Date("2026-08-17T00:10:00.000Z"));
    await engine.tick(new Date("2026-08-17T00:15:00.000Z"));
    expect(started).toHaveLength(1);
    const handedOff = await engine.complete(scheduleId, "execution-1");
    expect(handedOff?.scheduledFor).toBe("2026-08-17T00:10:00.000Z");
    expect(started).toHaveLength(2);
    const state = await engine.complete(scheduleId, "execution-2");
    expect(state).toBeUndefined();
  });

  test("cancel_previous cancels before starting and manual fire merges input", async () => {
    const { engine, started, cancelled } = harness(
      definition("*/5 * * * *", { overlap: "cancel_previous" }),
    );
    await engine.tick(new Date("2026-08-17T00:01:00.000Z"));
    await engine.tick(new Date("2026-08-17T00:05:00.000Z"));
    await engine.tick(new Date("2026-08-17T00:10:00.000Z"));
    expect(cancelled).toHaveLength(1);
    expect(started).toHaveLength(2);
    expect(cancelled[0]?.executionId).toBe("execution-1");
    const manual = await engine.fire(
      scheduleId,
      { from: "manual", urgent: true },
      new Date("2026-08-17T01:00:00.000Z"),
    );
    expect(manual.action).toBe("cancelled_previous");
    expect(started[2]?.input).toEqual({ from: "manual", urgent: true });
  });

  test("manual trigger can be disabled", async () => {
    const schedule = definition();
    schedule.manual = { enabled: false, input: {} };
    const { engine, started } = harness(schedule);
    expect((await engine.fire(scheduleId)).action).toBe("disabled");
    expect(started).toHaveLength(0);
  });

  test("manual trigger input is used as the default for manual fires", async () => {
    const schedule = definition();
    schedule.manual = { enabled: true, input: { source: "button", priority: "normal" } };
    const { engine, started } = harness(schedule);
    await engine.fire(scheduleId, { priority: "urgent" }, new Date("2026-08-17T01:00:00.000Z"));
    expect(started[0]?.input).toEqual({ source: "button", priority: "urgent" });
  });
});
