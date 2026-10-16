import { describe, expect, test } from "bun:test";
import type { LogRecord, RunOutcome, Schedule, StepRecord } from "../src/core/index.js";
import { OwnershipError, type RunStore } from "../src/runtime/index.js";
import { newRun } from "./fixture.js";

const STEP: StepRecord = {
  runId: "run",
  seq: 1,
  key: "test",
  kind: "function",
  status: "running",
  input: null,
  attempt: 1,
  maxAttempts: 3,
  startedAt: "2026-10-16T00:00:00.000Z",
};

const LOG: LogRecord = {
  runId: "run",
  seq: 1,
  position: { kind: "workflow", afterStep: 0, afterFinish: 0, index: 1 },
  level: "info",
  message: "hello",
  at: STEP.startedAt,
};

const OUTCOMES: RunOutcome[] = [
  { status: "succeeded", output: 42 },
  { status: "failed", error: "Failed. Fix it." },
  { status: "cancelled" },
];

type StoreFactory = (options?: {
  now: () => number;
  leaseMs: number;
}) => RunStore | Promise<RunStore>;

async function fixture(makeStore: StoreFactory) {
  const store = await makeStore();
  await store.createRun(newRun());
  expect((await store.getRun("run"))?.workspace).toBe("/workspace");

  return store;
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

    const writes = [
      () => store.suspend("run", "old"),
      () => store.finishRun("run", "old", { status: "cancelled" }),
      () => store.release("run", "old"),
      () => store.putStep("run", "old", STEP),
      () => store.appendLog("run", "old", LOG),
    ];

    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(OwnershipError);
    }
  });
}

function logSequences(makeStore: StoreFactory): void {
  test("duplicate log sequence is rejected and getLogs supports a cursor", async () => {
    const store = await fixture(makeStore);
    await store.claim("run", "owner");
    await store.appendLog("run", "owner", LOG);
    await expect(
      store.appendLog("run", "owner", { ...LOG, message: "replacement" }),
    ).rejects.toThrow("Log sequence 1 already exists");
    await store.appendLog("run", "owner", { ...LOG, seq: 2 });
    expect(await store.getLogs("run")).toEqual([LOG, { ...LOG, seq: 2 }]);
    expect(await store.getLogs("run", 1)).toEqual([{ ...LOG, seq: 2 }]);
  });
}

function stepUpsert(makeStore: StoreFactory): void {
  test("putStep upserts by sequence", async () => {
    const store = await fixture(makeStore);
    await store.claim("run", "owner");
    await store.putStep("run", "owner", STEP);

    const completed: StepRecord = {
      ...STEP,
      status: "succeeded",
      output: 42,
      endedAt: LOG.at,
      finishOrder: 1,
    };

    await store.putStep("run", "owner", completed);
    expect(await store.getSteps("run")).toEqual([completed]);
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

function recordIsolation(makeStore: StoreFactory): void {
  test("returned records and write inputs are isolated from stored state", async () => {
    const store = await fixture(makeStore);
    const claimed = await store.claim("run", "owner");
    claimed.status = "failed";
    expect((await store.getRun("run"))?.status).toBe("running");
    const step = { ...STEP };
    await store.putStep("run", "owner", step);
    step.key = "changed";
    const logs = { ...LOG };
    await store.appendLog("run", "owner", logs);
    logs.message = "changed";
    expect(await store.getSteps("run")).toEqual([STEP]);
    expect(await store.getLogs("run")).toEqual([LOG]);
  });
}

const SCHEDULE: Schedule = {
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
    const replacement = { ...SCHEDULE, enabled: false, lastFireKey: "old" };
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
    expect(
      await Promise.all([
        store.fireSchedule(SCHEDULE.workspace, "test", "key", run, next),
        store.fireSchedule(SCHEDULE.workspace, "test", "key", { ...run, id: "duplicate" }, next),
      ]),
    ).toEqual([true, false]);
    expect(await store.listRuns()).toEqual([run]);
    run.input = "changed";
    expect((await store.getRun("run"))?.input).toEqual(SCHEDULE.input);
    expect(await store.listSchedules()).toEqual([
      { ...SCHEDULE, lastFireKey: "key", nextFireAt: next },
    ]);
    expect(await store.fireSchedule(SCHEDULE.workspace, "test", "key", newRun(), LOG.at)).toBe(
      false,
    );
    expect(
      await store.fireSchedule(
        SCHEDULE.workspace,
        "test",
        "next-key",
        { ...newRun(), id: "next" },
        next,
      ),
    ).toBe(true);
    expect(await store.listRuns()).toHaveLength(2);
  });

  test("a failed schedule fire leaves both schedule and runs unchanged", async () => {
    const store = await fixture(makeStore);
    await store.putSchedule(SCHEDULE);
    await expect(
      store.fireSchedule(SCHEDULE.workspace, "test", "key", newRun(), LOG.at),
    ).rejects.toThrow("Run 'run' already exists. Use a new run ID.");
    expect(await store.listSchedules()).toEqual([SCHEDULE]);
    expect(await store.listRuns()).toEqual([newRun()]);
    await store.deleteSchedule(SCHEDULE.workspace, "test");
    await expect(
      store.fireSchedule(SCHEDULE.workspace, "test", "key", { ...newRun(), id: "missing" }, LOG.at),
    ).rejects.toThrow("Schedule 'test' does not exist. Save the schedule before firing it.");
    expect(await store.getRun("missing")).toBeUndefined();
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

function staleTakeover(makeStore: StoreFactory): void {
  test("stale takeover retries unfinished steps and fences the former owner", async () => {
    let now = Date.parse(LOG.at);
    const store = await makeStore({ now: () => now, leaseMs: 100 });
    await store.createRun({
      ...newRun(),
      status: "running",
      owner: { token: "old", host: "remote-host", pid: 0, heartbeatAt: LOG.at },
    });
    await store.putStep("run", "old", STEP);
    now += 100;
    expect(await store.dueRuns(new Date(now).toISOString())).toEqual([]);
    await expect(store.claim("run", "new")).rejects.toBeInstanceOf(OwnershipError);
    expect(await store.heartbeat("run", "old")).toBe(true);
    now += 101;
    expect((await store.dueRuns(new Date(now).toISOString())).map((run) => run.id)).toEqual([
      "run",
    ]);
    expect(await store.claim("run", "new")).toMatchObject({
      status: "running",
      owner: { token: "new" },
    });
    expect(await store.getSteps("run")).toMatchObject([
      { status: "retrying", attempt: 1, nextRetryAt: new Date(now).toISOString() },
    ]);
    expect(await store.heartbeat("run", "old")).toBe(false);
    await expect(store.putStep("run", "old", STEP)).rejects.toBeInstanceOf(OwnershipError);
    await expect(store.release("run", "old")).rejects.toBeInstanceOf(OwnershipError);
  });

  test("the same slug has independent schedules in different workspaces", async () => {
    const store = await makeStore();
    const other = { ...SCHEDULE, workspace: "/other" };
    await store.putSchedule(SCHEDULE);
    await store.putSchedule(other);
    expect(await store.listSchedules()).toEqual([SCHEDULE, other]);
    const at = "2026-10-16T00:01:00.000Z";
    expect(await store.fireSchedule(SCHEDULE.workspace, SCHEDULE.slug, "same", newRun(), at)).toBe(
      true,
    );
    expect(
      await store.fireSchedule(
        other.workspace,
        other.slug,
        "same",
        { ...newRun(), id: "other", workspace: other.workspace },
        at,
      ),
    ).toBe(true);
    await store.deleteSchedule(SCHEDULE.workspace, SCHEDULE.slug);
    expect(await store.listSchedules()).toEqual([
      { ...other, lastFireKey: "same", nextFireAt: at },
    ]);
  });
}

export function storeContract(name: string, makeStore: StoreFactory): void {
  describe(name, () => {
    staleTakeover(makeStore);
    stateMachine(makeStore);
    releaseRunning(makeStore);
    terminalTransitions(makeStore);
    ownershipFencing(makeStore);
    logSequences(makeStore);
    stepUpsert(makeStore);
    dueRuns(makeStore);
    recordIsolation(makeStore);
    schedules(makeStore);
    scheduleFires(makeStore);
    nextWakeAt(makeStore);
  });
}
