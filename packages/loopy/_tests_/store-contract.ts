import { describe, expect, test } from "bun:test";
import type { EngineLog, EngineStep, RunOutcome } from "../src/core/index.js";
import { OwnershipError, type RunStore } from "../src/runtime/index.js";
import { newRun } from "./engine-fixture.js";

const STEP: EngineStep = {
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

const LOG: EngineLog = {
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

type StoreFactory = () => RunStore | Promise<RunStore>;

async function fixture(makeStore: StoreFactory) {
  const store = await makeStore();
  await store.createRun(newRun());

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

    const completed: EngineStep = {
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

export function storeContract(name: string, makeStore: StoreFactory): void {
  describe(name, () => {
    stateMachine(makeStore);
    releaseRunning(makeStore);
    terminalTransitions(makeStore);
    ownershipFencing(makeStore);
    logSequences(makeStore);
    stepUpsert(makeStore);
    dueRuns(makeStore);
    recordIsolation(makeStore);
  });
}
