import { expect, expectTypeOf, test } from "bun:test";
import * as contract from "../src/contract/index.js";
import type * as core from "../src/core/index.js";
import type { SavedLoopy } from "../src/local/saved-loopy.js";
import { newRun } from "./fixture.js";
import { approveDemoGraph } from "./fixtures/graphs.js";

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
    | Exclude<core.RuntimeEvent, { entity: "run" | "step" | "node" }>
    | (Omit<Extract<core.RuntimeEvent, { entity: "node" }>, "record"> & {
        record: Flatten<core.NodeRun>;
      })
    | Exclude<never, never>
    | (Omit<Extract<core.RuntimeEvent, { entity: "step" }>, "record"> & {
        record: Flatten<core.StepRecord>;
      })
    | (Omit<Extract<core.RuntimeEvent, { entity: "run" }>, "record"> & {
        record: contract.RunView;
      });

  expectTypeOf<contract.ServerEvent>().toEqualTypeOf<Flatten<WireEvent>>();
  expectTypeOf<SavedLoopy & { workspace: string }>().toMatchTypeOf<
    Parameters<typeof contract.loopyView>[0]
  >();
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
    version: 2,
    graph: approveDemoGraph,
    revision: "private",
    bundles: [],
    description: null,
    schedule: null,
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
    version: 1,
    workspace: "/workspace",
    slug: "test",
    cron: "* * * * *",
    tz: "UTC",
    enabled: true,
    input: null,
    nextFireAt: now,
  };

  const result = contract.loopyView({ ...saved, workspace: "/workspace" }, schedule, [
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
  expect(contract.loopyView({ ...saved, workspace: "/workspace" }, null, [])).toMatchObject({
    workspace: "/workspace",
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

    expect(
      route.params.safeParse(Object.fromEntries(names.map((parameter) => [parameter, "value"])))
        .success,
    ).toBe(true);

    if (names.length > 0) {
      expect(route.params.safeParse({}).success).toBe(false);
    }
  }
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
    version: 2,
    graph: approveDemoGraph,
    revision: "private",
    bundles: [],
    description: null,
    schedule: null,
    savedAt: now,
  };

  const loopy = contract.loopyView({ ...saved, workspace: "/workspace" }, null, [run]);

  const snapshot: contract.RunSnapshotView = {
    nodeRuns: [],
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

test("run cursors preserve timestamp ties and reject timestamp-only paging", () => {
  const cursor = contract.encodeRunCursor({ createdAt: "2026-10-17T00:00:00.000Z", id: "run-b" });
  expect(contract.decodeRunCursor(cursor)).toEqual({
    createdAt: "2026-10-17T00:00:00.000Z",
    id: "run-b",
  });
  expect(contract.routes.runs.query.parse({ before: cursor })).toEqual({
    before: cursor,
    limit: 50,
  });
  expect(contract.routes.runs.query.safeParse({ before: "2026-10-17T00:00:00.000Z" }).success).toBe(
    false,
  );
  expect(contract.routes.runs.query.safeParse({ before: `${cursor}|extra` }).success).toBe(false);
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
    workspace: "/workspace",
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
        version: 1,
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

test("schedule validation errors cross the contract with default messages", () => {
  for (const code of ["invalid_cron", "invalid_timezone"] satisfies contract.ErrorCode[]) {
    const error = {
      code,
      message: contract.DEFAULT_ERROR_MESSAGES[code],
    };

    expect(contract.errorBodySchema.parse({ error })).toEqual({ error });
    expect(error.message.length).toBeGreaterThan(0);
  }
});

test("runs queries default to 50 and cap pages at 200", () => {
  const input: contract.RunsQuery = {};
  const query = contract.routes.runs.query.parse(input);

  expect(query).toEqual({ limit: 50 });
  expectTypeOf(query.limit).toEqualTypeOf<number>();
  expect(contract.routes.runs.query.parse({ limit: "200" }).limit).toBe(200);
  expect(contract.routes.runs.query.safeParse({ limit: 201 }).success).toBe(false);
});
