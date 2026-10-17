import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { RunSnapshotView, RunView, ServerEvent } from "loopy/contract";
import { type EventDraft, fakeBackend } from "../src/backend/fake.ts";
import { keys } from "../src/lib/keys.ts";
import { applyBatch, applyToSnapshot, followRun } from "../src/lib/stream.ts";

const AT = "2026-10-17T10:00:00.000Z";

const run: RunView = {
  id: "run-1",
  slug: "triage",
  workspace: "/work",
  bundleHash: "hash",
  input: null,
  createdAt: AT,
  updatedAt: AT,
  owner: null,
  ownerStale: false,
  waitingOn: null,
  status: "queued",
};

function snapshot(overrides: Partial<RunSnapshotView> = {}): RunSnapshotView {
  return { run, steps: [], logs: [], hooks: [], cursor: 10, epoch: "e1", ...overrides };
}

function event(sequence: number, body: EventDraft): ServerEvent {
  return { ...body, sequence, at: AT, txn: `t${sequence}` };
}

function runEvent(sequence: number, record: RunView) {
  return event(sequence, { entity: "run", kind: "claimed", runId: record.id, record });
}

function logEvent(sequence: number, seq: number) {
  return event(sequence, {
    entity: "log",
    kind: "written",
    runId: "run-1",
    record: {
      runId: "run-1",
      seq,
      position: { kind: "workflow", afterStep: 0, afterFinish: 0, index: seq },
      level: "info",
      message: `log ${seq}`,
      at: AT,
    },
  });
}

function stepEvent(sequence: number, seq: number, status: "running" | "waiting") {
  const base = {
    runId: "run-1",
    seq,
    key: `step-${seq}`,
    kind: "hook",
    input: null,
    attempt: 1,
    maxAttempts: 1,
    startedAt: AT,
  } as const;

  return event(sequence, {
    entity: "step",
    kind: status,
    runId: "run-1",
    record:
      status === "waiting"
        ? { ...base, status, wakeAt: "2026-10-17T11:00:00.000Z" }
        : { ...base, status },
  });
}

const hook = { token: "tok", runId: "run-1", seq: 1, name: "approve", createdAt: AT };

function hookEvent(sequence: number, kind: "created" | "resolved") {
  const record = kind === "resolved" ? { ...hook, resolvedAt: AT, payload: true } : hook;

  return event(sequence, { entity: "hook", kind, runId: "run-1", record });
}

const running: RunView = { ...run, status: "running", updatedAt: "2026-10-17T10:00:01.000Z" };

test("a run event replaces the snapshot run and every list entry for that run", () => {
  const client = new QueryClient();
  const other = { ...run, id: "run-2" };
  client.setQueryData(keys.run("run-1"), snapshot());
  client.setQueryData(keys.runs({}), [run, other]);
  client.setQueryData(keys.runs({ slug: "triage" }), [run]);

  applyBatch(client, [runEvent(11, running)]);

  expect(client.getQueryData<RunSnapshotView>(keys.run("run-1"))?.run).toEqual(running);
  expect(client.getQueryData<RunView[]>(keys.runs({}))).toEqual([running, other]);
  expect(client.getQueryData<RunView[]>(keys.runs({ slug: "triage" }))).toEqual([running]);
});

test("a list keeps a run that is newer than the event", () => {
  const client = new QueryClient();
  client.setQueryData(keys.runs({}), [running]);

  applyBatch(client, [runEvent(11, run)]);

  expect(client.getQueryData<RunView[]>(keys.runs({}))).toEqual([running]);
});

test("logs and steps land in seq order whatever order the events arrive in", () => {
  const next = [logEvent(13, 3), logEvent(12, 1), stepEvent(14, 2, "running"), logEvent(11, 2)]
    .sort((a, b) => a.sequence - b.sequence)
    .reduce(applyToSnapshot, snapshot());

  expect(next.logs.map((log) => log.seq)).toEqual([1, 2, 3]);
  expect(next.steps.map((step) => step.seq)).toEqual([2]);
  expect(next.cursor).toBe(14);
});

test("events at or below the cursor are already in the snapshot and change nothing", () => {
  const batch = [logEvent(11, 1), logEvent(12, 2)];
  const once = batch.reduce(applyToSnapshot, snapshot());
  const replayed = [logEvent(10, 9), ...batch].reduce(applyToSnapshot, once);

  expect(replayed).toBe(once);
  expect(replayed.logs.map((log) => log.seq)).toEqual([1, 2]);
});

test("a step update replaces the step with the same seq", () => {
  const next = [stepEvent(11, 1, "running"), stepEvent(12, 1, "waiting")].reduce(
    applyToSnapshot,
    snapshot(),
  );

  expect(next.steps.map((step) => step.status)).toEqual(["waiting"]);
});

test("events for another run leave the snapshot alone", () => {
  const start = snapshot();

  expect(applyToSnapshot(start, runEvent(11, { ...running, id: "run-2" }))).toBe(start);
});

test("a created hook sets waitingOn with the step expiry and resolving it clears it", () => {
  const waiting = [stepEvent(11, 1, "waiting"), hookEvent(12, "created")].reduce(
    applyToSnapshot,
    snapshot(),
  );

  expect(waiting.run.waitingOn).toEqual({
    hook: "approve",
    token: "tok",
    seq: 1,
    expiresAt: "2026-10-17T11:00:00.000Z",
  });

  const resolved = applyToSnapshot(waiting, hookEvent(13, "resolved"));

  expect(resolved.run.waitingOn).toBeNull();
  expect(resolved.hooks).toHaveLength(1);
  expect(resolved.hooks[0]?.resolvedAt).toBe(AT);
});

test("hook events update waitingOn on list entries too", () => {
  const client = new QueryClient();
  client.setQueryData(keys.runs({}), [run]);

  applyBatch(client, [hookEvent(11, "created")]);

  expect(client.getQueryData<RunView[]>(keys.runs({}))?.[0]?.waitingOn?.token).toBe("tok");
});

test("a reset from the backend invalidates every query and resubscribes from a fresh snapshot", async () => {
  const client = new QueryClient();
  const controller = new AbortController();
  const fresh = snapshot({ epoch: "e2", cursor: 40 });

  const backend = fakeBackend({
    epoch: "e2",
    loopies: [],
    runs: [fresh],
    batches: [],
    intervalMs: 0,
  });

  client.setQueryData(keys.run("run-1"), snapshot({ epoch: "e1" }));
  client.setQueryData(keys.loopies, []);

  const states: string[] = [];

  const following = followRun({
    client,
    backend,
    runId: "run-1",
    signal: controller.signal,
    onState: (state) => {
      states.push(state);

      if (state === "live") {
        controller.abort();
      }
    },
  });

  await following;

  expect(client.getQueryData<RunSnapshotView>(keys.run("run-1"))).toEqual(fresh);
  expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(true);
  expect(states).toEqual(["reconnecting", "live"]);
});
