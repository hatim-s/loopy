import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { decodeBoundary, encodeRunCursor, graphView, routes } from "@loopy/contract";
import type { Graph } from "@loopy/core";
import { revision } from "@loopy/core";
import { loopy } from "@loopy/sdk/graph";
import { Effect } from "effect";
import { FakeExecutor, runIn } from "../../core/_tests_/fixtures/run";
import { makeLocalService, Registry } from "../src/local";
import { compiledBody } from "./fixtures/compiled";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { fixtureDaemon, fixtureStore, waitUntil } from "./fixtures/service-runtime";

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

  await Effect.runPromise(registry.save(body));
  let now = Date.parse("2026-10-17T00:00:00.000Z");
  const clock = { now: () => now };
  const store = await fixtureStore(home);

  const service = makeLocalService({
    store,
    clock,
    home: home,
  });

  return {
    service,
    store,
    runs: () =>
      Effect.runPromise(store.queryRuns({ limit: 200, now: new Date(now).toISOString() })),
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
  const { service, runs, root } = await fixture();
  await expect(Effect.runPromise(service.startRun("service", {}, root))).rejects.toMatchObject({
    code: "bad_request",
  });
  expect(await runs()).toEqual([]);
  const run = await Effect.runPromise(service.startRun("service", { name: "Hatim" }, root));
  expect(run).toMatchObject({ status: "queued", input: { name: "Hatim" }, owner: null });
  const [loopy] = await Effect.runPromise(service.listLoopies(root));
  expect(loopy).toMatchObject({ slug: "service", lastRun: run, counts: { queued: 1 } });

  for (const privateField of ["source", "revision", "bundles", "secrets", "savedAt"]) {
    expect(Object.hasOwn(loopy ?? {}, privateField)).toBe(false);
  }
});

test("service resumes queued, suspended and abandoned runs and rejects terminal or owned runs", async () => {
  const { service, store, root } = await fixture();

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

    await Effect.runPromise(store.createRun(run));

    if (status === "queued" || status === "suspended" || status === "running") {
      expect(await Effect.runPromise(service.resumeRun(status))).toMatchObject({
        status: status === "queued" ? "queued" : "suspended",
        owner: null,
      });
    } else {
      await expect(Effect.runPromise(service.resumeRun(status))).rejects.toMatchObject({
        code: "not_claimable",
      });
    }
  }

  const owned = await Effect.runPromise(service.startRun("service", { name: "Hatim" }, root));
  await Effect.runPromise(store.claim(owned.id, "owner"));
  await expect(Effect.runPromise(service.cancelRun(owned.id))).rejects.toMatchObject({
    code: "owned_elsewhere",
  });
  await expect(Effect.runPromise(service.resumeRun(owned.id))).rejects.toMatchObject({
    code: "owned_elsewhere",
  });
  await Effect.runPromise(store.release(owned.id, "owner"));
  expect(await Effect.runPromise(service.cancelRun(owned.id))).toMatchObject({
    status: "cancelled",
    owner: null,
  });
  await expect(Effect.runPromise(service.cancelRun("missing"))).rejects.toMatchObject({
    code: "not_found",
    message: "No run 'missing'. Use loopy runs to list run ids.",
  });
});

test("service pages newest runs by createdAt with default and maximum page sizes", async () => {
  const { service, store, root, advance } = await fixture();
  const first = await Effect.runPromise(service.startRun("service", { name: "first" }, root));
  advance();
  const second = await Effect.runPromise(service.startRun("service", { name: "second" }, root));
  expect(
    await Effect.runPromise(service.listRuns(decodeBoundary(routes.runs.query)({ limit: 1 }))),
  ).toEqual([second]);
  expect(
    await Effect.runPromise(
      service.listRuns(decodeBoundary(routes.runs.query)({ before: encodeRunCursor(second) })),
    ),
  ).toEqual([first]);
  expect(
    await Effect.runPromise(
      service.listRuns(decodeBoundary(routes.runs.query)({ status: "failed" })),
    ),
  ).toEqual([]);

  for (let i = 0; i < 205; i++) {
    await Effect.runPromise(
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
    await Effect.runPromise(service.listRuns(decodeBoundary(routes.runs.query)({ slug: "page" }))),
  ).toHaveLength(50);
  expect(await Effect.runPromise(service.listRuns({ slug: "page", limit: 200 }))).toHaveLength(200);
});

test("service schedules create, replace, toggle, delete and emit persisted events", async () => {
  const { service, store, root, advance } = await fixture();

  const first = await Effect.runPromise(
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
  expect(await Effect.runPromise(service.listSchedules(root))).toEqual([first]);
  const retryAt = new Date(Date.parse(first.nextFireAt) + 5000).toISOString();
  await Effect.runPromise(store.failSchedule({ schedule: first, error: "boom", retryAt }));
  expect(await Effect.runPromise(service.listSchedules(root))).toEqual([
    { ...first, failure: { error: "boom", retryAt } },
  ]);
  await Effect.runPromise(
    store.putSchedule({ ...first, lastFireKey: "fired", nextFireAt: first.nextFireAt }),
  );
  expect(await Effect.runPromise(service.setScheduleEnabled("service", false, root))).toMatchObject(
    {
      enabled: false,
      lastFireKey: "fired",
    },
  );
  advance();
  const enabled = await Effect.runPromise(service.setScheduleEnabled("service", true, root));
  expect(enabled).toMatchObject({ enabled: true, input: { name: "first" }, lastFireKey: "fired" });

  const replaced = await Effect.runPromise(
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
  expect(await Effect.runPromise(service.deleteSchedule("service", root))).toEqual({
    deleted: true,
  });
  expect(await Effect.runPromise(service.listSchedules(root))).toEqual([]);
  await expect(
    Effect.runPromise(service.setScheduleEnabled("service", true, root)),
  ).rejects.toMatchObject({
    code: "not_found",
  });
  expect(
    (await Effect.runPromise(store.events(0, 100))).map((event) => `${event.entity}.${event.kind}`),
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
  const { service, store, root } = await fixture();

  const cases = [
    { body: { cron: "bad" }, code: "invalid_cron" },
    { body: { cron: "" }, code: "invalid_cron" },
    { body: { cron: "* * * * *", tz: "Invalid/Zone" }, code: "invalid_timezone" },
    { body: {}, code: "invalid_schedule" },
    { body: { cron: "* * * * *", input: {} }, code: "bad_request" },
  ];

  for (const { body, code } of cases) {
    await expect(
      Effect.runPromise(service.putSchedule("service", body, root)),
    ).rejects.toMatchObject({
      code,
    });
  }

  await expect(
    Effect.runPromise(service.putSchedule("missing", { cron: "* * * * *" }, root)),
  ).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(Effect.runPromise(service.deleteSchedule("missing", root))).rejects.toMatchObject({
    code: "not_found",
  });
  expect(await Effect.runPromise(store.listSchedules())).toEqual([]);
});

test("definition defaults apply and workspace schedule mutations stay isolated", async () => {
  const { service, store, root } = await fixture({
    schedule: { cron: "*/5 * * * *", tz: "Asia/Kolkata" },
  });

  expect((await Effect.runPromise(service.listLoopies(root)))[0]?.schedule).toEqual({
    cron: "*/5 * * * *",
    tz: "Asia/Kolkata",
    enabled: false,
    nextFireAt: null,
  });

  const saved = await Effect.runPromise(
    service.putSchedule("service", { input: { name: "default" } }, root),
  );

  expect(saved).toMatchObject({ cron: "*/5 * * * *", tz: "Asia/Kolkata" });
  const other = join(root, "other");
  mkdirSync(join(other, ".loopy", "loopies"), { recursive: true });

  await Effect.runPromise(
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
  expect(await Effect.runPromise(service.listSchedules(other))).toMatchObject([
    { workspace: other },
  ]);
  await expect(Effect.runPromise(service.putSchedule("service", {}, other))).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    Effect.runPromise(service.setScheduleEnabled("service", false, other)),
  ).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(Effect.runPromise(service.deleteSchedule("service", other))).rejects.toMatchObject({
    code: "not_found",
  });
  await Effect.runPromise(service.deleteSchedule("service", root));
  expect(await Effect.runPromise(store.listSchedules())).toMatchObject([{ workspace: other }]);
});

test("disabled schedules stay dormant and re-enabling waits for the next slot", async () => {
  const { service, store, runs, clock, advance, root } = await fixture();

  const daemon = await fixtureDaemon({
    concurrency: 4,
    store,
    clock,
    definitionFor: () => Effect.succeed({ revision: "bundle", graph: serviceGraph }),
    prepare: () => Effect.succeed({ graph: serviceGraph, executor: new FakeExecutor() }),
  });

  await Effect.runPromise(
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
  await Effect.runPromise(daemon.pass);
  expect(await runs()).toEqual([]);
  expect(await Effect.runPromise(service.setScheduleEnabled("service", true, root))).toMatchObject({
    nextFireAt: "2026-10-17T00:03:00.000Z",
  });
  await Effect.runPromise(daemon.pass);
  expect(await runs()).toEqual([]);
  advance(60000);
  await Effect.runPromise(daemon.pass);
  await Effect.runPromise(
    waitUntil(
      Effect.map(
        store.queryRuns({ limit: 200, now: new Date(clock.now()).toISOString() }),
        (all) => all.length === 1 && all[0]?.status === "succeeded",
      ),
    ),
  );
});

test("global schedules use the service workspace and preserve other workspaces", async () => {
  const { service, store, root } = await fixture({ scope: "global" });
  const other = join(root, "other");
  mkdirSync(join(other, ".loopy", "loopies"), { recursive: true });

  await Effect.runPromise(
    service.putSchedule("service", { cron: "* * * * *", input: { name: "first" } }, root),
  );

  const second = await Effect.runPromise(
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
  expect(await Effect.runPromise(service.listSchedules(root))).toMatchObject([
    { workspace: root, input: { name: "first" } },
  ]);
  await Effect.runPromise(service.setScheduleEnabled("service", false, other));
  await Effect.runPromise(service.deleteSchedule("service", other));
  expect(await Effect.runPromise(store.listSchedules())).toMatchObject([
    { workspace: root, enabled: true },
  ]);
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
    await Effect.runPromise(
      f.service.putSchedule("service", { cron: "* * * * *", input: { name: "first" } }, f.root),
    );
    f.advance(60000);
    const paused = await pausedScheduleDaemon(f);
    await paused.entered;

    try {
      const saved =
        mutation === "PUT"
          ? await Effect.runPromise(
              f.service.putSchedule(
                "service",
                { cron: "0 * * * *", input: { name: "new" } },
                f.root,
              ),
            )
          : await Effect.runPromise(f.service.setScheduleEnabled("service", false, f.root));

      expect(saved.nextFireAt).toBe(
        mutation === "PUT" ? "2026-10-17T01:00:00.000Z" : "2026-10-17T00:01:00.000Z",
      );
      paused.release();
      await Effect.runPromise(paused.daemon.pass);
      expect(await f.runs()).toEqual([]);
      expect(await Effect.runPromise(f.service.listSchedules(f.root))).toEqual([saved]);
    } finally {
      paused.release();
      await Effect.runPromise(paused.daemon.stop);
    }
  });
}

test("service cursor follows the last event without requiring a run snapshot", async () => {
  const { service, store, root } = await fixture();
  const initial = await Effect.runPromise(service.cursor());
  expect(initial).toEqual({ cursor: 0, epoch: await Effect.runPromise(store.epoch()) });
  await Effect.runPromise(service.startRun("service", { name: "Hatim" }, root));
  const current = await Effect.runPromise(service.cursor());
  const events = await Effect.runPromise(store.events(0, 100));
  expect(events.at(-1)?.sequence).toBe(current.cursor);
  expect(current).toEqual({ cursor: initial.cursor + 1, epoch: initial.epoch });
});

test("run graphs stay pinned to the revision each run started on", async () => {
  const { service, root } = await fixture();
  const unsaved = await Effect.runPromise(service.startRun("service", { name: "Hatim" }, root));
  // The fixture registry entry was never compiled to disk, so its run has no graph to show.
  await expect(Effect.runPromise(service.runGraph(unsaved.id))).rejects.toHaveProperty(
    "_tag",
    "RegistryError",
  );
  const source = join(root, "service.ts");
  const first = await compiledBody("service", source);
  first.graph.input = { name: "string" };
  first.revision = await revision(first.graph);
  await Effect.runPromise(service.putLoopy("service", first));
  const pinned = await Effect.runPromise(service.startRun("service", { name: "Hatim" }, root));
  const second = await compiledBody("service", source);
  second.graph.input = { name: "string", "note?": "string" };
  second.revision = await revision(second.graph);
  await Effect.runPromise(service.putLoopy("service", second));
  expect(second.revision).not.toBe(first.revision);
  expect(
    decodeBoundary(routes.runGraph.response)(await Effect.runPromise(service.runGraph(pinned.id))),
  ).toEqual({
    revision: first.revision,
    graph: graphView(first.graph),
  });
  expect(
    decodeBoundary(routes.graph.response)(await Effect.runPromise(service.graph("service", root))),
  ).toEqual({
    revision: second.revision,
    graph: graphView(second.graph),
  });
  await expect(Effect.runPromise(service.runGraph("missing"))).rejects.toMatchObject({
    code: "not_found",
  });
});

test("putLoopy preserves every author option from graph meta", async () => {
  const { service, root, registry } = await fixture();

  const meta = {
    description: "Author metadata",
    schedule: { cron: "0 9 * * *", tz: "Asia/Kolkata" },
    secrets: ["TOKEN"],
    mode: "full" as const,
    scope: "global" as const,
  };

  await Effect.runPromise(
    service.putLoopy("metadata", await compiledBody("metadata", join(root, "metadata.ts"), meta)),
  );
  const saved = await Effect.runPromise(registry.get("metadata"));
  expect(saved).toMatchObject({ version: 3, graph: { meta } });
  expect(saved).not.toHaveProperty("description");
});

test("service maps completion between requireRun and claim to not_claimable", async () => {
  const { service, store, root } = await fixture();
  const run = await Effect.runPromise(service.startRun("service", { name: "Hatim" }, root));
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
  await expect(Effect.runPromise(service.cancelRun(run.id))).rejects.toMatchObject({
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
    clock: { now: Date.now },
    home: home,
  });

  const save = async (workspace: string, field: string) => {
    mkdirSync(join(workspace, ".loopy", "loopies"), { recursive: true });
    const source = join(workspace, "shared.ts");
    await Bun.write(source, "");
    const body = await compiledBody("shared", source);
    body.graph.input = { [field]: "string" };
    body.revision = await revision(body.graph);
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
