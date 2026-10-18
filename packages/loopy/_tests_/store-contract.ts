import { describe, expect, test } from "bun:test";
import { nodeIdSchema } from "../src/contract/index.js";
import {
  type NodeRun,
  OwnershipError,
  type RunOutcome,
  type Schedule,
  type Store,
} from "../src/core/index.js";
import { newRun } from "./fixture.js";
import { storeRecordContract } from "./store-record-contract.js";

type StoreFactory = (options?: { now?: () => number; leaseMs?: number }) => Store | Promise<Store>;

const OUTCOMES: RunOutcome[] = [
  { status: "succeeded", output: 42 },
  { status: "failed", error: "Failed. Fix it." },
  { status: "cancelled" },
];

function runningNode(): NodeRun {
  return {
    key: { runId: "run", nodeId: nodeIdSchema.parse("0:code"), scope: [] },
    attempt: 1,
    maxAttempts: 3,
    startedAt: newRun().createdAt,
    status: "running",
    receipt: "none",
  };
}

const LOG = { at: newRun().createdAt };

async function fixture(makeStore: StoreFactory) {
  const store = await makeStore();
  await store.createRun(newRun());

  return store;
}

const SCHEDULE: Schedule = {
  version: 1,
  workspace: "/workspace",
  slug: "test",
  cron: "* * * * *",
  tz: "UTC",
  input: { value: 42 },
  enabled: true,
  nextFireAt: LOG.at,
};

function schedules(makeStore: StoreFactory): void {
  test("schedules upsert by slug, isolate records, and delete idempotently", async () => {
    const store = await makeStore();
    const schedule = structuredClone(SCHEDULE);
    await store.putSchedule(schedule);
    schedule.input = "changed";
    const listed = await store.listSchedules();
    expect(listed).toEqual([SCHEDULE]);
    const first = listed[0];

    if (first) {
      first.enabled = false;
      first.input = "changed again";
    }

    expect(await store.listSchedules()).toEqual([SCHEDULE]);
    const replacement = { ...SCHEDULE, version: 2, enabled: false, lastFireKey: "old" };
    await store.putSchedule(replacement);
    await store.putSchedule({ ...SCHEDULE, slug: "other" });
    expect(await store.listSchedules()).toEqual([replacement, { ...SCHEDULE, slug: "other" }]);
    await store.deleteSchedule(SCHEDULE.workspace, "test");
    await store.deleteSchedule(SCHEDULE.workspace, "test");
    expect(await store.listSchedules()).toEqual([{ ...SCHEDULE, slug: "other" }]);
  });
}

function scheduleFires(makeStore: StoreFactory): void {
  test("competing schedule fires create exactly one run and advance the schedule atomically", async () => {
    const store = await makeStore();
    await store.putSchedule(SCHEDULE);
    const next = "2026-10-16T00:01:00.000Z";
    const run = newRun();
    const fire = { ...SCHEDULE, fireKey: "key", run, nextFireAt: next };
    expect(
      await Promise.all([
        store.fireSchedule(fire),
        store.fireSchedule({ ...fire, run: { ...run, id: "duplicate" } }),
      ]),
    ).toEqual([true, false]);
    expect(await store.listRuns()).toEqual([run]);
    run.input = "changed";
    expect((await store.getRun("run"))?.input).toEqual(SCHEDULE.input);
    expect(await store.listSchedules()).toEqual([
      { ...SCHEDULE, lastFireKey: "key", nextFireAt: next },
    ]);
    expect(await store.fireSchedule({ ...fire, run: newRun(), nextFireAt: LOG.at })).toBe(false);
    expect(
      await store.fireSchedule({
        ...fire,
        fireKey: "next-key",
        run: { ...newRun(), id: "next" },
      }),
    ).toBe(true);
    expect(await store.listRuns()).toHaveLength(2);
  });
}

function scheduleFireFailures(makeStore: StoreFactory): void {
  test("a failed schedule fire leaves both schedule and runs unchanged", async () => {
    const store = await fixture(makeStore);
    await store.putSchedule(SCHEDULE);
    await expect(
      store.fireSchedule({
        ...SCHEDULE,
        fireKey: "key",
        run: newRun(),
        nextFireAt: LOG.at,
      }),
    ).rejects.toThrow("Run 'run' already exists. Use a new run ID.");
    expect(await store.listSchedules()).toEqual([SCHEDULE]);
    expect(await store.listRuns()).toEqual([newRun()]);
    await store.deleteSchedule(SCHEDULE.workspace, "test");
    await expect(
      store.fireSchedule({
        ...SCHEDULE,
        fireKey: "key",
        run: { ...newRun(), id: "missing" },
        nextFireAt: LOG.at,
      }),
    ).rejects.toThrow("Schedule 'test' does not exist. Save the schedule before firing it.");
    expect(await store.getRun("missing")).toBeUndefined();
  });
}

function scheduleRevisions(makeStore: StoreFactory): void {
  test("replacing a schedule rejects a stale fire without events or a run", async () => {
    const store = await makeStore();
    const original = await store.putSchedule(SCHEDULE);
    const nextFireAt = "2026-10-16T01:00:00.000Z";
    const replacement = await store.putSchedule({ ...original, cron: "0 * * * *", nextFireAt });
    expect(replacement.version).toBe(original.version + 1);
    const before = await store.events(0, 100);
    expect(await store.fireSchedule({ ...original, fireKey: "stale", run: newRun() })).toBe(false);
    expect(await store.listRuns()).toEqual([]);
    expect(await store.listSchedules()).toEqual([replacement]);
    expect(await store.events(0, 100)).toEqual(before);
  });
}

function scheduleAdvances(makeStore: StoreFactory): void {
  test("catch-up advances only nextFireAt and rejects stale, disabled and deleted schedules without events", async () => {
    const store = await makeStore();
    const original = await store.putSchedule(SCHEDULE);

    const replacement = await store.putSchedule({
      ...original,
      cron: "0 * * * *",
      input: "edited",
    });

    const nextFireAt = "2026-10-16T01:00:00.000Z";
    const before = await store.events(0, 100);
    expect(await store.advanceSchedule({ ...original, nextFireAt })).toBe(false);
    expect(await store.listSchedules()).toEqual([replacement]);
    expect(await store.events(0, 100)).toEqual(before);
    expect(await store.advanceSchedule({ ...replacement, nextFireAt })).toBe(true);
    const advanced = { ...replacement, nextFireAt };
    expect(await store.listSchedules()).toEqual([advanced]);
    expect((await store.events(0, 100)).slice(before.length)).toMatchObject([
      { entity: "schedule", kind: "saved", record: advanced },
    ]);
    const disabled = await store.setScheduleEnabled({ ...advanced, enabled: false });
    const disabledEvents = await store.events(0, 100);
    expect(await store.advanceSchedule({ ...disabled, nextFireAt: SCHEDULE.nextFireAt })).toBe(
      false,
    );
    expect(await store.listSchedules()).toEqual([disabled]);
    expect(await store.events(0, 100)).toEqual(disabledEvents);
    await store.deleteSchedule(disabled.workspace, disabled.slug);
    const deletedEvents = await store.events(0, 100);
    expect(await store.advanceSchedule({ ...disabled, nextFireAt })).toBe(false);
    expect(await store.listSchedules()).toEqual([]);
    expect(await store.events(0, 100)).toEqual(deletedEvents);
  });
}

function scheduleToggles(makeStore: StoreFactory): void {
  test("toggles preserve a concurrent PUT and fire while rejecting pre-toggle snapshots", async () => {
    const store = await makeStore();
    const original = await store.putSchedule(SCHEDULE);
    const replacement = await store.putSchedule({ ...original, cron: "0 * * * *", input: "new" });
    const nextFireAt = "2026-10-16T01:00:00.000Z";
    const fire = { ...replacement, fireKey: "current", run: newRun(), nextFireAt };
    expect(await store.fireSchedule(fire)).toBe(true);

    const disabled = await store.setScheduleEnabled({
      ...original,
      enabled: false,
      nextFireAt: undefined,
    });

    const fired = { ...replacement, nextFireAt, lastFireKey: "current" };
    expect(disabled).toEqual({ ...fired, enabled: false, version: 3 });
    const before = await store.events(0, 100);
    expect(await store.fireSchedule({ ...fire, fireKey: "stale" })).toBe(false);
    expect(
      await store.fireSchedule({ ...fire, version: disabled.version, fireKey: "disabled" }),
    ).toBe(false);
    expect(await store.listRuns()).toHaveLength(1);
    expect(await store.events(0, 100)).toEqual(before);
    const enabled = await store.setScheduleEnabled({ ...disabled, enabled: true, nextFireAt });
    expect(enabled).toEqual({ ...disabled, enabled: true, version: 4 });
  });
}

function nextWakeAt(makeStore: StoreFactory): void {
  test("nextWakeAt returns the earliest suspended unowned wake and excludes all other states", async () => {
    const store = await makeStore();
    expect(await store.nextWakeAt()).toBeUndefined();
    await store.createRun({ ...newRun(), id: "queued", wakeAt: LOG.at });
    await store.createRun({ ...newRun(), id: "done", status: "succeeded", wakeAt: LOG.at });
    await store.createRun({ ...newRun(), id: "no-wake", status: "suspended" });
    await store.createRun({
      ...newRun(),
      id: "owned",
      status: "suspended",
      wakeAt: LOG.at,
      owner: { token: "owner", host: "test", pid: 0, heartbeatAt: LOG.at },
    });
    expect(await store.nextWakeAt()).toBeUndefined();
    const early = "2026-10-16T00:01:00.000Z";
    await store.createRun({
      ...newRun(),
      id: "late",
      status: "suspended",
      wakeAt: "2026-10-16T00:02:00.000Z",
    });
    await store.createRun({ ...newRun(), id: "early", status: "suspended", wakeAt: early });
    expect(await store.nextWakeAt()).toBe(early);
    await store.claim("early", "owner");
    expect(await store.nextWakeAt()).toBe("2026-10-16T00:02:00.000Z");
  });
}

function rateLimits(makeStore: StoreFactory): void {
  test("rate limits share a fixed window and reset at its boundary", async () => {
    const store = await makeStore();
    const now = "2026-10-16T00:00:00.000Z";
    const retryAt = "2026-10-16T00:01:00.000Z";
    expect(
      await Promise.all(
        Array.from({ length: 3 }, () => store.acquireRateLimit("codex", 2, 60_000, now)),
      ),
    ).toEqual([{ ok: true }, { ok: true }, { ok: false, retryAt }]);
    expect(await store.acquireRateLimit("gh", 2, 60_000, now)).toEqual({ ok: true });
    expect(await store.acquireRateLimit("codex", 2, 60_000, "2026-10-16T00:00:59.999Z")).toEqual({
      ok: false,
      retryAt,
    });
    expect(await store.acquireRateLimit("codex", 2, 60_000, retryAt)).toEqual({ ok: true });
  });
}

function eventCursors(makeStore: StoreFactory): void {
  test("global cursor survives pruning and agrees with run snapshots", async () => {
    const store = await makeStore();
    const initial = await store.eventCursor();
    expect(initial).toEqual({ cursor: 0, epoch: await store.epoch() });
    await store.createRun(newRun());
    await store.createRun({ ...newRun(), id: "other" });
    const current = await store.eventCursor();
    expect(current).toEqual({ cursor: 2, epoch: initial.epoch });
    expect((await store.events(0, 100)).at(-1)?.sequence).toBe(current.cursor);
    expect(await store.snapshotRun("run")).toMatchObject(current);
    expect(await store.pruneEvents("2100-01-01T00:00:00.000Z")).toBe(2);
    expect(await store.events(0, 100)).toEqual([]);
    expect(await store.eventCursor()).toEqual(current);
    await store.createRun({ ...newRun(), id: "after-pruning" });
    expect(await store.eventCursor()).toEqual({ cursor: 3, epoch: initial.epoch });
  });
}

function stateMachine(makeStore: StoreFactory): void {
  test("claim heartbeat suspend release and reclaim follow the state machine", async () => {
    const store = await fixture(makeStore);
    expect(await store.heartbeat("run", "owner")).toBe(false);
    const run = await store.claim("run", "owner");
    expect(run).toMatchObject({ status: "running", owner: { token: "owner" } });
    expect(await store.heartbeat("run", "owner")).toBe(true);
    await expect(store.claim("run", "other")).rejects.toBeInstanceOf(OwnershipError);
    await store.suspend("run", "owner", LOG.at);
    await expect(store.suspend("run", "owner")).rejects.toThrow(
      "cannot transition from 'suspended'",
    );
    await expect(
      store.finishRun("run", "owner", { status: "succeeded", output: 42 }),
    ).rejects.toThrow("cannot transition from 'suspended'");
    await store.release("run", "owner");
    expect((await store.getRun("run"))?.owner).toBeUndefined();
    expect((await store.claim("run", "next")).status).toBe("running");
  });
}

function releaseRunning(makeStore: StoreFactory): void {
  test("release of a running run suspends it at release time and permits reclaim", async () => {
    const store = await fixture(makeStore);
    await store.claim("run", "owner");
    const before = new Date().toISOString();
    await store.release("run", "owner");
    const after = new Date().toISOString();
    const run = await store.getRun("run");
    expect(run?.status).toBe("suspended");
    expect(run?.owner).toBeUndefined();
    expect(run?.wakeAt).toBe(run?.updatedAt);
    expect(run?.wakeAt).toBeDefined();
    expect(run?.wakeAt?.localeCompare(before)).toBeGreaterThanOrEqual(0);
    expect(run?.wakeAt?.localeCompare(after)).toBeLessThanOrEqual(0);
    expect((await store.dueRuns(after)).map((due) => due.id)).toEqual(["run"]);
    expect((await store.claim("run", "next")).status).toBe("running");
  });
}

function terminalTransitions(makeStore: StoreFactory): void {
  for (const outcome of OUTCOMES) {
    test(`terminal ${outcome.status} cannot be overwritten or suspended`, async () => {
      const store = await fixture(makeStore);
      await store.claim("run", "owner");
      await store.finishRun("run", "owner", outcome);
      await expect(store.finishRun("run", "owner", outcome)).rejects.toThrow(
        `cannot transition from '${outcome.status}'`,
      );
      await expect(store.suspend("run", "owner")).rejects.toThrow(
        `cannot transition from '${outcome.status}'`,
      );
      expect(await store.getRun("run")).toMatchObject(outcome);
      await store.release("run", "owner");
      await expect(store.claim("run", "owner")).rejects.toThrow("cannot be claimed");
    });
  }
}

function ownershipFencing(makeStore: StoreFactory): void {
  test("ownership fences stale writes and heartbeat reports lost ownership", async () => {
    const store = await fixture(makeStore);
    await store.claim("run", "old");
    await store.suspend("run", "old");
    await store.release("run", "old");
    await store.claim("run", "new");
    expect(await store.heartbeat("run", "old")).toBe(false);

    const node = runningNode();

    const writes = [
      () => store.suspend("run", "old"),
      () => store.finishRun("run", "old", { status: "cancelled" }),
      () => store.release("run", "old"),
      () =>
        store.apply({
          runId: "run",
          token: "old",
          effects: [{ kind: "write_node_run", nodeRun: node }],
        }),
      () =>
        store.apply({
          runId: "run",
          token: "old",
          effects: [
            {
              kind: "write_log",
              executionKey: node.key,
              attempt: 1,
              log: { message: "hello", data: null },
              at: LOG.at,
            },
          ],
        }),
      () =>
        store.apply({
          runId: "run",
          token: "old",
          effects: [{ kind: "schedule_retry", at: LOG.at }],
        }),
      () =>
        store.apply({
          runId: "run",
          token: "old",
          effects: [{ kind: "finish_run", outcome: { status: "cancelled" }, at: LOG.at }],
        }),
    ];

    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(OwnershipError);
    }
  });
}

function dueRuns(makeStore: StoreFactory): void {
  test("dueRuns includes queued and due suspensions but excludes owned and future runs", async () => {
    const store = await fixture(makeStore);
    expect((await store.dueRuns(LOG.at)).map((run) => run.id)).toEqual(["run"]);
    await store.claim("run", "owner");
    expect(await store.dueRuns(LOG.at)).toEqual([]);
    await store.suspend("run", "owner");
    await store.release("run", "owner");
    expect(await store.dueRuns(LOG.at)).toEqual([]);
    await store.claim("run", "owner");
    await store.suspend("run", "owner", "2026-10-16T01:00:00.000Z");
    await store.release("run", "owner");
    expect(await store.dueRuns(LOG.at)).toEqual([]);
    expect((await store.dueRuns("2026-10-16T01:00:00.000Z")).map((run) => run.id)).toEqual(["run"]);
  });
}

export function storeContract(name: string, makeStore: StoreFactory): void {
  describe(name, () => {
    storeRecordContract(makeStore);
    stateMachine(makeStore);
    releaseRunning(makeStore);
    terminalTransitions(makeStore);
    ownershipFencing(makeStore);
    dueRuns(makeStore);
    schedules(makeStore);
    scheduleFires(makeStore);
    scheduleFireFailures(makeStore);
    scheduleRevisions(makeStore);
    scheduleAdvances(makeStore);
    scheduleToggles(makeStore);
    nextWakeAt(makeStore);
    rateLimits(makeStore);
    eventCursors(makeStore);

    test("wake rejects live ownership and terminal runs without publishing mutations", async () => {
      const store = await fixture(makeStore);
      expect(await store.wakeRun("missing", LOG.at)).toBe("not_found");
      expect(await store.wakeRun("run", LOG.at)).toBeUndefined();
      await store.claim("run", "owner");
      const cursor = await store.eventCursor();
      expect(await store.wakeRun("run", LOG.at)).toBe("owned_elsewhere");
      expect(await store.eventCursor()).toEqual(cursor);
      await store.finishRun("run", "owner", { status: "succeeded", output: null });
      await store.release("run", "owner");
      expect(await store.wakeRun("run", LOG.at)).toBe("not_claimable");
    });

    test("atomic effects roll back node writes, finish and outbox on failure", async () => {
      const store = await fixture(makeStore);
      await store.claim("run", "owner");

      const node: NodeRun = {
        key: { runId: "run", nodeId: nodeIdSchema.parse("0:code"), scope: [] },
        attempt: 1,
        maxAttempts: 3,
        startedAt: LOG.at,
        status: "running",
        receipt: "none",
      };

      const before = await store.events(0, 100);
      await expect(
        store.apply({
          runId: "run",
          token: "owner",
          effects: [
            { kind: "write_node_run", nodeRun: node },
            { kind: "finish_run", outcome: { status: "succeeded", output: 3 }, at: LOG.at },
            {
              kind: "write_node_run",
              nodeRun: {
                ...node,
                status: "succeeded",
                output: "x".repeat(1024 * 1024),
                endedAt: LOG.at,
              },
            },
          ],
        }),
      ).rejects.toThrow("1 MiB");
      expect(await store.getNodeRuns("run")).toEqual([]);
      expect(await store.events(0, 100)).toEqual(before);
      expect((await store.getRun("run"))?.status).toBe("running");
      await store.apply({
        runId: "run",
        token: "owner",
        effects: [
          { kind: "write_node_run", nodeRun: node },
          { kind: "finish_run", outcome: { status: "succeeded", output: 3 }, at: LOG.at },
        ],
      });
      expect(await store.getNodeRuns("run")).toEqual([node]);
      const events = (await store.events(0, 100)).slice(before.length);
      expect(events.map((event) => event.entity)).toEqual(["node", "run"]);
      expect(new Set(events.map((event) => event.txn)).size).toBe(1);
      await expect(store.apply({ runId: "run", token: "old", effects: [] })).rejects.toBeInstanceOf(
        OwnershipError,
      );
    });
  });
}
