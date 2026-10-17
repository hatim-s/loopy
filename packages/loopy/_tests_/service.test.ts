import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { revision } from "../src/compiler/revision.js";
import { encodeRunCursor, routes } from "../src/contract/index.js";
import type { RunRecord } from "../src/core/index.js";
import { LoopyService, openRunStore, Registry } from "../src/local/index.js";
import { Daemon, SYSTEM_CLOCK } from "../src/runtime/index.js";
import type { Loopy } from "../src/sdk/host.js";
import { compiledBody } from "./compiled-fixture.js";
import { FakeExecutor } from "./fixture.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function fixture(definition = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-service-")));
  const home = join(root, "home");
  const source = join(root, "service.ts");
  await Bun.write(
    source,
    `import { loopy } from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/index.ts"))};
  export default loopy({ name: "service", ${definition} input: { name: "string" }, secrets: ["PRIVATE"], run: () => 1 });`,
  );

  const { default: definitionValue }: { default: Loopy } = await import(source);

  const registry = new Registry(home, root);

  const body = compiledBody("service", source, {
    scope: definitionValue.scope,
    schedule: definitionValue.schedule ?? null,
    secrets: ["PRIVATE"],
  });

  body.graph.input = { name: "string" };
  body.revision = revision(body.graph, []);
  registry.save(body);
  let now = Date.parse("2026-10-17T00:00:00.000Z");
  const clock = { ...SYSTEM_CLOCK, now: () => now };
  const store = openRunStore(home);

  const service = new LoopyService({
    store,
    registry: () => registry,
    clock,
  });

  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  return {
    service,
    store,
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
  const { service, store, root } = await fixture();
  await expect(service.startRun("service", {}, root)).rejects.toMatchObject({
    code: "bad_request",
  });
  expect(await store.listRuns()).toEqual([]);
  const run = await service.startRun("service", { name: "Hatim" }, root);
  expect(run).toMatchObject({ status: "queued", input: { name: "Hatim" }, owner: null });
  const [loopy] = await service.listLoopies();
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
    const run: RunRecord = {
      id: status,
      slug: "service",
      workspace: root,
      revision: "a".repeat(64),
      input: {},
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (status === "running") {
      run.owner = {
        token: "dead",
        pid: 2147483647,
        host: hostname(),
        heartbeatAt: new Date(0).toISOString(),
      };
    }

    await store.createRun(run);

    if (status === "queued" || status === "suspended" || status === "running") {
      expect(await service.resumeRun(status)).toMatchObject({
        status: status === "queued" ? "queued" : "suspended",
        owner: null,
      });
    } else {
      await expect(service.resumeRun(status)).rejects.toMatchObject({ code: "not_claimable" });
    }
  }

  const owned = await service.startRun("service", { name: "Hatim" }, root);
  await store.claim(owned.id, "owner");
  await expect(service.cancelRun(owned.id)).rejects.toMatchObject({ code: "owned_elsewhere" });
  await expect(service.resumeRun(owned.id)).rejects.toMatchObject({ code: "owned_elsewhere" });
  await store.release(owned.id, "owner");
  expect(await service.cancelRun(owned.id)).toMatchObject({ status: "cancelled", owner: null });
  await expect(service.cancelRun("missing")).rejects.toMatchObject({
    code: "not_found",
    message: "No run 'missing'. Use loopy runs to list run ids.",
  });
});

test("service pages newest runs by createdAt with default and maximum page sizes", async () => {
  const { service, store, root, advance } = await fixture();
  const first = await service.startRun("service", { name: "first" }, root);
  advance();
  const second = await service.startRun("service", { name: "second" }, root);
  expect(await service.listRuns(routes.runs.query.parse({ limit: 1 }))).toEqual([second]);
  expect(
    await service.listRuns(routes.runs.query.parse({ before: encodeRunCursor(second) })),
  ).toEqual([first]);
  expect(await service.listRuns(routes.runs.query.parse({ status: "failed" }))).toEqual([]);

  for (let i = 0; i < 205; i++) {
    await store.createRun({
      id: `page-${i}`,
      slug: "page",
      workspace: root,
      revision: "a".repeat(64),
      input: {},
      status: "queued",
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
    });
  }

  expect(await service.listRuns(routes.runs.query.parse({ slug: "page" }))).toHaveLength(50);
  expect(await service.listRuns({ slug: "page", limit: 200 })).toHaveLength(200);
});

test("service hook resolution returns the woken run and rejects duplicate resolution", async () => {
  const { service, store, root } = await fixture();
  const run = await service.startRun("service", { name: "Hatim" }, root);
  await store.claim(run.id, "owner");
  await store.createHook(run.id, "owner", {
    runId: run.id,
    seq: 0,
    key: "approval",
    kind: "hook",
    input: { name: "approve", token: "hook" },
    status: "waiting",
    attempt: 1,
    maxAttempts: 1,
    startedAt: run.createdAt,
  });
  await store.suspend(run.id, "owner");
  await store.release(run.id, "owner");
  expect((await service.runSnapshot(run.id))?.run.waitingOn).toMatchObject({
    hook: "approve",
    token: "hook",
  });
  expect(await service.resolveHook("hook", { approved: true })).toMatchObject({
    id: run.id,
    status: "suspended",
    wakeAt: expect.any(String),
  });
  await expect(service.resolveHook("hook", null)).rejects.toMatchObject({ code: "unknown_hook" });
});

test("service schedules create, replace, toggle, delete and emit persisted events", async () => {
  const { service, store, root, advance } = await fixture();

  const first = await service.putSchedule("service", {
    cron: "* * * * *",
    input: { name: "first" },
  });

  expect(first).toMatchObject({ workspace: root, enabled: true, lastFireKey: null, tz: "UTC" });
  expect(await service.listSchedules()).toEqual([first]);
  await store.putSchedule({ ...first, lastFireKey: "fired", nextFireAt: first.nextFireAt });
  expect(await service.setScheduleEnabled("service", false)).toMatchObject({
    enabled: false,
    lastFireKey: "fired",
  });
  advance();
  const enabled = await service.setScheduleEnabled("service", true);
  expect(enabled).toMatchObject({ enabled: true, input: { name: "first" }, lastFireKey: "fired" });

  const replaced = await service.putSchedule("service", {
    cron: "0 0 * * *",
    input: { name: "second" },
    enabled: false,
  });

  expect(replaced).toMatchObject({
    cron: "0 0 * * *",
    enabled: false,
    input: { name: "second" },
    lastFireKey: null,
  });
  expect(replaced.nextFireAt).not.toBe(first.nextFireAt);
  expect(await service.deleteSchedule("service")).toEqual({ deleted: true });
  expect(await service.listSchedules()).toEqual([]);
  await expect(service.setScheduleEnabled("service", true)).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await store.events(0, 100)).map((event) => `${event.entity}.${event.kind}`)).toEqual([
    "schedule.saved",
    "schedule.saved",
    "schedule.saved",
    "schedule.saved",
    "schedule.saved",
    "schedule.deleted",
  ]);
});

test("service rejects invalid schedule semantics before writing", async () => {
  const { service, store } = await fixture();

  const cases = [
    { body: { cron: "bad" }, code: "invalid_cron" },
    { body: { cron: "" }, code: "invalid_cron" },
    { body: { cron: "* * * * *", tz: "Invalid/Zone" }, code: "invalid_timezone" },
    { body: {}, code: "invalid_schedule" },
    { body: { cron: "* * * * *", input: {} }, code: "bad_request" },
  ];

  for (const { body, code } of cases) {
    await expect(service.putSchedule("service", body)).rejects.toMatchObject({
      code,
    });
  }

  await expect(service.putSchedule("missing", { cron: "* * * * *" })).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(service.deleteSchedule("missing")).rejects.toMatchObject({ code: "not_found" });
  expect(await store.listSchedules()).toEqual([]);
});

test("definition defaults apply and workspace schedule mutations stay isolated", async () => {
  const { service, store, root, home, clock } = await fixture(
    'schedule: { cron: "*/5 * * * *", tz: "Asia/Kolkata" },',
  );

  expect((await service.listLoopies())[0]?.schedule).toEqual({
    cron: "*/5 * * * *",
    tz: "Asia/Kolkata",
    enabled: false,
    nextFireAt: null,
  });
  const saved = await service.putSchedule("service", { input: { name: "default" } });
  expect(saved).toMatchObject({ cron: "*/5 * * * *", tz: "Asia/Kolkata" });
  const other = join(root, "other");
  mkdirSync(join(other, ".loopy", "loopies"), { recursive: true });
  const otherRegistry = new Registry(home, other);
  const otherService = new LoopyService({ store, clock, registry: () => otherRegistry });
  await store.putSchedule({
    workspace: other,
    slug: "service",
    cron: "* * * * *",
    tz: "UTC",
    input: {},
    enabled: true,
    nextFireAt: "2026-10-17T00:01:00.000Z",
  });
  expect(await otherService.listSchedules()).toMatchObject([{ workspace: other }]);
  await expect(otherService.putSchedule("service", {})).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(otherService.setScheduleEnabled("service", false)).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(otherService.deleteSchedule("service")).rejects.toMatchObject({ code: "not_found" });
  await service.deleteSchedule("service");
  expect(await store.listSchedules()).toMatchObject([{ workspace: other }]);
});

test("disabled schedules stay dormant and re-enabling waits for the next slot", async () => {
  const { service, store, clock, advance } = await fixture();

  const daemon = new Daemon({
    concurrency: 4,
    store,
    clock,
    bundleHashFor: () => "bundle",
    prepare: async (run) => ({
      workflow: async () => run.input,
      executor: new FakeExecutor(),
      cwd: run.workspace,
      mode: "sandbox",
    }),
  });

  await service.putSchedule("service", {
    cron: "* * * * *",
    input: { name: "scheduled" },
    enabled: false,
  });
  advance(120_000);
  expect(await daemon.tick()).toEqual({ fired: 0, activated: 0 });
  expect(await store.listRuns()).toEqual([]);
  expect(await service.setScheduleEnabled("service", true)).toMatchObject({
    nextFireAt: "2026-10-17T00:03:00.000Z",
  });
  expect(await daemon.tick()).toEqual({ fired: 0, activated: 0 });
  advance(60_000);
  expect(await daemon.tick()).toEqual({ fired: 1, activated: 1 });
  await daemon.stop();
});

test("global schedules use the service workspace and preserve other workspaces", async () => {
  const { service, store, root, home, clock } = await fixture('scope: "global",');
  const other = join(root, "other");
  mkdirSync(join(other, ".loopy", "loopies"), { recursive: true });

  const otherService = new LoopyService({
    store,
    clock,
    registry: () => new Registry(home, other),
  });

  await service.putSchedule("service", { cron: "* * * * *", input: { name: "first" } });

  const second = await otherService.putSchedule("service", {
    cron: "0 * * * *",
    input: { name: "second" },
  });

  expect(second.workspace).toBe(other);
  expect(await service.listSchedules()).toMatchObject([
    { workspace: root, input: { name: "first" } },
  ]);
  await otherService.setScheduleEnabled("service", false);
  await otherService.deleteSchedule("service");
  expect(await store.listSchedules()).toMatchObject([{ workspace: root, enabled: true }]);
});

function pausedScheduleDaemon(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<void>();
  const bundle = Promise.withResolvers<string>();

  const daemon = new Daemon({
    concurrency: 4,
    store: f.store,
    clock: f.clock,
    bundleHashFor: () => {
      entered.resolve();

      return bundle.promise;
    },
    prepare: async (run) => ({
      workflow: async () => run.input,
      executor: new FakeExecutor(),
      cwd: run.workspace,
      mode: "sandbox",
    }),
  });

  return { daemon, entered: entered.promise, release: () => bundle.resolve("bundle") };
}

for (const mutation of ["PUT", "disable"]) {
  test(`a ${mutation} during bundle resolution rejects the pending schedule fire`, async () => {
    const f = await fixture();
    await f.service.putSchedule("service", { cron: "* * * * *", input: { name: "first" } });
    f.advance(60_000);
    const paused = pausedScheduleDaemon(f);
    const ticking = paused.daemon.tick();
    await paused.entered;

    try {
      const saved =
        mutation === "PUT"
          ? await f.service.putSchedule("service", { cron: "0 * * * *", input: { name: "new" } })
          : await f.service.setScheduleEnabled("service", false);

      expect(saved.nextFireAt).toBe(
        mutation === "PUT" ? "2026-10-17T01:00:00.000Z" : "2026-10-17T00:01:00.000Z",
      );
      paused.release();
      expect(await ticking).toEqual({ fired: 0, activated: 0 });
      expect(await f.store.listRuns()).toEqual([]);
      expect(await f.service.listSchedules()).toEqual([saved]);
    } finally {
      paused.release();
      await ticking;
      await paused.daemon.stop();
    }
  });
}

test("service cursor follows the last event without requiring a run snapshot", async () => {
  const { service, store, root } = await fixture();
  const initial = await service.cursor();
  expect(initial).toEqual({ cursor: 0, epoch: await store.epoch() });
  await service.startRun("service", { name: "Hatim" }, root);
  const current = await service.cursor();
  const events = await store.events(0, 100);
  expect(events.at(-1)?.sequence).toBe(current.cursor);
  expect(current).toEqual({ cursor: initial.cursor + 1, epoch: initial.epoch });
});

test("waiting filter runs before the page cap and preserves cursor order", async () => {
  const { service, store, root, advance } = await fixture();
  const first = await service.startRun("service", { name: "approval" }, root);
  await store.claim(first.id, "owner");
  await store.createHook(first.id, "owner", {
    runId: first.id,
    seq: 0,
    key: "approval",
    kind: "hook",
    input: { name: "approve", token: "waiting-filter" },
    status: "waiting",
    attempt: 1,
    maxAttempts: 1,
    startedAt: first.createdAt,
  });
  await store.suspend(first.id, "owner");
  await store.release(first.id, "owner");
  advance();
  const second = await service.startRun("service", { name: "sleep" }, root);
  await store.claim(second.id, "sleeper");
  await store.suspend(second.id, "sleeper", "2099-01-01T00:00:00.000Z");
  await store.release(second.id, "sleeper");
  const query = { status: "suspended", waiting: true, limit: 1 } as const;
  const page = await service.listRuns(query);
  expect(page.map((run) => run.id)).toEqual([first.id]);
  expect((await service.listRuns({ ...query, waiting: false })).map((run) => run.id)).toEqual([
    second.id,
  ]);
  expect(await service.listRuns({ ...query, before: `${first.createdAt}|${first.id}` })).toEqual(
    [],
  );
  expect(
    (await service.listRuns({ ...query, before: `${second.createdAt}|${second.id}` })).map(
      (run) => run.id,
    ),
  ).toEqual([first.id]);
});

test("service maps completion between requireRun and claim to not_claimable", async () => {
  const { service, store, root } = await fixture();
  const run = await service.startRun("service", { name: "Hatim" }, root);
  const claim = store.claim.bind(store);
  store.claim = async (id, token) => {
    await claim(id, "finisher");
    await store.finishRun(id, "finisher", { status: "succeeded", output: 1 });
    await store.release(id, "finisher");

    return claim(id, token);
  };

  await expect(service.cancelRun(run.id)).rejects.toMatchObject({
    code: "not_claimable",
    message: "The run cannot be claimed in its current state.",
  });
});

test("listLoopies reads each workspace registry once per call", async () => {
  const { service, store, root, home, clock } = await fixture();
  await service.startRun("service", { name: "Hatim" }, root);
  const other = join(root, "other");
  mkdirSync(join(other, ".loopy", "loopies"), { recursive: true });
  await store.createRun({
    id: "other-workspace",
    slug: "service",
    workspace: other,
    revision: "a".repeat(64),
    input: {},
    status: "queued",
    createdAt: new Date(clock.now()).toISOString(),
    updatedAt: new Date(clock.now()).toISOString(),
  });
  const reads = new Map<string, number>();

  class CountingRegistry extends Registry {
    override list() {
      reads.set(this.project, (reads.get(this.project) ?? 0) + 1);

      return super.list();
    }
  }

  const countingService = new LoopyService({
    store,
    clock,
    registry: (workspace) => new CountingRegistry(home, workspace === "" ? root : workspace),
  });

  for (const count of [1, 2]) {
    expect(await countingService.listLoopies()).toHaveLength(1);
    expect(reads).toEqual(
      new Map([
        [root, count],
        [other, count],
      ]),
    );
  }
});
