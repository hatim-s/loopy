import { describe, expect, test } from "bun:test";
import { type DashboardReader, nodeIdSchema } from "@loopy/contract";
import {
  type NodeRun,
  OwnershipError,
  type RunOutcome,
  type Schedule,
  type Store,
} from "@loopy/core";
import { Effect, Schema } from "effect";
import { newRun } from "./fixture";
import { storeRecordContract } from "./store-record-contract";

type ContractStore = Store & DashboardReader;

type StoreFactory = (options?: { leaseMs?: number }) => ContractStore | Promise<ContractStore>;

const OUTCOMES: RunOutcome[] = [
  { status: "succeeded", output: 42 },
  { status: "failed", error: "Failed. Fix it." },
  { status: "cancelled" },
];

function runningNode(): NodeRun {
  return {
    key: { runId: "run", nodeId: Schema.decodeUnknownSync(nodeIdSchema)("0:code"), scope: [] },
    attempt: 1,
    maxAttempts: 3,
    startedAt: newRun().createdAt,
    status: "running",
    receipt: "none",
  };
}

const LOG = { at: newRun().createdAt };

const allRuns = (store: ContractStore) =>
  Effect.runPromise(store.queryRuns({ limit: 200, now: LOG.at }));

const suspend = (store: ContractStore, token: string, wakeAt: string | null = null) =>
  Effect.runPromise(
    store.apply({ runId: "run", token, effects: [{ kind: "suspend_run", wakeAt }] }),
  );

const finish = (store: ContractStore, token: string, outcome: RunOutcome) =>
  Effect.runPromise(
    store.apply({ runId: "run", token, effects: [{ kind: "finish_run", outcome, at: LOG.at }] }),
  );

async function fixture(makeStore: StoreFactory) {
  const store = await makeStore();
  await Effect.runPromise(store.createRun(newRun()));

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
    await Effect.runPromise(store.putSchedule(schedule));
    schedule.input = "changed";
    const listed = await Effect.runPromise(store.listSchedules());
    expect(listed).toEqual([SCHEDULE]);
    const first = listed[0];

    if (first) {
      first.enabled = false;
      first.input = "changed again";
    }

    expect(await Effect.runPromise(store.listSchedules())).toEqual([SCHEDULE]);
    const replacement = { ...SCHEDULE, version: 2, enabled: false, lastFireKey: "old" };
    await Effect.runPromise(store.putSchedule(replacement));
    await Effect.runPromise(store.putSchedule({ ...SCHEDULE, slug: "other" }));
    expect(await Effect.runPromise(store.listSchedules())).toEqual([
      replacement,
      { ...SCHEDULE, slug: "other" },
    ]);
    await Effect.runPromise(store.deleteSchedule(SCHEDULE.workspace, "test"));
    await Effect.runPromise(store.deleteSchedule(SCHEDULE.workspace, "test"));
    expect(await Effect.runPromise(store.listSchedules())).toEqual([
      { ...SCHEDULE, slug: "other" },
    ]);
  });
}

function scheduleFires(makeStore: StoreFactory): void {
  test("competing schedule fires create exactly one run and advance the schedule atomically", async () => {
    const store = await makeStore();
    await Effect.runPromise(store.putSchedule(SCHEDULE));
    const next = "2026-10-16T00:01:00.000Z";
    const run = newRun();
    const fire = { ...SCHEDULE, fireKey: "key", run, nextFireAt: next };
    expect(
      await Promise.all([
        Effect.runPromise(store.fireSchedule(fire)),
        Effect.runPromise(store.fireSchedule({ ...fire, run: { ...run, id: "duplicate" } })),
      ]),
    ).toEqual([true, false]);
    expect(await allRuns(store)).toEqual([run]);
    run.input = "changed";
    expect((await Effect.runPromise(store.getRun("run")))?.input).toEqual(SCHEDULE.input);
    expect(await Effect.runPromise(store.listSchedules())).toEqual([
      { ...SCHEDULE, lastFireKey: "key", nextFireAt: next },
    ]);
    expect(
      await Effect.runPromise(store.fireSchedule({ ...fire, run: newRun(), nextFireAt: LOG.at })),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        store.fireSchedule({
          ...fire,
          fireKey: "next-key",
          run: { ...newRun(), id: "next" },
        }),
      ),
    ).toBe(true);
    expect(await allRuns(store)).toHaveLength(2);
  });
}

function scheduleFireFailures(makeStore: StoreFactory): void {
  test("a failed schedule fire leaves both schedule and runs unchanged", async () => {
    const store = await fixture(makeStore);
    await Effect.runPromise(store.putSchedule(SCHEDULE));
    await expect(
      Effect.runPromise(
        store.fireSchedule({
          ...SCHEDULE,
          fireKey: "key",
          run: newRun(),
          nextFireAt: LOG.at,
        }),
      ),
    ).rejects.toThrow("Run 'run' already exists. Use a new run ID.");
    expect(await Effect.runPromise(store.listSchedules())).toEqual([SCHEDULE]);
    expect(await allRuns(store)).toEqual([newRun()]);
    await Effect.runPromise(store.deleteSchedule(SCHEDULE.workspace, "test"));
    await expect(
      Effect.runPromise(
        store.fireSchedule({
          ...SCHEDULE,
          fireKey: "key",
          run: { ...newRun(), id: "missing" },
          nextFireAt: LOG.at,
        }),
      ),
    ).rejects.toThrow("Schedule 'test' does not exist. Save the schedule before firing it.");
    expect(await Effect.runPromise(store.getRun("missing"))).toBeUndefined();
  });
}

function scheduleRevisions(makeStore: StoreFactory): void {
  test("replacing a schedule rejects a stale fire without events or a run", async () => {
    const store = await makeStore();
    const original = await Effect.runPromise(store.putSchedule(SCHEDULE));
    const nextFireAt = "2026-10-16T01:00:00.000Z";

    const replacement = await Effect.runPromise(
      store.putSchedule({ ...original, cron: "0 * * * *", nextFireAt }),
    );

    expect(replacement.version).toBe(original.version + 1);
    const before = await Effect.runPromise(store.events(0, 100));
    expect(
      await Effect.runPromise(store.fireSchedule({ ...original, fireKey: "stale", run: newRun() })),
    ).toBe(false);
    expect(await allRuns(store)).toEqual([]);
    expect(await Effect.runPromise(store.listSchedules())).toEqual([replacement]);
    expect(await Effect.runPromise(store.events(0, 100))).toEqual(before);
  });
}

function scheduleAdvances(makeStore: StoreFactory): void {
  test("catch-up advances only nextFireAt and rejects stale, disabled and deleted schedules without events", async () => {
    const store = await makeStore();
    const original = await Effect.runPromise(store.putSchedule(SCHEDULE));

    const replacement = await Effect.runPromise(
      store.putSchedule({
        ...original,
        cron: "0 * * * *",
        input: "edited",
      }),
    );

    const nextFireAt = "2026-10-16T01:00:00.000Z";
    const before = await Effect.runPromise(store.events(0, 100));
    expect(await Effect.runPromise(store.advanceSchedule({ ...original, nextFireAt }))).toBe(false);
    expect(await Effect.runPromise(store.listSchedules())).toEqual([replacement]);
    expect(await Effect.runPromise(store.events(0, 100))).toEqual(before);
    expect(await Effect.runPromise(store.advanceSchedule({ ...replacement, nextFireAt }))).toBe(
      true,
    );
    const advanced = { ...replacement, nextFireAt };
    expect(await Effect.runPromise(store.listSchedules())).toEqual([advanced]);
    expect((await Effect.runPromise(store.events(0, 100))).slice(before.length)).toMatchObject([
      { entity: "schedule", kind: "saved", record: advanced },
    ]);

    const disabled = await Effect.runPromise(
      store.setScheduleEnabled({ ...advanced, enabled: false }),
    );

    const disabledEvents = await Effect.runPromise(store.events(0, 100));
    expect(
      await Effect.runPromise(
        store.advanceSchedule({ ...disabled, nextFireAt: SCHEDULE.nextFireAt }),
      ),
    ).toBe(false);
    expect(await Effect.runPromise(store.listSchedules())).toEqual([disabled]);
    expect(await Effect.runPromise(store.events(0, 100))).toEqual(disabledEvents);
    await Effect.runPromise(store.deleteSchedule(disabled.workspace, disabled.slug));
    const deletedEvents = await Effect.runPromise(store.events(0, 100));
    expect(await Effect.runPromise(store.advanceSchedule({ ...disabled, nextFireAt }))).toBe(false);
    expect(await Effect.runPromise(store.listSchedules())).toEqual([]);
    expect(await Effect.runPromise(store.events(0, 100))).toEqual(deletedEvents);
  });
}

function scheduleToggles(makeStore: StoreFactory): void {
  test("toggles preserve a concurrent PUT and fire while rejecting pre-toggle snapshots", async () => {
    const store = await makeStore();
    const original = await Effect.runPromise(store.putSchedule(SCHEDULE));

    const replacement = await Effect.runPromise(
      store.putSchedule({ ...original, cron: "0 * * * *", input: "new" }),
    );

    const nextFireAt = "2026-10-16T01:00:00.000Z";
    const fire = { ...replacement, fireKey: "current", run: newRun(), nextFireAt };
    expect(await Effect.runPromise(store.fireSchedule(fire))).toBe(true);

    const disabled = await Effect.runPromise(
      store.setScheduleEnabled({
        ...original,
        enabled: false,
        nextFireAt: undefined,
      }),
    );

    const fired = { ...replacement, nextFireAt, lastFireKey: "current" };
    expect(disabled).toEqual({ ...fired, enabled: false, version: 3 });
    const before = await Effect.runPromise(store.events(0, 100));
    expect(await Effect.runPromise(store.fireSchedule({ ...fire, fireKey: "stale" }))).toBe(false);
    expect(
      await Effect.runPromise(
        store.fireSchedule({ ...fire, version: disabled.version, fireKey: "disabled" }),
      ),
    ).toBe(false);
    expect(await allRuns(store)).toHaveLength(1);
    expect(await Effect.runPromise(store.events(0, 100))).toEqual(before);

    const enabled = await Effect.runPromise(
      store.setScheduleEnabled({ ...disabled, enabled: true, nextFireAt }),
    );

    expect(enabled).toEqual({ ...disabled, enabled: true, version: 4 });
  });
}

function nextWakeAt(makeStore: StoreFactory): void {
  test("nextWakeAt returns the earliest suspended unowned wake and excludes all other states", async () => {
    const store = await makeStore();
    expect(await Effect.runPromise(store.nextWakeAt())).toBeUndefined();
    await Effect.runPromise(store.createRun({ ...newRun(), id: "queued" }));
    await Effect.runPromise(
      store.createRun({ ...newRun(), id: "done", status: "succeeded", output: null }),
    );
    await Effect.runPromise(
      store.createRun({ ...newRun(), id: "no-wake", status: "suspended", wakeAt: null }),
    );
    await Effect.runPromise(
      store.createRun({
        ...newRun(),
        id: "owned",
        status: "suspended",
        wakeAt: LOG.at,
        owner: { token: "owner", host: "test", pid: 0, heartbeatAt: LOG.at },
      }),
    );
    expect(await Effect.runPromise(store.nextWakeAt())).toBeUndefined();
    const early = "2026-10-16T00:01:00.000Z";
    await Effect.runPromise(
      store.createRun({
        ...newRun(),
        id: "late",
        status: "suspended",
        wakeAt: "2026-10-16T00:02:00.000Z",
      }),
    );
    await Effect.runPromise(
      store.createRun({ ...newRun(), id: "early", status: "suspended", wakeAt: early }),
    );
    expect(await Effect.runPromise(store.nextWakeAt())).toBe(early);
    await Effect.runPromise(store.claim("early", "owner"));
    expect(await Effect.runPromise(store.nextWakeAt())).toBe("2026-10-16T00:02:00.000Z");
  });
}

function rateLimits(makeStore: StoreFactory): void {
  test("rate limits share a fixed window and reset at its boundary", async () => {
    const store = await makeStore();
    const now = "2026-10-16T00:00:00.000Z";
    const retryAt = "2026-10-16T00:01:00.000Z";
    expect(
      await Promise.all(
        Array.from({ length: 3 }, () =>
          Effect.runPromise(store.acquireRateLimit("codex", 2, 60_000, now)),
        ),
      ),
    ).toEqual([{ ok: true }, { ok: true }, { ok: false, retryAt }]);
    expect(await Effect.runPromise(store.acquireRateLimit("gh", 2, 60_000, now))).toEqual({
      ok: true,
    });
    expect(
      await Effect.runPromise(
        store.acquireRateLimit("codex", 2, 60_000, "2026-10-16T00:00:59.999Z"),
      ),
    ).toEqual({
      ok: false,
      retryAt,
    });
    expect(await Effect.runPromise(store.acquireRateLimit("codex", 2, 60_000, retryAt))).toEqual({
      ok: true,
    });
  });
}

function eventCursors(makeStore: StoreFactory): void {
  test("global cursor survives pruning and agrees with run snapshots", async () => {
    const store = await makeStore();
    const initial = await Effect.runPromise(store.eventCursor());
    expect(initial).toEqual({ cursor: 0, epoch: await Effect.runPromise(store.epoch()) });
    await Effect.runPromise(store.createRun(newRun()));
    await Effect.runPromise(store.createRun({ ...newRun(), id: "other" }));
    const current = await Effect.runPromise(store.eventCursor());
    expect(current).toEqual({ cursor: 2, epoch: initial.epoch });
    expect((await Effect.runPromise(store.events(0, 100))).at(-1)?.sequence).toBe(current.cursor);
    expect(await Effect.runPromise(store.dashboardSnapshot("run"))).toMatchObject(current);
    expect(await Effect.runPromise(store.pruneEvents("2100-01-01T00:00:00.000Z"))).toBe(2);
    expect(await Effect.runPromise(store.events(0, 100))).toEqual([]);
    expect(await Effect.runPromise(store.eventCursor())).toEqual(current);
    await Effect.runPromise(store.createRun({ ...newRun(), id: "after-pruning" }));
    expect(await Effect.runPromise(store.eventCursor())).toEqual({
      cursor: 3,
      epoch: initial.epoch,
    });
  });
}

function stateMachine(makeStore: StoreFactory): void {
  test("claim heartbeat suspend release and reclaim follow the state machine", async () => {
    const store = await fixture(makeStore);
    expect(await Effect.runPromise(store.heartbeat("run", "owner"))).toBe(false);
    const run = await Effect.runPromise(store.claim("run", "owner"));
    expect(run).toMatchObject({ status: "running", owner: { token: "owner" } });
    expect(await Effect.runPromise(store.heartbeat("run", "owner"))).toBe(true);
    await expect(Effect.runPromise(store.claim("run", "other"))).rejects.toBeInstanceOf(
      OwnershipError,
    );
    await suspend(store, "owner", LOG.at);
    await expect(suspend(store, "owner")).rejects.toThrow("cannot transition from 'suspended'");
    await expect(finish(store, "owner", { status: "succeeded", output: 42 })).rejects.toThrow(
      "cannot transition from 'suspended'",
    );
    await Effect.runPromise(store.release("run", "owner"));
    expect((await Effect.runPromise(store.getRun("run")))?.owner).toBeUndefined();
    expect((await Effect.runPromise(store.claim("run", "next"))).status).toBe("running");
  });
}

function releaseRunning(makeStore: StoreFactory): void {
  test("release of a running run suspends it at release time and permits reclaim", async () => {
    const store = await fixture(makeStore);
    await Effect.runPromise(store.claim("run", "owner"));
    const before = new Date().toISOString();
    await Effect.runPromise(store.release("run", "owner"));
    const after = new Date().toISOString();
    const run = await Effect.runPromise(store.getRun("run"));

    if (run?.status !== "suspended" || run.wakeAt === null) {
      throw new Error("Expected a suspended run with a wake time.");
    }

    expect(run.owner).toBeUndefined();
    expect(run.wakeAt).toBe(run.updatedAt);
    expect(run.wakeAt.localeCompare(before)).toBeGreaterThanOrEqual(0);
    expect(run.wakeAt.localeCompare(after)).toBeLessThanOrEqual(0);
    expect((await Effect.runPromise(store.dueRuns(after))).map((due) => due.id)).toEqual(["run"]);
    expect((await Effect.runPromise(store.claim("run", "next"))).status).toBe("running");
  });
}

function terminalTransitions(makeStore: StoreFactory): void {
  for (const outcome of OUTCOMES) {
    test(`terminal ${outcome.status} cannot be overwritten or suspended`, async () => {
      const store = await fixture(makeStore);
      await Effect.runPromise(store.claim("run", "owner"));
      await finish(store, "owner", outcome);
      await expect(finish(store, "owner", outcome)).rejects.toThrow(
        `cannot transition from '${outcome.status}'`,
      );
      await expect(suspend(store, "owner")).rejects.toThrow(
        `cannot transition from '${outcome.status}'`,
      );
      expect(await Effect.runPromise(store.getRun("run"))).toMatchObject(outcome);
      await Effect.runPromise(store.release("run", "owner"));
      await expect(Effect.runPromise(store.claim("run", "owner"))).rejects.toThrow(
        "cannot be claimed",
      );
    });
  }
}

function ownershipFencing(makeStore: StoreFactory): void {
  test("ownership fences stale writes and heartbeat reports lost ownership", async () => {
    const store = await fixture(makeStore);
    await Effect.runPromise(store.claim("run", "old"));
    await suspend(store, "old");
    await Effect.runPromise(store.release("run", "old"));
    await Effect.runPromise(store.claim("run", "new"));
    expect(await Effect.runPromise(store.heartbeat("run", "old"))).toBe(false);

    const node = runningNode();

    const writes = [
      () => suspend(store, "old"),
      () => Effect.runPromise(store.release("run", "old")),
      () =>
        Effect.runPromise(
          store.apply({
            runId: "run",
            token: "old",
            effects: [{ kind: "write_node_run", nodeRun: node }],
          }),
        ),
      () =>
        Effect.runPromise(
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
        ),
      () =>
        Effect.runPromise(
          store.apply({
            runId: "run",
            token: "old",
            effects: [{ kind: "schedule_activation", at: LOG.at }],
          }),
        ),
      () =>
        Effect.runPromise(
          store.apply({
            runId: "run",
            token: "old",
            effects: [{ kind: "finish_run", outcome: { status: "cancelled" }, at: LOG.at }],
          }),
        ),
    ];

    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(OwnershipError);
    }
  });
}

function dueRuns(makeStore: StoreFactory): void {
  test("dueRuns includes queued and due suspensions but excludes owned and future runs", async () => {
    const store = await fixture(makeStore);
    expect((await Effect.runPromise(store.dueRuns(LOG.at))).map((run) => run.id)).toEqual(["run"]);
    await Effect.runPromise(store.claim("run", "owner"));
    expect(await Effect.runPromise(store.dueRuns(LOG.at))).toEqual([]);
    await suspend(store, "owner");
    await Effect.runPromise(store.release("run", "owner"));
    expect(await Effect.runPromise(store.dueRuns(LOG.at))).toEqual([]);
    await Effect.runPromise(store.claim("run", "owner"));
    await suspend(store, "owner", "2026-10-16T01:00:00.000Z");
    await Effect.runPromise(store.release("run", "owner"));
    expect(await Effect.runPromise(store.dueRuns(LOG.at))).toEqual([]);
    expect(
      (await Effect.runPromise(store.dueRuns("2026-10-16T01:00:00.000Z"))).map((run) => run.id),
    ).toEqual(["run"]);
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
      expect(await Effect.runPromise(store.wakeRun("missing", LOG.at))).toBe("not_found");
      expect(await Effect.runPromise(store.wakeRun("run", LOG.at))).toBeUndefined();
      await Effect.runPromise(store.claim("run", "owner"));
      const cursor = await Effect.runPromise(store.eventCursor());
      expect(await Effect.runPromise(store.wakeRun("run", LOG.at))).toBe("owned_elsewhere");
      expect(await Effect.runPromise(store.eventCursor())).toEqual(cursor);
      await finish(store, "owner", { status: "succeeded", output: null });
      await Effect.runPromise(store.release("run", "owner"));
      expect(await Effect.runPromise(store.wakeRun("run", LOG.at))).toBe("not_claimable");
    });

    test("atomic effects roll back node writes, finish and outbox on failure", async () => {
      const store = await fixture(makeStore);
      await Effect.runPromise(store.claim("run", "owner"));

      const node: NodeRun = {
        key: { runId: "run", nodeId: Schema.decodeUnknownSync(nodeIdSchema)("0:code"), scope: [] },
        attempt: 1,
        maxAttempts: 3,
        startedAt: LOG.at,
        status: "running",
        receipt: "none",
      };

      const before = await Effect.runPromise(store.events(0, 100));
      await expect(
        Effect.runPromise(
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
        ),
      ).rejects.toThrow("1 MiB");
      expect(await Effect.runPromise(store.getNodeRuns("run"))).toEqual([]);
      expect(await Effect.runPromise(store.events(0, 100))).toEqual(before);
      expect((await Effect.runPromise(store.getRun("run")))?.status).toBe("running");
      await Effect.runPromise(
        store.apply({
          runId: "run",
          token: "owner",
          effects: [
            { kind: "write_node_run", nodeRun: node },
            { kind: "finish_run", outcome: { status: "succeeded", output: 3 }, at: LOG.at },
          ],
        }),
      );
      expect(await Effect.runPromise(store.getNodeRuns("run"))).toEqual([node]);
      const events = (await Effect.runPromise(store.events(0, 100))).slice(before.length);
      expect(events.map((event) => event.entity)).toEqual(["node", "run"]);
      expect(new Set(events.map((event) => event.txn)).size).toBe(1);
      await expect(
        Effect.runPromise(store.apply({ runId: "run", token: "old", effects: [] })),
      ).rejects.toBeInstanceOf(OwnershipError);
    });
  });
}
