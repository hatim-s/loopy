import { expect, expectTypeOf, test } from "bun:test";
import * as contract from "../src/contract/index.js";
import type * as core from "../src/core/index.js";
import type { SavedLoopy } from "../src/local/saved-loopy.js";
import { fixture, newRun } from "./fixture.js";

const now = newRun().createdAt;

const leaseMs = 60_000;

function view(run: core.RunRecord, steps: core.StepRecord[] = [], hooks: core.HookRecord[] = []) {
  return contract.runView({ run, steps, hooks, now, leaseMs });
}

test("schema outputs and core records remain assignable in both directions", () => {
  expectTypeOf<contract.Json>().toMatchTypeOf<core.Json>();
  expectTypeOf<core.Json>().toMatchTypeOf<contract.Json>();
  expectTypeOf<contract.RunStatus>().toMatchTypeOf<core.RunStatus>();
  expectTypeOf<core.RunStatus>().toMatchTypeOf<contract.RunStatus>();
  expectTypeOf<contract.RunOutcome>().toMatchTypeOf<core.RunOutcome>();
  expectTypeOf<core.RunOutcome>().toMatchTypeOf<contract.RunOutcome>();
  expectTypeOf<contract.StepRecord>().toMatchTypeOf<core.StepRecord>();
  expectTypeOf<core.StepRecord>().toMatchTypeOf<contract.StepRecord>();
  expectTypeOf<contract.LogPosition>().toMatchTypeOf<core.LogPosition>();
  expectTypeOf<core.LogPosition>().toMatchTypeOf<contract.LogPosition>();
  expectTypeOf<contract.LogRecord>().toMatchTypeOf<core.LogRecord>();
  expectTypeOf<core.LogRecord>().toMatchTypeOf<contract.LogRecord>();
  expectTypeOf<contract.HookRecord>().toMatchTypeOf<core.HookRecord>();
  expectTypeOf<core.HookRecord>().toMatchTypeOf<contract.HookRecord>();
  expectTypeOf<contract.Schedule>().toMatchTypeOf<core.Schedule>();
  expectTypeOf<core.Schedule>().toMatchTypeOf<contract.Schedule>();

  type WireEvent =
    | Exclude<core.RuntimeEvent, { entity: "run" }>
    | (Omit<Extract<core.RuntimeEvent, { entity: "run" }>, "record"> & {
        record: contract.RunView;
      });

  expectTypeOf<contract.ServerEvent>().toMatchTypeOf<WireEvent>();
  expectTypeOf<WireEvent>().toMatchTypeOf<contract.ServerEvent>();
  expectTypeOf<SavedLoopy>().toMatchTypeOf<Parameters<typeof contract.loopyView>[0]>();
});

test("engine records and events round-trip through wire schemas across a hook replay", async () => {
  const f = await fixture();

  const workflow: Parameters<typeof f.execute>[0] = async (ctx) => {
    await ctx.step("one", ({ log }) => {
      log.info("working", { nested: [null, true, 1, "text"] });

      return 1;
    });
    await ctx.hook("approve");

    return ctx.step("two", () => 2);
  };

  expect((await f.execute(workflow)).status).toBe("suspended");
  const suspended = await f.store.snapshotRun("run");

  if (!suspended) {
    throw new Error("Expected a persisted snapshot.");
  }

  expect(view(suspended.run, suspended.steps, suspended.hooks)).toMatchObject({
    status: "suspended",
    wakeAt: null,
    waitingOn: { hook: "approve", expiresAt: null },
  });
  await f.store.resolveHook(suspended.hooks[0]?.token ?? "", { approved: true });
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: 2 });
  const snapshot = await f.store.snapshotRun("run");

  if (!snapshot) {
    throw new Error("Expected a persisted snapshot.");
  }

  for (const step of snapshot.steps) {
    expect(contract.stepRecordSchema.parse(step)).toEqual(step);
  }

  for (const log of snapshot.logs) {
    expect(contract.logRecordSchema.parse(log)).toEqual(log);
  }

  for (const hook of snapshot.hooks) {
    expect(contract.hookRecordSchema.parse(hook)).toEqual(hook);
  }

  const wireSnapshot = { ...snapshot, run: view(snapshot.run, snapshot.steps, snapshot.hooks) };
  expect(contract.runSnapshotViewSchema.parse(wireSnapshot)).toEqual(wireSnapshot);

  await f.store.putSchedule({
    workspace: "/workspace",
    slug: "test",
    cron: "* * * * *",
    tz: "UTC",
    input: null,
    enabled: true,
    nextFireAt: now,
  });
  await f.store.deleteSchedule("/workspace", "test");

  for (const event of await f.store.events(0, 100)) {
    const wire = contract.serverEvent(event, (run) => view(run, snapshot.steps, snapshot.hooks));
    expect(contract.serverEventSchema.parse(wire)).toEqual(wire);

    if (wire.entity === "run") {
      expect(wire.record.owner).not.toHaveProperty("token");
    }
  }
});

const waiting: core.StepRecord = {
  runId: "run",
  seq: 2,
  key: "hook:approve",
  kind: "hook",
  input: { name: "approve", token: "hook" },
  status: "waiting",
  attempt: 1,
  maxAttempts: 1,
  startedAt: now,
};

const hook: core.HookRecord = {
  token: "hook",
  runId: "run",
  seq: 2,
  name: "approve",
  createdAt: now,
};

test("views strip fencing tokens and derive staleness at the lease boundary", () => {
  const run: core.RunRecord = {
    ...newRun(),
    status: "running",
    owner: { token: "secret", pid: 1, host: "host", heartbeatAt: now },
  };

  const derived = view(run);
  expect(derived.owner).toEqual({ pid: 1, host: "host", heartbeatAt: now });
  expect(derived.owner).not.toHaveProperty("token");
  expect(contract.runViewSchema.parse({ ...derived, owner: run.owner }).owner).not.toHaveProperty(
    "token",
  );
  expect(derived.ownerStale).toBe(false);
  expect(
    contract.runView({
      run,
      steps: [],
      hooks: [],
      now: new Date(Date.parse(now) + leaseMs).toISOString(),
      leaseMs,
    }).ownerStale,
  ).toBe(false);
  expect(
    contract.runView({
      run,
      steps: [],
      hooks: [],
      now: new Date(Date.parse(now) + leaseMs + 1).toISOString(),
      leaseMs,
    }).ownerStale,
  ).toBe(true);
  expect(view(newRun())).toMatchObject({ owner: null, ownerStale: false });
});

test("waitingOn uses only the latest waiting hook step and an unresolved unexpired hook", () => {
  const run = { ...newRun(), status: "suspended" } satisfies core.RunRecord;
  expect(view(run, [waiting], [hook]).waitingOn).toEqual({
    hook: "approve",
    token: "hook",
    seq: 2,
    expiresAt: null,
  });
  const future = new Date(Date.parse(now) + 1000).toISOString();
  expect(view(run, [{ ...waiting, wakeAt: future }], [hook]).waitingOn?.expiresAt).toBe(future);
  expect(view(run, [{ ...waiting, wakeAt: now }], [hook]).waitingOn).toBeNull();
  expect(view(run, [waiting], [{ ...hook, resolvedAt: now }]).waitingOn).toBeNull();
  expect(view(run, [waiting], [{ ...hook, expiredAt: now }]).waitingOn).toBeNull();
  expect(view(run, [waiting], [{ ...hook, runId: "other" }]).waitingOn).toBeNull();
  expect(view(run, [waiting], [{ ...hook, seq: 1 }]).waitingOn).toBeNull();
  expect(view(run, [waiting], []).waitingOn).toBeNull();
  expect(view(run, [], [hook]).waitingOn).toBeNull();
  expect(view(run, [{ ...waiting, kind: "sleep" }], [hook]).waitingOn).toBeNull();
  expect(
    view(run, [waiting, { ...waiting, seq: 3, status: "running" }], [hook]).waitingOn,
  ).toBeNull();
  expect(
    view(run, [{ ...waiting, seq: 3, status: "running" }, waiting], [hook]).waitingOn,
  ).toBeNull();
});

test("loopy views count matching runs and choose the newest without leaking registry fields", () => {
  const saved: SavedLoopy = {
    slug: "test",
    scope: "project",
    input: { value: "number" },
    mode: "sandbox",
    source: "/private/source",
    secrets: ["SECRET"],
    bundleHash: "private",
    savedAt: now,
  };

  const newer = view({
    ...newRun(),
    id: "new",
    status: "succeeded",
    output: null,
    createdAt: "2026-10-17T00:00:00.000Z",
  });

  const schedule: core.Schedule = {
    workspace: "/workspace",
    slug: "test",
    cron: "* * * * *",
    tz: "UTC",
    enabled: true,
    input: null,
    nextFireAt: now,
  };

  const result = contract.loopyView(saved, schedule, [
    newer,
    view(newRun()),
    view({ ...newRun(), slug: "other" }),
  ]);

  expect(result.counts).toEqual({
    queued: 1,
    running: 0,
    suspended: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
  });
  expect(result.lastRun).toEqual(newer);
  expect(result.schedule).toEqual({
    cron: schedule.cron,
    tz: "UTC",
    enabled: true,
    nextFireAt: now,
  });
  expect(result).not.toHaveProperty("source");
  expect(result).not.toHaveProperty("secrets");
  expect(result).not.toHaveProperty("bundleHash");
  expect(contract.loopyViewSchema.parse(result)).toEqual(result);
  expect(contract.loopyView(saved, null, [])).toMatchObject({
    lastRun: null,
    schedule: null,
    counts: { queued: 0, succeeded: 0 },
  });
  expect(contract.scheduleSchema.parse(schedule)).toEqual(schedule);
});

test("route patterns are unique and every parameter has a schema", () => {
  const routes = Object.values(contract.routes);
  expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(routes.length);

  for (const route of routes) {
    const names = [...route.path.matchAll(/:([a-z]+)/g)].map((match) => match[0].slice(1));
    expect(Object.keys(route.params.shape).sort()).toEqual(names.sort());

    for (const name of names) {
      expect(route.params.safeParse({ [name]: "value" }).success).toBe(true);
      expect(route.params.safeParse({}).success).toBe(false);
    }
  }
});

test("edge schemas reject malformed variants, JSON and request values", () => {
  expect(contract.jsonSchema.safeParse({ value: undefined }).success).toBe(false);
  expect(contract.jsonSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  expect(contract.runViewSchema.safeParse({ ...view(newRun()), status: "succeeded" }).success).toBe(
    false,
  );
  expect(contract.stepRecordSchema.safeParse({ ...waiting, status: "succeeded" }).success).toBe(
    false,
  );
  expect(contract.runOutcomeSchema.parse({ status: "succeeded", output: null })).toEqual({
    status: "succeeded",
    output: null,
  });
  expect(contract.routes.runs.query.parse({ limit: "20", status: "queued" })).toEqual({
    limit: 20,
    status: "queued",
  });
  expect(contract.routes.runs.query.safeParse({ limit: "-1" }).success).toBe(false);
  expect(contract.routes.logs.query.parse({ after: "3" })).toEqual({ after: 3 });
  expect(contract.routes.events.query.safeParse({ after: "-1", epoch: "epoch" }).success).toBe(
    false,
  );
  expect(contract.routes.startRun.body.safeParse({}).success).toBe(false);
  expect(contract.routes.resolveHook.body.safeParse({}).success).toBe(false);
  expect(
    contract.errorBodySchema.safeParse({ error: { code: "unexpected", message: "oops" } }).success,
  ).toBe(false);
});
