import { describe, expect, test } from "bun:test";
import type { RuntimeEvent, Schedule, StepRecord, WaitingHookStep } from "../src/core/index.js";
import { SqliteRunStore } from "../src/local/index.js";
import { activate, MemoryRunStore, type RunStore } from "../src/runtime/index.js";
import { FakeExecutor, newRun } from "./fixture.js";

const start = Date.parse(newRun().createdAt);

const factories = [
  { name: "memory", make: (now: () => number) => new MemoryRunStore(now) },
  { name: "sqlite", make: (now: () => number) => new SqliteRunStore(":memory:", now) },
];

function runningStep(seq = 1): Extract<StepRecord, { status: "running" }> {
  return {
    runId: "run",
    seq,
    key: `step-${seq}`,
    kind: "function",
    input: null,
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    startedAt: newRun().createdAt,
  };
}

function waitingStep(): WaitingHookStep {
  return {
    ...runningStep(),
    kind: "hook",
    key: "hook:approve",
    status: "waiting",
    input: { name: "approve", token: "hook-token" },
  };
}

function schedule(): Schedule {
  return {
    workspace: "/workspace",
    slug: "test",
    cron: "* * * * *",
    tz: "UTC",
    input: null,
    enabled: true,
    nextFireAt: newRun().createdAt,
  };
}

function order(events: RuntimeEvent[]) {
  return events.map(({ entity, kind, runId }) => [entity, kind, runId]);
}

async function trace(store: RunStore): Promise<RuntimeEvent[]> {
  await store.createRun(newRun());
  await store.claim("run", "owner");
  await store.putStep("run", "owner", runningStep());
  await store.appendLog("run", "owner", {
    runId: "run",
    seq: 1,
    position: { kind: "step", seq: 1, attempt: 1, index: 1 },
    level: "info",
    message: "working",
    at: newRun().createdAt,
  });
  await store.putStep("run", "owner", {
    ...runningStep(),
    status: "succeeded",
    output: 1,
    endedAt: newRun().createdAt,
    finishOrder: 1,
  });
  await store.putStep("run", "owner", runningStep(2));
  await store.putStep("run", "owner", {
    ...runningStep(2),
    status: "succeeded",
    output: 2,
    endedAt: newRun().createdAt,
    finishOrder: 2,
  });
  await store.finishRun("run", "owner", { status: "succeeded", output: 2 });

  return store.events(0, 100);
}

for (const { name, make } of factories) {
  describe(`${name} event outbox`, () => {
    test("run trace persists ordered records with one transaction per call", async () => {
      const store = make(() => start);

      try {
        const events = await trace(store);
        expect(order(events)).toEqual([
          ["run", "created", "run"],
          ["run", "claimed", "run"],
          ["step", "running", "run"],
          ["log", "written", "run"],
          ["step", "succeeded", "run"],
          ["step", "running", "run"],
          ["step", "succeeded", "run"],
          ["run", "finished", "run"],
        ]);
        expect(new Set(events.map((event) => event.txn)).size).toBe(8);
        expect(
          events.every((event, index) => event.sequence > (events[index - 1]?.sequence ?? 0)),
        ).toBe(true);
        expect(events.every((event) => event.at === newRun().createdAt)).toBe(true);
        expect(events[0]?.record).toEqual(newRun());
        expect(events[7]?.record).toEqual(await store.getRun("run"));
        expect(await store.events(events[2]?.sequence ?? 0, 2)).toEqual(events.slice(3, 5));
        expect(await store.events(0, 0)).toEqual([]);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("hooks batch waiting and creation, then resolution and wake without completing the step", async () => {
      const store = make(() => start);

      try {
        await store.createRun(newRun());
        await store.claim("run", "owner");
        await store.createHook("run", "owner", waitingStep());
        const created = await store.events(2, 10);
        expect(order(created)).toEqual([
          ["step", "waiting", "run"],
          ["hook", "created", "run"],
        ]);
        expect(new Set(created.map((event) => event.txn)).size).toBe(1);
        expect(await store.resolveHook("unknown", null)).toBe(false);
        expect(await store.events(4, 10)).toEqual([]);
        expect(await store.resolveHook("hook-token", { approved: true })).toBe(true);
        const resolved = await store.events(4, 10);
        expect(order(resolved)).toEqual([
          ["hook", "resolved", "run"],
          ["run", "woken", "run"],
        ]);
        expect(new Set(resolved.map((event) => event.txn)).size).toBe(1);
        expect(resolved[0]?.txn).not.toBe(created[0]?.txn);
        expect(resolved[0]?.record).toEqual((await store.listHooks("run"))[0]);
        expect(resolved[1]?.record).toEqual(await store.getRun("run"));
        expect((await store.getSteps("run"))[0]?.status).toBe("waiting");
        expect(await store.resolveHook("hook-token", null)).toBe(false);
        expect(await store.events(6, 10)).toEqual([]);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("stale takeover batches recovery, release and claim", async () => {
      let time = start;
      const store = make(() => time);

      try {
        await store.createRun({
          ...newRun(),
          status: "running",
          owner: { token: "dead", host: "other-host", pid: 1, heartbeatAt: newRun().createdAt },
        });
        await store.putStep("run", "dead", runningStep());
        time += 60_001;
        await store.claim("run", "next");
        const events = await store.events(2, 10);
        expect(order(events)).toEqual([
          ["step", "retrying", "run"],
          ["run", "released", "run"],
          ["run", "claimed", "run"],
        ]);
        expect(new Set(events.map((event) => event.txn)).size).toBe(1);
        expect(events[0]?.record).toMatchObject({
          attempt: 1,
          nextRetryAt: new Date(time).toISOString(),
        });
        expect(events[1]?.record).not.toHaveProperty("owner");
        expect(events[2]?.record).toMatchObject({ owner: { token: "next" }, status: "running" });
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("schedule fires once and deletion only emits for an existing row", async () => {
      const store = make(() => start);

      try {
        await store.putSchedule(schedule());
        expect(
          await store.fireSchedule("/workspace", "test", "fire-1", newRun(), newRun().createdAt),
        ).toBe(true);
        expect(
          await store.fireSchedule("/workspace", "test", "fire-1", newRun(), newRun().createdAt),
        ).toBe(false);
        const events = await store.events(0, 10);
        expect(order(events)).toEqual([
          ["schedule", "saved", null],
          ["run", "created", "run"],
          ["schedule", "fired", null],
        ]);
        expect(events[1]?.txn).toBe(events[2]?.txn);
        expect(events[0]?.txn).not.toBe(events[1]?.txn);
        expect(events[2]?.record).toEqual((await store.listSchedules())[0]);
        await store.deleteSchedule("/workspace", "test");
        await store.deleteSchedule("/workspace", "test");
        expect(await store.events(3, 10)).toMatchObject([
          {
            entity: "schedule",
            kind: "deleted",
            runId: null,
            record: { workspace: "/workspace", slug: "test" },
          },
        ]);
        expect(await store.listSchedules()).toEqual([]);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("subscribers see committed batches, survive throwing listeners and unsubscribe", async () => {
      const store = make(() => start);

      try {
        const batches: RuntimeEvent[][] = [];
        const reads: ReturnType<RunStore["getRun"]>[] = [];
        store.subscribe(() => {
          throw new Error("Listener failed.");
        });

        const unsubscribe = store.subscribe((events) => {
          batches.push(events);
          reads.push(store.getRun("run"));
        });

        await store.createRun(newRun());
        expect(await reads[0]).toEqual(newRun());
        await store.claim("run", "owner");
        await store.createHook("run", "owner", waitingStep());
        expect(batches.map((batch) => batch.length)).toEqual([1, 1, 2]);
        unsubscribe();
        await store.resolveHook("hook-token", null);
        expect(batches).toHaveLength(3);
        expect(await store.events(0, 10)).toHaveLength(6);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("snapshots include the rows, epoch and global event cursor at read time", async () => {
      const store = make(() => start);

      try {
        const events = await trace(store);
        expect(await store.snapshotRun("missing")).toBeUndefined();
        const snapshot = await store.snapshotRun("run");
        expect(snapshot).toMatchObject({
          run: await store.getRun("run"),
          steps: await store.getSteps("run"),
          logs: await store.getLogs("run"),
          hooks: [],
          cursor: events.at(-1)?.sequence,
          epoch: await store.epoch(),
        });
        await store.createRun({ ...newRun(), id: "other" });
        expect((await store.snapshotRun("run"))?.cursor).toBe(9);
        expect(snapshot?.cursor).toBe(8);
        await store.release("run", "owner");
        expect((await store.snapshotRun("run"))?.cursor).toBe(10);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("no-op and fenced writes emit nothing; expiry and release emit their changes", async () => {
      const store = make(() => start);

      try {
        await store.createRun(newRun());
        await store.claim("run", "owner");
        await store.putStep("run", "owner", runningStep());
        await store.putStep("run", "owner", runningStep());
        expect(await store.heartbeat("run", "wrong")).toBe(false);
        await expect(store.putStep("run", "wrong", runningStep())).rejects.toThrow(
          "not owned by this token",
        );
        await store.acquireRateLimit("key", 1, 1000, newRun().createdAt);
        await store.acquireRateLimit("key", 1, 1000, newRun().createdAt);
        expect(await store.events(3, 10)).toEqual([]);
        await store.heartbeat("run", "owner");
        await store.createHook("run", "owner", {
          ...waitingStep(),
          seq: 2,
          wakeAt: newRun().createdAt,
        });
        expect(await store.expireHook("run", "owner", 2)).toBe(newRun().createdAt);
        const expired = await store.events(0, 100);
        expect(await store.expireHook("run", "owner", 2)).toBe(newRun().createdAt);
        expect(await store.events(0, 100)).toEqual(expired);
        await store.release("run", "owner");
        const events = await store.events(3, 10);
        expect(order(events)).toEqual([
          ["run", "heartbeat", "run"],
          ["step", "waiting", "run"],
          ["hook", "created", "run"],
          ["hook", "expired", "run"],
          ["run", "released", "run"],
          ["run", "suspended", "run"],
        ]);
        expect(events.at(-1)?.txn).toBe(events.at(-2)?.txn);
        expect(events.at(-1)?.record).toEqual(await store.getRun("run"));
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("an owner recovers a hook expired before the terminal step write", async () => {
      const store = make(() => start);

      try {
        await store.createRun(newRun());
        await store.claim("run", "owner");
        await store.createHook("run", "owner", {
          ...waitingStep(),
          maxAttempts: 1,
          wakeAt: newRun().createdAt,
        });
        expect(await store.expireHook("run", "owner", 1)).toBe(newRun().createdAt);
        expect(await store.expireHook("run", "owner", 1)).toBe(newRun().createdAt);
        await store.release("run", "owner");

        const outcome = await activate({
          store,
          runId: "run",
          executor: new FakeExecutor(),
          cwd: "/workspace",
          mode: "sandbox",
          clock: { now: () => start, timeout: () => () => {} },
          workflow: (ctx) => ctx.hook("approve", { timeout: "1s" }),
        });

        expect(outcome.status).toBe("failed");
        expect((await store.getSteps("run"))[0]).toMatchObject({
          status: "failed",
          finishOrder: 1,
          error: `Hook 'approve' timed out at ${newRun().createdAt}. Resolve the hook before its deadline in a new run.`,
        });
        expect(
          (await store.events(0, 100)).filter((event) => event.kind === "expired"),
        ).toHaveLength(1);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("snapshot keeps the global cursor after every event is pruned", async () => {
      let time = start;
      const store = make(() => time);

      try {
        await store.createRun(newRun());
        await store.claim("run", "owner");
        const last = (await store.events(0, 100)).at(-1)?.sequence;
        time += 86_400_001;
        expect(await store.pruneEvents(new Date(time).toISOString())).toBe(2);
        expect(await store.events(0, 100)).toEqual([]);
        const cursor = (await store.snapshotRun("run"))?.cursor;
        expect(cursor).toBe(last);
        await store.heartbeat("run", "owner");
        expect((await store.events(0, 100))[0]?.sequence).toBe((cursor ?? 0) + 1);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("retention removes old rows but keeps the exact 24-hour boundary and monotonic sequence", async () => {
      let time = start;
      const store = make(() => time);

      try {
        await store.createRun(newRun());
        time += 1;
        await store.claim("run", "owner");
        time += 86_400_000;
        expect(await store.pruneEvents(new Date(time).toISOString())).toBe(1);
        expect((await store.events(0, 10)).map((event) => event.sequence)).toEqual([2]);
        expect(await store.pruneEvents(new Date(time).toISOString())).toBe(0);
        await store.heartbeat("run", "owner");
        expect((await store.events(2, 10))[0]?.sequence).toBe(3);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    });

    test("retention also bounds recent rows to the newest 100000", async () => {
      const store = make(() => start);

      try {
        await store.createRun(newRun());
        await store.claim("run", "owner");

        for (let index = 0; index < 100_001; index++) {
          await store.heartbeat("run", "owner");
        }

        expect(await store.pruneEvents(newRun().createdAt)).toBe(3);
        const events = await store.events(0, 100_010);
        expect(events).toHaveLength(100_000);
        expect(events[0]?.sequence).toBe(4);
        expect(events.at(-1)?.sequence).toBe(100_003);
      } finally {
        if (store instanceof SqliteRunStore) {
          store.close();
        }
      }
    }, 30_000);
  });
}

test("both stores emit the same entity, kind and runId order", async () => {
  const memory = new MemoryRunStore(() => start);
  const sqlite = new SqliteRunStore(":memory:", () => start);

  try {
    expect(order(await trace(sqlite))).toEqual(order(await trace(memory)));
    const step = { ...runningStep(3), input: { a: 1, b: [2, 3] } };

    for (const store of [memory, sqlite]) {
      await store.putStep("run", "owner", { ...step, input: { a: 1, b: [2, 3] } });
      const before = await store.events(0, 100);
      await store.putStep("run", "owner", {
        input: { b: [2, 3], a: 1 },
        status: step.status,
        startedAt: step.startedAt,
        maxAttempts: step.maxAttempts,
        attempt: step.attempt,
        kind: step.kind,
        key: step.key,
        seq: step.seq,
        runId: step.runId,
      });
      expect(await store.events(0, 100)).toEqual(before);
    }
  } finally {
    sqlite.close();
  }
});

test("engine replay emits no duplicate memoized steps or logs", async () => {
  const store = new MemoryRunStore(() => start);
  await store.createRun(newRun());
  let calls = 0;

  const execute = () =>
    activate({
      store,
      runId: "run",
      executor: new FakeExecutor(),
      cwd: "/workspace",
      mode: "sandbox",
      workflow: async (ctx) => {
        await ctx.step("one", ({ log }) => {
          calls++;
          log.info("working");

          return 1;
        });
        await ctx.hook("continue");

        return ctx.step("two", () => {
          calls++;

          return 2;
        });
      },
    });

  expect((await execute()).status).toBe("suspended");
  expect(await store.resolveHook((await store.listHooks("run"))[0]?.token ?? "", null)).toBe(true);
  expect(await execute()).toEqual({ status: "succeeded", output: 2 });
  expect(calls).toBe(2);
  const events = await store.events(0, 100);
  expect(events.filter((event) => event.entity === "log")).toHaveLength(1);
  expect(
    events
      .filter((event) => event.entity === "step" && event.record.key === "one")
      .map((event) => event.kind),
  ).toEqual(["running", "succeeded"]);
  expect(
    events
      .filter((event) => event.entity === "step" && event.record.key === "two")
      .map((event) => event.kind),
  ).toEqual(["running", "succeeded"]);
});
