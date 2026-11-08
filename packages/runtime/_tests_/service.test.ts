import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { decodeBoundary, encodeRunCursor, graphView, nodeIdSchema, routes } from "@loopy/contract";
import type { Graph } from "@loopy/core";
import { loopy } from "@loopy/sdk";
import { Effect } from "effect";
import { FakeExecutor, runIn } from "../../core/_tests_/fixtures/run";
import { makeLocalService, Registry } from "../src/local";
import { saveCompiled } from "../src/local/save-compiled";
import { runAt } from "./fixtures/clock";
import { compiledBody } from "./fixtures/compiled";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { fixtureDaemon, fixtureStore } from "./fixtures/service-runtime";
import { eventually } from "./fixtures/wait";

const serviceGraph = loopy("test", { input: { name: "string" }, run: ({ input }) => input });

async function fixture(meta: Partial<Pick<Graph["meta"], "scope" | "schedule">> = {}) {
  const root = qualityTestRoot("service");
  const home = join(root, "home");
  const registry = await Effect.runPromise(Registry.make(home, root));

  const body = await compiledBody("service", join(root, "service.ts"), {
    ...meta,
    input: { name: "string" },
    secrets: ["PRIVATE"],
  });

  await Effect.runPromise(saveCompiled(registry, body));
  let now = Date.parse("2026-10-17T00:00:00.000Z");
  const clock = { now: () => now };
  // The service and store read this clock through Effect's Clock.
  const onClock = runAt(clock.now);
  const store = await fixtureStore(home);
  const service = makeLocalService({ store, home });

  return {
    service,
    store,
    onClock,
    runs: () => onClock(store.queryRuns({ limit: 200, now: new Date(now).toISOString() })),
    root,
    home,
    clock,
    registry,
    advance: (milliseconds = 1000) => {
      now += milliseconds;
    },
  };
}

test("service validates input before queuing and hides registry private fields", async () => {
  const { service, runs, root, onClock } = await fixture();
  await expect(onClock(service.startRun("service", {}, root))).rejects.toMatchObject({
    code: "bad_request",
  });
  expect(await runs()).toEqual([]);
  const run = await onClock(service.startRun("service", { name: "Hatim" }, root));
  expect(run).toMatchObject({ status: "queued", input: { name: "Hatim" }, owner: null });
  const [loopy] = await onClock(service.listLoopies(root));
  expect(loopy).toMatchObject({ slug: "service", lastRun: run, counts: { queued: 1 } });

  for (const privateField of ["source", "revision", "bundles", "secrets", "savedAt"]) {
    expect(Object.hasOwn(loopy ?? {}, privateField)).toBe(false);
  }
});

test("service resumes queued, suspended and abandoned runs and rejects terminal or owned runs", async () => {
  const { service, store, root, onClock } = await fixture();

  for (const status of [
    "queued",
    "suspended",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ] as const) {
    const run = runIn(status, {
      id: status,
      slug: "service",
      workspace: root,
      revision: "a".repeat(64),
      input: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (status === "running") {
      run.owner = {
        token: "dead",
        pid: 2147483647,
        host: hostname(),
        heartbeatAt: new Date(0).toISOString(),
      };
    }

    await onClock(store.createRun(run));

    if (status === "queued" || status === "suspended" || status === "running") {
      expect(await onClock(service.resumeRun(status))).toMatchObject({
        status: status === "queued" ? "queued" : "suspended",
        owner: null,
      });
    } else {
      await expect(onClock(service.resumeRun(status))).rejects.toMatchObject({
        code: "not_claimable",
      });
    }
  }

  const owned = await onClock(service.startRun("service", { name: "Hatim" }, root));
  await onClock(store.claim(owned.id, "owner"));
  await expect(onClock(service.cancelRun(owned.id))).rejects.toMatchObject({
    code: "owned_elsewhere",
  });
  await expect(onClock(service.resumeRun(owned.id))).rejects.toMatchObject({
    code: "owned_elsewhere",
  });
  await onClock(store.release(owned.id, "owner"));
  expect(await onClock(service.cancelRun(owned.id))).toMatchObject({
    status: "cancelled",
    owner: null,
  });
  await expect(onClock(service.cancelRun("missing"))).rejects.toMatchObject({
    code: "not_found",
    message: "No run 'missing'. Use loopy runs to list run ids.",
  });
});

test("cancelling a run cancels its pending nodes and keeps their recorded input", async () => {
  const { service, store, root, onClock } = await fixture();
  const run = await onClock(service.startRun("service", { name: "Hatim" }, root));
  const at = new Date(0).toISOString();

  const node = (nodeId: string) => ({
    key: { runId: run.id, nodeId: decodeBoundary(nodeIdSchema)(nodeId), scope: [] },
    attempt: 1,
    maxAttempts: 2,
    startedAt: at,
    receipt: "none" as const,
    inputView: { state: "available" as const, value: { nodeId } },
  });

  await onClock(store.claim(run.id, "owner"));
  await onClock(
    store.apply({
      runId: run.id,
      token: "owner",
      effects: [
        { kind: "write_node_run", nodeRun: { ...node("waits"), status: "waiting", wakeAt: null } },
        { kind: "write_node_run", nodeRun: { ...node("sleeps"), status: "sleeping", wakeAt: at } },
        {
          kind: "write_node_run",
          nodeRun: { ...node("done"), status: "succeeded", output: 1, endedAt: at },
        },
      ],
    }),
  );
  await onClock(store.release(run.id, "owner"));
  await onClock(service.cancelRun(run.id));

  const nodes = await onClock(store.getNodeRuns(run.id));
  expect(
    nodes.map((stored) => ({
      nodeId: String(stored.key.nodeId),
      status: stored.status,
      inputView: stored.inputView,
    })),
  ).toEqual(
    ["waits", "sleeps", "done"].map((nodeId) => ({
      nodeId,
      status: nodeId === "done" ? "succeeded" : "cancelled",
      inputView: { state: "available", value: { nodeId } },
    })),
  );
  expect(nodes.find((stored) => stored.key.nodeId === "waits")).not.toHaveProperty("wakeAt");
});

test("service pages newest runs by createdAt with default and maximum page sizes", async () => {
  const { service, store, root, advance, onClock } = await fixture();
  const first = await onClock(service.startRun("service", { name: "first" }, root));
  advance();
  const second = await onClock(service.startRun("service", { name: "second" }, root));
  expect(await onClock(service.listRuns(decodeBoundary(routes.runs.query)({ limit: 1 })))).toEqual({
    runs: [second],
    next: encodeRunCursor(second),
  });
  expect(
    await onClock(
      service.listRuns(decodeBoundary(routes.runs.query)({ before: encodeRunCursor(second) })),
    ),
  ).toEqual({ runs: [first], next: null });
  expect(
    await onClock(service.listRuns(decodeBoundary(routes.runs.query)({ status: "failed" }))),
  ).toEqual({ runs: [], next: null });

  for (let i = 0; i < 205; i++) {
    await onClock(
      store.createRun({
        id: `page-${i}`,
        slug: "page",
        workspace: root,
        revision: "a".repeat(64),
        input: {},
        status: "queued",
        createdAt: first.createdAt,
        updatedAt: first.updatedAt,
      }),
    );
  }

  expect(
    (await onClock(service.listRuns(decodeBoundary(routes.runs.query)({ slug: "page" })))).runs,
  ).toHaveLength(50);
  expect((await onClock(service.listRuns({ slug: "page", limit: 200 }))).runs).toHaveLength(200);
});

test("run paging includes every run sharing a timestamp", async () => {
  const { service, store, root, onClock } = await fixture();

  for (const id of ["a", "b"]) {
    await onClock(
      store.createRun({
        id,
        slug: "paging",
        workspace: root,
        revision: "a".repeat(64),
        input: {},
        status: "queued",
        createdAt: "2026-10-17T00:00:00.000Z",
        updatedAt: "2026-10-17T00:00:00.000Z",
      }),
    );
  }

  const first = await onClock(service.listRuns(decodeBoundary(routes.runs.query)({ limit: 1 })));
  expect(first.runs.map((run) => run.id)).toEqual(["b"]);

  const second = await onClock(
    service.listRuns(decodeBoundary(routes.runs.query)({ limit: 1, before: first.next ?? "" })),
  );

  // A page that ends exactly at the last run offers no next page.
  expect(second).toMatchObject({ runs: [{ id: "a" }], next: null });
});

test("service schedules create, replace, toggle, delete and emit persisted events", async () => {
  const { service, store, root, advance, onClock } = await fixture();

  const first = await onClock(
    service.putSchedule(
      "service",
      {
        cron: "* * * * *",
        input: { name: "first" },
      },
      root,
    ),
  );

  expect(first).toMatchObject({ workspace: root, enabled: true, lastFireKey: null, tz: "UTC" });
  expect(await onClock(service.listSchedules(root))).toEqual([first]);
  const retryAt = new Date(Date.parse(first.nextFireAt) + 5000).toISOString();
  await onClock(store.failSchedule({ schedule: first, error: "boom", retryAt }));
  expect(await onClock(service.listSchedules(root))).toEqual([
    { ...first, failure: { error: "boom", retryAt } },
  ]);
  await onClock(
    store.putSchedule({ ...first, lastFireKey: "fired", nextFireAt: first.nextFireAt }),
  );
  expect(await onClock(service.setScheduleEnabled("service", false, root))).toMatchObject({
    enabled: false,
    lastFireKey: "fired",
  });
  advance();
  const enabled = await onClock(service.setScheduleEnabled("service", true, root));
  expect(enabled).toMatchObject({ enabled: true, input: { name: "first" }, lastFireKey: "fired" });

  const replaced = await onClock(
    service.putSchedule(
      "service",
      {
        cron: "0 0 * * *",
        input: { name: "second" },
        enabled: false,
      },
      root,
    ),
  );

  expect(replaced).toMatchObject({
    cron: "0 0 * * *",
    enabled: false,
    input: { name: "second" },
    lastFireKey: null,
  });
  expect(replaced.nextFireAt).not.toBe(first.nextFireAt);
  expect(await onClock(service.deleteSchedule("service", root))).toEqual({
    deleted: true,
  });
  expect(await onClock(service.listSchedules(root))).toEqual([]);
  await expect(onClock(service.setScheduleEnabled("service", true, root))).rejects.toMatchObject({
    code: "not_found",
  });
  expect(
    (await onClock(store.events(0, 100))).map((event) => `${event.entity}.${event.kind}`),
  ).toEqual([
    "schedule.saved",
    "schedule.failed",
    "schedule.saved",
    "schedule.saved",
    "schedule.saved",
    "schedule.saved",
    "schedule.deleted",
  ]);
});

test("service rejects invalid schedule semantics before writing", async () => {
  const { service, store, root, onClock } = await fixture();

  const cases = [
    { body: { cron: "bad" }, code: "invalid_cron" },
    { body: { cron: "" }, code: "invalid_cron" },
    { body: { cron: "* * * * *", tz: "Invalid/Zone" }, code: "invalid_timezone" },
    { body: {}, code: "invalid_schedule" },
    { body: { cron: "* * * * *", input: {} }, code: "bad_request" },
  ];

  for (const { body, code } of cases) {
    await expect(onClock(service.putSchedule("service", body, root))).rejects.toMatchObject({
      code,
    });
  }

  await expect(
    onClock(service.putSchedule("missing", { cron: "* * * * *" }, root)),
  ).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(onClock(service.deleteSchedule("missing", root))).rejects.toMatchObject({
    code: "not_found",
  });
  expect(await onClock(store.listSchedules())).toEqual([]);
});

test("definition defaults apply and workspace schedule mutations stay isolated", async () => {
  const { service, store, root, onClock } = await fixture({
    schedule: { cron: "*/5 * * * *", tz: "Asia/Kolkata" },
  });

  expect((await onClock(service.listLoopies(root)))[0]?.schedule).toEqual({
    state: "declared",
    cron: "*/5 * * * *",
    tz: "Asia/Kolkata",
  });

  const saved = await onClock(service.putSchedule("service", { input: { name: "default" } }, root));

  expect(saved).toMatchObject({ cron: "*/5 * * * *", tz: "Asia/Kolkata" });
  const other = join(root, "other");
  mkdirSync(join(other, ".loopy", "loopies"), { recursive: true });

  await onClock(
    store.putSchedule({
      workspace: other,
      slug: "service",
      cron: "* * * * *",
      tz: "UTC",
      input: {},
      enabled: true,
      nextFireAt: "2026-10-17T00:01:00.000Z",
    }),
  );
  expect(await onClock(service.listSchedules(other))).toMatchObject([{ workspace: other }]);
  await expect(onClock(service.putSchedule("service", {}, other))).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(onClock(service.setScheduleEnabled("service", false, other))).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(onClock(service.deleteSchedule("service", other))).rejects.toMatchObject({
    code: "not_found",
  });
  await onClock(service.deleteSchedule("service", root));
  expect(await onClock(store.listSchedules())).toMatchObject([{ workspace: other }]);
});

test("disabled schedules stay dormant and re-enabling waits for the next slot", async () => {
  const { service, store, runs, clock, advance, root, onClock } = await fixture();

  const daemon = await fixtureDaemon({
    concurrency: 4,
    store,
    clock,
    definitionFor: () => Effect.succeed({ revision: "bundle", graph: serviceGraph }),
    prepare: () => Effect.succeed({ graph: serviceGraph, executor: new FakeExecutor() }),
  });

  await onClock(
    service.putSchedule(
      "service",
      {
        cron: "* * * * *",
        input: { name: "scheduled" },
        enabled: false,
      },
      root,
    ),
  );
  advance(120000);
  await onClock(daemon.pass);
  expect(await runs()).toEqual([]);
  expect(await onClock(service.setScheduleEnabled("service", true, root))).toMatchObject({
    nextFireAt: "2026-10-17T00:03:00.000Z",
  });
  await onClock(daemon.pass);
  expect(await runs()).toEqual([]);
  advance(60000);
  await onClock(daemon.pass);
  await onClock(
    eventually(
      "the scheduled run to succeed",
      Effect.map(
        store.queryRuns({ limit: 200, now: new Date(clock.now()).toISOString() }),
        (all) => all.length === 1 && all[0]?.status === "succeeded",
      ),
    ),
  );
});

test("global schedules use the service workspace and preserve other workspaces", async () => {
  const { service, store, root, onClock } = await fixture({ scope: "global" });
  const other = join(root, "other");
  mkdirSync(join(other, ".loopy", "loopies"), { recursive: true });

  await onClock(
    service.putSchedule("service", { cron: "* * * * *", input: { name: "first" } }, root),
  );

  const second = await onClock(
    service.putSchedule(
      "service",
      {
        cron: "0 * * * *",
        input: { name: "second" },
      },
      other,
    ),
  );

  expect(second.workspace).toBe(other);
  expect(await onClock(service.listSchedules(root))).toMatchObject([
    { workspace: root, input: { name: "first" } },
  ]);
  await onClock(service.setScheduleEnabled("service", false, other));
  await onClock(service.deleteSchedule("service", other));
  expect(await onClock(store.listSchedules())).toMatchObject([{ workspace: root, enabled: true }]);
});

async function pausedScheduleDaemon(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<void>();
  const bundle = Promise.withResolvers<string>();

  const daemon = await fixtureDaemon({
    concurrency: 4,
    store: f.store,
    clock: f.clock,
    definitionFor: () => {
      entered.resolve();

      return Effect.promise(() => bundle.promise).pipe(
        Effect.map((revision) => ({ revision, graph: serviceGraph })),
      );
    },
    prepare: () => Effect.succeed({ graph: serviceGraph, executor: new FakeExecutor() }),
  });

  return { daemon, entered: entered.promise, release: () => bundle.resolve("bundle") };
}

for (const mutation of ["PUT", "disable"]) {
  test(`a ${mutation} during bundle resolution rejects the pending schedule fire`, async () => {
    const f = await fixture();
    await f.onClock(
      f.service.putSchedule("service", { cron: "* * * * *", input: { name: "first" } }, f.root),
    );
    f.advance(60000);
    const paused = await pausedScheduleDaemon(f);
    await paused.entered;

    try {
      const saved =
        mutation === "PUT"
          ? await f.onClock(
              f.service.putSchedule(
                "service",
                { cron: "0 * * * *", input: { name: "new" } },
                f.root,
              ),
            )
          : await f.onClock(f.service.setScheduleEnabled("service", false, f.root));

      expect(saved.nextFireAt).toBe(
        mutation === "PUT" ? "2026-10-17T01:00:00.000Z" : "2026-10-17T00:01:00.000Z",
      );
      paused.release();
      await f.onClock(paused.daemon.pass);
      expect(await f.runs()).toEqual([]);
      expect(await f.onClock(f.service.listSchedules(f.root))).toEqual([saved]);
    } finally {
      paused.release();
      await f.onClock(paused.daemon.stop);
    }
  });
}

test("service cursor follows the last event without requiring a run snapshot", async () => {
  const { service, store, root, onClock } = await fixture();
  const initial = await onClock(service.cursor());
  expect(initial).toEqual({ cursor: 0, epoch: await onClock(store.epoch()) });
  await onClock(service.startRun("service", { name: "Hatim" }, root));
  const current = await onClock(service.cursor());
  const events = await onClock(store.events(0, 100));
  expect(events.at(-1)?.sequence).toBe(current.cursor);
  expect(current).toEqual({ cursor: initial.cursor + 1, epoch: initial.epoch });
});

test("run graphs stay pinned to the revision each run started on", async () => {
  const { service, root, onClock } = await fixture();
  const source = join(root, "service.ts");
  const first = await compiledBody("service", source, { input: { name: "string" } });
  await onClock(service.putLoopy("service", first));
  const pinned = await onClock(service.startRun("service", { name: "Hatim" }, root));

  const second = await compiledBody("service", source, {
    input: { name: "string", "note?": "string" },
  });

  await onClock(service.putLoopy("service", second));
  expect(second.revision).not.toBe(first.revision);
  expect(
    decodeBoundary(routes.runGraph.response)(await onClock(service.runGraph(pinned.id))),
  ).toEqual({
    revision: first.revision,
    graph: graphView(first.graph),
  });
  expect(
    decodeBoundary(routes.graph.response)(await onClock(service.graph("service", root))),
  ).toEqual({
    revision: second.revision,
    graph: graphView(second.graph),
  });
  await expect(onClock(service.runGraph("missing"))).rejects.toMatchObject({
    code: "not_found",
  });
});

test("putLoopy preserves every author option from graph meta", async () => {
  const { service, root, registry, onClock } = await fixture();

  const meta = {
    description: "Author metadata",
    schedule: { cron: "0 9 * * *", tz: "Asia/Kolkata" },
    secrets: ["TOKEN"],
    mode: "full" as const,
    scope: "global" as const,
  };

  await onClock(
    service.putLoopy("metadata", await compiledBody("metadata", join(root, "metadata.ts"), meta)),
  );
  const saved = await onClock(registry.get("metadata"));
  expect(saved).toMatchObject({ version: 3, graph: { meta } });
  expect(saved).not.toHaveProperty("description");
});

test("service maps completion between requireRun and claim to not_claimable", async () => {
  const { service, store, root, onClock } = await fixture();
  const run = await onClock(service.startRun("service", { name: "Hatim" }, root));
  const claim = store.claim.bind(store);
  store.claim = (id, token) =>
    Effect.gen(function* () {
      yield* claim(id, "finisher");
      yield* store.apply({
        runId: id,
        token: "finisher",
        effects: [
          {
            kind: "finish_run",
            outcome: { status: "succeeded", output: 1 },
            at: new Date().toISOString(),
          },
        ],
      });
      yield* store.release(id, "finisher");

      return yield* claim(id, token);
    });
  await expect(onClock(service.cancelRun(run.id))).rejects.toMatchObject({
    code: "not_claimable",
    message: "The run cannot be claimed in its current state.",
  });
});

test("loopy views are keyed by workspace and slug so graph and start reach that project's save", async () => {
  const root = qualityTestRoot("workspaces");
  const home = join(root, "home");
  const store = await fixtureStore(home);

  const service = makeLocalService({
    store,
    home: home,
  });

  const save = async (workspace: string, field: string) => {
    mkdirSync(join(workspace, ".loopy", "loopies"), { recursive: true });
    const source = join(workspace, "shared.ts");
    await Bun.write(source, "");
    const body = await compiledBody("shared", source, { input: { [field]: "string" } });
    await Effect.runPromise(service.putLoopy("shared", body));

    return body.revision;
  };

  const a = join(root, "a");
  const b = join(root, "b");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(join(elsewhere, ".loopy", "loopies"), { recursive: true });
  const revisionA = await save(a, "alpha");
  const revisionB = await save(b, "beta");

  const workspaces = async (caller: string) =>
    (await Effect.runPromise(service.listLoopies(caller))).map((view) => view.workspace);

  expect(await workspaces(a)).toEqual([a]);
  const started = await Effect.runPromise(service.startRun("shared", { alpha: "x" }, a));
  expect(started.workspace).toBe(a);
  expect((await Effect.runPromise(store.getRun(started.id)))?.revision).toBe(revisionA);
  // A daemon in another directory lists A's loopy through its run, so only A's path resolves it.
  expect(await workspaces(elsewhere)).toEqual([a]);
  await expect(Effect.runPromise(service.graph("shared", elsewhere))).rejects.toThrow(
    "No saved loopy 'shared'",
  );
  expect((await Effect.runPromise(service.graph("shared", a))).revision).toBe(revisionA);
  // The same slug saved in two workspaces is two loopies; the caller's workspace lists first.
  expect(await workspaces(b)).toEqual([b, a]);
  expect((await Effect.runPromise(service.graph("shared", b))).revision).toBe(revisionB);
  await expect(
    Effect.runPromise(service.startRun("shared", { alpha: "x" }, b)),
  ).rejects.toMatchObject({
    code: "bad_request",
  });
  const other = await Effect.runPromise(service.startRun("shared", { beta: "y" }, b));
  expect((await Effect.runPromise(store.getRun(other.id)))?.revision).toBe(revisionB);
});
