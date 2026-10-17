import { expect, expectTypeOf, test } from "bun:test";
import * as contract from "../src/contract/index.js";
import type * as core from "../src/core/index.js";
import type { SavedLoopy } from "../src/local/saved-loopy.js";
import { fixture, newRun } from "./fixture.js";

type Flatten<T> = T extends unknown ? { [Key in keyof T]: T[Key] } : never;

const now = newRun().createdAt;

const leaseMs = 60_000;

const loopy = { slug: "test", description: null };

function view(run: core.RunRecord, steps: core.StepRecord[] = [], hooks: core.HookRecord[] = []) {
  return contract.runView({ run, loopy, steps, hooks, now, leaseMs });
}

test("schema outputs exactly match core records and the wire owner projection", () => {
  expectTypeOf<contract.Json>().toEqualTypeOf<core.Json>();
  expectTypeOf<contract.RunStatus>().toEqualTypeOf<core.RunStatus>();
  expectTypeOf<contract.RunOutcome>().toEqualTypeOf<core.RunOutcome>();
  expectTypeOf<contract.StepRecord>().toEqualTypeOf<Flatten<core.StepRecord>>();
  expectTypeOf<contract.LogPosition>().toEqualTypeOf<core.LogPosition>();
  expectTypeOf<contract.LogRecord>().toEqualTypeOf<core.LogRecord>();
  expectTypeOf<contract.HookRecord>().toEqualTypeOf<core.HookRecord>();
  expectTypeOf<contract.Schedule>().toEqualTypeOf<core.Schedule>();
  expectTypeOf<contract.RunView["owner"]>().toEqualTypeOf<Omit<
    NonNullable<core.RunRecord["owner"]>,
    "token"
  > | null>();

  type WireEvent =
    | Exclude<core.RuntimeEvent, { entity: "run" | "step" }>
    | (Omit<Extract<core.RuntimeEvent, { entity: "step" }>, "record"> & {
        record: Flatten<core.StepRecord>;
      })
    | (Omit<Extract<core.RuntimeEvent, { entity: "run" }>, "record"> & {
        record: contract.RunView;
      });

  expectTypeOf<contract.ServerEvent>().toEqualTypeOf<Flatten<WireEvent>>();
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

  expect(snapshot.steps.find((step) => step.kind === "hook")?.input).toEqual(
    suspended.steps.find((step) => step.kind === "hook")?.input,
  );

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
  expect(contract.runViewSchema.safeParse({ ...derived, owner: run.owner }).success).toBe(false);
  expect(derived.loopy).toEqual({ slug: "test", description: null });
  expect(derived.ownerStale).toBe(false);
  expect(
    contract.runView({
      run,
      loopy,
      steps: [],
      hooks: [],
      now: new Date(Date.parse(now) + leaseMs).toISOString(),
      leaseMs,
    }).ownerStale,
  ).toBe(false);
  expect(
    contract.runView({
      run,
      loopy,
      steps: [],
      hooks: [],
      now: new Date(Date.parse(now) + leaseMs + 1).toISOString(),
      leaseMs,
    }).ownerStale,
  ).toBe(true);
  expect(view(newRun())).toMatchObject({ owner: null, ownerStale: false });
});

test("waitingOn uses only the latest waiting hook step and an unresolved unexpired hook", () => {
  const run = {
    ...newRun(),
    status: "suspended",
    updatedAt: "2099-01-01T00:00:00.000Z",
  } satisfies core.RunRecord;

  expect(view(run, [waiting], [hook]).waitingOn).toEqual({
    hook: "approve",
    token: "hook",
    seq: 2,
    expiresAt: null,
    since: hook.createdAt,
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
    revision: 1,
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
  expect(contract.routes.runs.query.parse({ waiting: "false" })).toEqual({ waiting: false });
  expect(contract.routes.runs.query.parse({ waiting: "true" })).toEqual({ waiting: true });
  expect(contract.routes.runs.query.safeParse({ waiting: "yes" }).success).toBe(false);
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

test("cancelled engine runs no longer advertise their pending hook", async () => {
  const f = await fixture();
  expect((await f.execute((ctx) => ctx.hook("approve"))).status).toBe("suspended");
  const suspended = await f.store.snapshotRun("run");

  if (!suspended) {
    throw new Error("Expected a suspended run snapshot.");
  }

  expect(view(suspended.run, suspended.steps, suspended.hooks).waitingOn?.hook).toBe("approve");
  await f.store.claim("run", "canceller");
  await f.store.finishRun("run", "canceller", { status: "cancelled" });
  await f.store.release("run", "canceller");
  const cancelled = await f.store.snapshotRun("run");

  if (!cancelled) {
    throw new Error("Expected a cancelled run snapshot.");
  }

  expect(cancelled.run.status).toBe("cancelled");
  expect(cancelled.steps.some((step) => step.status === "waiting")).toBe(true);
  expect(cancelled.hooks.some((hook) => hook.resolvedAt === undefined)).toBe(true);
  expect(view(cancelled.run, cancelled.steps, cancelled.hooks).waitingOn).toBeNull();
});

test("serialized loopy and snapshot views exclude private registry and owner keys", () => {
  const run = view({
    ...newRun(),
    owner: { token: "private", pid: 1, host: "host", heartbeatAt: now },
  });

  const saved: SavedLoopy = {
    slug: "test",
    scope: "project",
    mode: "sandbox",
    input: {},
    source: "/private/source",
    secrets: ["SECRET"],
    bundleHash: "private",
    savedAt: now,
  };

  const loopy = contract.loopyView(saved, null, [run]);

  const snapshot: contract.RunSnapshotView = {
    run,
    steps: [],
    logs: [],
    hooks: [],
    cursor: 0,
    epoch: "epoch",
  };

  expect(contract.loopyViewSchema.parse(loopy)).toEqual(loopy);
  expect(contract.runSnapshotViewSchema.parse(snapshot)).toEqual(snapshot);

  for (const serialized of [JSON.stringify(loopy), JSON.stringify(snapshot)]) {
    expect(serialized).not.toMatch(/"(?:bundleHash|token|source|secrets)"\s*:/);
  }
});

test("strict edges reject misspelled request keys and injected view tokens", () => {
  expect(
    contract.routes.startRun.body.safeParse({ input: null, workspcae: "/workspace" }).success,
  ).toBe(false);
  expect(contract.runViewSchema.safeParse({ ...view(newRun()), token: "private" }).success).toBe(
    false,
  );

  const described = contract.runView({
    run: newRun(),
    loopy: { slug: "test", description: "Review approvals" },
    steps: [],
    hooks: [],
    now,
    leaseMs,
  });

  expect(described.loopy).toEqual({ slug: "test", description: "Review approvals" });
});

test("run cursors preserve timestamp ties and reject timestamp-only paging", async () => {
  const { encodeRunCursor, decodeRunCursor, runsQuerySchema } = await import(
    "../src/contract/index.js"
  );

  const cursor = encodeRunCursor({ createdAt: "2026-10-17T00:00:00.000Z", id: "run-b" });
  expect(decodeRunCursor(cursor)).toEqual({ createdAt: "2026-10-17T00:00:00.000Z", id: "run-b" });
  expect(runsQuerySchema.parse({ before: cursor })).toEqual({ before: cursor });
  expect(runsQuerySchema.safeParse({ before: "2026-10-17T00:00:00.000Z" }).success).toBe(false);
  expect(runsQuerySchema.safeParse({ before: `${cursor}|extra` }).success).toBe(false);
});

test("schedule wire fields normalize core nullability and preserve every field", () => {
  expectTypeOf<contract.ScheduleView>().toEqualTypeOf<
    Flatten<
      Omit<core.Schedule, "lastFireKey"> & {
        lastFireKey: string | null;
      }
    >
  >();
  expect(contract.putScheduleBodySchema.parse({})).toEqual({});

  for (const body of [
    { cron: 1 },
    { tz: null },
    { input: undefined, enabled: "false" },
    { typo: true },
  ]) {
    expect(contract.putScheduleBodySchema.safeParse(body).success).toBe(false);
  }

  expect(contract.scheduleEnabledBodySchema.safeParse({}).success).toBe(false);
  expect(contract.scheduleEnabledBodySchema.parse({ enabled: false })).toEqual({ enabled: false });
});

test("loopy declared schedule is visible until a persisted schedule overrides it", () => {
  const saved = {
    slug: "test",
    scope: "project",
    mode: "sandbox",
    input: {},
    schedule: { cron: "0 * * * *" },
  } satisfies Parameters<typeof contract.loopyView>[0];

  expect(contract.loopyView(saved, null, []).schedule).toEqual({
    cron: "0 * * * *",
    tz: "UTC",
    enabled: false,
    nextFireAt: null,
  });
  expect(
    contract.loopyView(
      saved,
      {
        revision: 1,
        workspace: "/workspace",
        slug: "test",
        cron: "*/5 * * * *",
        tz: "Asia/Kolkata",
        input: {},
        enabled: true,
        nextFireAt: now,
      },
      [],
    ).schedule,
  ).toEqual({ cron: "*/5 * * * *", tz: "Asia/Kolkata", enabled: true, nextFireAt: now });
});

test("cursor route rejects invalid cursors and extra response fields", () => {
  expect(contract.routes.cursor.method).toBe("GET");
  expect(contract.routes.cursor.path).toBe("/cursor");
  expect(contract.routes.cursor.response.parse({ cursor: 0, epoch: "epoch" })).toEqual({
    cursor: 0,
    epoch: "epoch",
  });

  for (const value of [
    { cursor: -1, epoch: "epoch" },
    { cursor: 0.5, epoch: "epoch" },
    { cursor: "0", epoch: "epoch" },
    { cursor: 0 },
    { cursor: 0, epoch: "epoch", extra: true },
  ]) {
    expect(contract.cursorViewSchema.safeParse(value).success).toBe(false);
  }
});
