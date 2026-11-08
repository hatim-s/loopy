import { expect, expectTypeOf, test } from "bun:test";
import * as contract from "@loopy/contract";
import type * as core from "@loopy/core";
import { Option, Schema } from "effect";
import { newRun } from "./fixture";
import { approveDemoGraph } from "./fixtures/graphs";

const now = newRun().createdAt;

const leaseMs = 60_000;

const loopy = { slug: "test", description: null };

function view(run: core.RunRecord, hook?: contract.PendingHook) {
  return contract.runView({ run, loopy, hook, now, leaseMs });
}

const hook: contract.PendingHook = {
  token: "hook",
  runId: "run",
  seq: 2,
  name: "approve",
  createdAt: now,
  expiresAt: null,
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
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        contract.runViewSchema,
        contract.boundaryOptions,
      )({ ...derived, owner: run.owner }),
    ),
  ).toBe(false);
  expect(derived.loopy).toEqual({ slug: "test", description: null });
  expect(derived.ownerStale).toBe(false);
  expect(
    contract.runView({
      run,
      loopy,
      hook: undefined,
      now: new Date(Date.parse(now) + leaseMs).toISOString(),
      leaseMs,
    }).ownerStale,
  ).toBe(false);
  expect(
    contract.runView({
      run,
      loopy,
      hook: undefined,
      now: new Date(Date.parse(now) + leaseMs + 1).toISOString(),
      leaseMs,
    }).ownerStale,
  ).toBe(true);
  expect(view(newRun())).toMatchObject({ owner: null, ownerStale: false });
});

test("waitingOn names the run's pending hook and is null without one", () => {
  const run = { ...newRun(), status: "suspended", wakeAt: null } satisfies core.RunRecord;

  expect(view(run, hook).waitingOn).toEqual({
    hook: "approve",
    token: "hook",
    seq: 2,
    expiresAt: null,
    since: hook.createdAt,
  });
  expect(view(run).waitingOn).toBeNull();
});

test("loopy views carry the store counts, newest run and persisted schedule", () => {
  const saved = {
    slug: "test",
    workspace: "/workspace",
    scope: "project",
    input: { value: "number" },
    mode: "sandbox",
    description: null,
    schedule: null,
  } satisfies Parameters<typeof contract.loopyView>[0];

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

  const counts = { ...contract.emptyRunCounts(), succeeded: 1 };
  const result = contract.loopyView(saved, schedule, { counts, latest: [newer] });

  expect(result.lastRun).toEqual(newer);
  expect(result.schedule).toEqual({
    cron: schedule.cron,
    tz: "UTC",
    enabled: true,
    nextFireAt: now,
  });
  expect(contract.decodeBoundary(contract.loopyViewSchema)(result)).toEqual(result);
  const empty = { counts: contract.emptyRunCounts(), latest: [] };
  expect(contract.loopyView(saved, null, empty)).toMatchObject({
    workspace: "/workspace",
    lastRun: null,
    schedule: null,
    counts: { queued: 0, succeeded: 0 },
  });
  expect(contract.decodeBoundary(contract.scheduleSchema)(schedule)).toEqual(schedule);
});

test("route patterns are unique and every parameter has a schema", () => {
  const routes = Object.values(contract.routes);
  expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(routes.length);

  for (const route of routes) {
    const names = [...route.path.matchAll(/:([a-z]+)/g)].map((match) => match[0].slice(1));
    const fields = "fields" in route.params ? Object.keys(route.params.fields) : [];
    expect(fields.sort()).toEqual(names.sort());

    expect(
      Option.isSome(
        Schema.decodeUnknownOption(
          route.params,
          contract.boundaryOptions,
        )(Object.fromEntries(names.map((parameter) => [parameter, "1"]))),
      ),
    ).toBe(true);

    if (names.length > 0) {
      expect(
        Option.isSome(Schema.decodeUnknownOption(route.params, contract.boundaryOptions)({})),
      ).toBe(false);
    }
  }
});

test("serialized loopy and snapshot views exclude private registry and owner keys", () => {
  const run = view({
    ...newRun(),
    owner: { token: "private", pid: 1, host: "host", heartbeatAt: now },
  });

  const loopy = contract.loopyView(
    {
      slug: "test",
      workspace: "/workspace",
      scope: "project",
      mode: "sandbox",
      input: {},
      description: null,
      schedule: null,
    },
    null,
    { counts: contract.emptyRunCounts(), latest: [run] },
  );

  const snapshot: contract.RunSnapshotView = {
    nodeRuns: [],
    run,
    logs: [],
    hooks: [],
    cursor: 0,
    epoch: "epoch",
  };

  expect(contract.decodeBoundary(contract.loopyViewSchema)(loopy)).toEqual(loopy);
  expect(contract.decodeBoundary(contract.runSnapshotViewSchema)(snapshot)).toEqual(snapshot);

  for (const serialized of [JSON.stringify(loopy), JSON.stringify(snapshot)]) {
    expect(serialized).not.toMatch(/"(?:bundleHash|token|source|secrets)"\s*:/);
  }
});

test("strict edges reject misspelled request keys and injected view tokens", () => {
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        contract.routes.startRun.body,
        contract.boundaryOptions,
      )({ input: null, workspcae: "/workspace" }),
    ),
  ).toBe(false);
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        contract.runViewSchema,
        contract.boundaryOptions,
      )({ ...view(newRun()), token: "private" }),
    ),
  ).toBe(false);

  const described = contract.runView({
    run: newRun(),
    loopy: { slug: "test", description: "Review approvals" },
    hook: undefined,
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
  expect(contract.decodeBoundary(contract.routes.runs.query)({ before: cursor })).toEqual({
    before: cursor,
    limit: 50,
  });
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        contract.routes.runs.query,
        contract.boundaryOptions,
      )({ before: "2026-10-17T00:00:00.000Z" }),
    ),
  ).toBe(false);
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        contract.routes.runs.query,
        contract.boundaryOptions,
      )({ before: `${cursor}|extra` }),
    ),
  ).toBe(false);
});

test("schedule bodies reject mistyped and unknown fields", () => {
  expect(contract.decodeBoundary(contract.putScheduleBodySchema)({})).toEqual({});

  for (const body of [
    { cron: 1 },
    { tz: null },
    { input: undefined, enabled: "false" },
    { typo: true },
  ]) {
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(contract.putScheduleBodySchema, contract.boundaryOptions)(body),
      ),
    ).toBe(false);
  }

  expect(
    Option.isSome(
      Schema.decodeUnknownOption(contract.scheduleEnabledBodySchema, contract.boundaryOptions)({}),
    ),
  ).toBe(false);
  expect(contract.decodeBoundary(contract.scheduleEnabledBodySchema)({ enabled: false })).toEqual({
    enabled: false,
  });
});

test("loopy declared schedule is visible until a persisted schedule overrides it", () => {
  const saved = {
    slug: "test",
    workspace: "/workspace",
    scope: "project",
    mode: "sandbox",
    input: {},
    description: null,
    schedule: { cron: "0 * * * *", tz: "UTC" },
  } satisfies Parameters<typeof contract.loopyView>[0];

  const empty = { counts: contract.emptyRunCounts(), latest: [] };
  expect(contract.loopyView(saved, null, empty).schedule).toEqual({
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
      empty,
    ).schedule,
  ).toEqual({ cron: "*/5 * * * *", tz: "Asia/Kolkata", enabled: true, nextFireAt: now });
});

test("cursor route rejects invalid cursors and extra response fields", () => {
  expect(contract.routes.cursor.method).toBe("GET");
  expect(contract.routes.cursor.path).toBe("/cursor");
  expect(
    contract.decodeBoundary(contract.routes.cursor.response)({ cursor: 0, epoch: "epoch" }),
  ).toEqual({
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
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(contract.cursorViewSchema, contract.boundaryOptions)(value),
      ),
    ).toBe(false);
  }
});

test("schedule validation errors cross the contract with default messages", () => {
  for (const code of ["invalid_cron", "invalid_timezone"] satisfies contract.ErrorCode[]) {
    const error = {
      code,
      message: contract.DEFAULT_ERROR_MESSAGES[code],
    };

    expect(contract.decodeBoundary(contract.errorBodySchema)({ error })).toEqual({ error });
    expect(error.message.length).toBeGreaterThan(0);
  }
});

test("runs queries default to 50 and cap pages at 200", () => {
  const input: contract.RunsQuery = {};
  const query = contract.decodeBoundary(contract.routes.runs.query)(input);

  expect(query).toEqual({ limit: 50 });
  expectTypeOf(query.limit).toEqualTypeOf<number>();
  expect(contract.decodeBoundary(contract.routes.runs.query)({ limit: "200" }).limit).toBe(200);
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        contract.routes.runs.query,
        contract.boundaryOptions,
      )({ limit: 201 }),
    ),
  ).toBe(false);
});

test("graph wire views reject paths and hashes, including command parser hashes", () => {
  const nodes = approveDemoGraph.nodes.map((node) => {
    if (node.kind === "code") {
      return { ...node, module: { name: "draft.ts" } };
    }

    if (node.kind === "command") {
      return { ...node, parse: node.parse !== null };
    }

    return node;
  });

  const view = { ...approveDemoGraph, nodes, warnings: [] };
  expect(contract.decodeBoundary(contract.graphViewSchema)(view)).toEqual(view);
  expect(
    Schema.decodeUnknownExit(contract.graphViewSchema)(approveDemoGraph, {
      onExcessProperty: "error",
    })._tag === "Success",
  ).toBe(false);
  expect(
    Schema.decodeUnknownExit(contract.graphViewSchema)(
      {
        ...view,
        nodes: nodes.map((node) =>
          node.kind === "command" ? { ...node, parse: { bundleHash: "secret" } } : node,
        ),
      },
      { onExcessProperty: "error" },
    )._tag === "Success",
  ).toBe(false);
});

test("graph warning views project node labels without source module paths", () => {
  const graph = {
    ...approveDemoGraph,
    warnings: [
      {
        code: "predicate_type" as const,
        message: "warning",
        node: approveDemoGraph.entry,
        source: { module: "/private/author.ts", line: 1, column: 1 },
      },
    ],
  };

  const view = contract.graphView(graph);
  expect(view.warnings).toEqual([
    { code: "predicate_type", message: "warning", nodeId: graph.entry, label: "draft" },
  ]);
  expect(contract.decodeBoundary(contract.graphViewSchema)(view)).toEqual(view);
  expect(JSON.stringify(view)).not.toContain("/private/author.ts");
  expect(
    Schema.decodeUnknownExit(contract.graphViewSchema)(
      { ...view, warnings: graph.warnings },
      { onExcessProperty: "error" },
    )._tag === "Success",
  ).toBe(false);
});
