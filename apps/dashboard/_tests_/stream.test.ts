import { expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { RunSnapshotView, RunView, ServerEvent } from "loopy/contract";
import type { EventSubscription, StreamEnd } from "../src/backend/backend.ts";
import { type EventDraft, fakeBackend } from "../src/backend/fake.ts";
import { INBOX_QUERY, inboxGroups } from "../src/lib/inbox.ts";
import { keys } from "../src/lib/keys.ts";
import { applyBatch, applyToSnapshot, followRun } from "../src/lib/stream.ts";

const AT = "2026-10-17T10:00:00.000Z";

const run: RunView = {
  id: "run-1",
  slug: "triage",
  workspace: "/work",
  loopy: { slug: "triage", description: null },
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
  client.setQueryData(
    keys.run(run.id),
    applyToSnapshot(snapshot({ cursor: 9 }), stepEvent(10, 1, "waiting")),
  );

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

  let subscriptions = 0;

  const bounded = {
    ...backend,
    events: async (subscription: EventSubscription): Promise<StreamEnd> => {
      subscriptions++;

      if (subscriptions === 1) {
        return "reset";
      }

      expect(subscriptions).toBe(2);
      expect(subscription.epoch).toBe("e2");
      expect(subscription.after).toBe(40);

      return backend.events(subscription);
    },
  };

  const states: string[] = [];

  const following = followRun({
    client,
    backend: bounded,
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
  expect(subscriptions).toBe(2);
  expect(states).toEqual(["reconnecting", "live"]);
});

test("old hook replay cannot resurrect waitingOn after a newer run event", () => {
  const client = new QueryClient();
  client.setQueryData(keys.runs({}), [run]);
  applyBatch(client, [runEvent(20, run)]);
  applyBatch(client, [hookEvent(11, "created")]);
  expect(client.getQueryData<RunView[]>(keys.runs({}))?.[0]?.waitingOn).toBeNull();
});

test("hook updates preserve snapshot expiry in lists and reject older timestamps", () => {
  const client = new QueryClient();
  client.setQueryData(keys.run(run.id), applyToSnapshot(snapshot(), stepEvent(11, 1, "waiting")));
  client.setQueryData(keys.runs({}), [run]);
  applyBatch(client, [hookEvent(12, "created")]);
  expect(client.getQueryData<RunView[]>(keys.runs({}))?.[0]?.waitingOn?.expiresAt).toBe(
    "2026-10-17T11:00:00.000Z",
  );
  applyBatch(client, [runEvent(13, running), hookEvent(14, "created")]);
  expect(client.getQueryData<RunView[]>(keys.runs({}))?.[0]?.waitingOn).toBeNull();
  expect(client.getQueryData<RunSnapshotView>(keys.run(run.id))?.run.waitingOn).toBeNull();
});

test("hook creation without steps invalidates only lists containing its run", () => {
  const client = new QueryClient();
  const other = keys.runs({ slug: "other" });
  client.setQueryData(keys.runs({}), [run]);
  client.setQueryData(other, [{ ...run, id: "other" }]);
  applyBatch(client, [hookEvent(11, "created")]);
  expect(client.getQueryState(keys.runs({}))?.isInvalidated).toBe(true);
  expect(client.getQueryState(other)?.isInvalidated).toBe(false);
});

test("run creation and completion invalidate the lists and loopy summaries", () => {
  const client = new QueryClient();
  client.setQueryData(keys.runs({}), []);
  client.setQueryData(keys.loopies, []);
  applyBatch(client, [event(11, { entity: "run", kind: "created", runId: run.id, record: run })]);
  expect(client.getQueryState(keys.runs({}))?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(true);
  client.setQueryData(keys.loopies, []);
  applyBatch(client, [
    event(12, {
      entity: "run",
      kind: "finished",
      runId: run.id,
      record: { ...run, status: "cancelled" },
    }),
  ]);
  expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(true);
});

test("abort during reset refetch cancels the snapshot request and settles followRun", async () => {
  const client = new QueryClient();
  client.setQueryData(keys.run(run.id), snapshot());
  const controller = new AbortController();

  const backend = fakeBackend({
    epoch: "e1",
    loopies: [],
    runs: [snapshot()],
    batches: [],
    intervalMs: 10,
  });

  let pending = false;
  let subscriptions = 0;

  const following = followRun({
    client,
    runId: run.id,
    signal: controller.signal,
    onState: () => undefined,
    backend: {
      ...backend,
      events: async () => {
        subscriptions++;

        return "reset";
      },
      run: (_id, signal) =>
        new Promise<RunSnapshotView>((resolve, reject) => {
          expect(_id).toBe(run.id);
          void resolve;
          pending = true;
          signal?.addEventListener(
            "abort",
            () => {
              pending = false;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        }),
    },
  });

  await following;
  expect(pending).toBe(false);
  expect(subscriptions).toBe(1);
  expect(client.getQueryState(keys.run(run.id))?.fetchStatus).toBe("idle");
});

test("fake playback cancels its last subscriber's timer and resumes on subscribe", async () => {
  const backend = fakeBackend({
    epoch: "e1",
    loopies: [],
    runs: [snapshot()],
    batches: [[{ entity: "run", kind: "claimed", runId: run.id, record: running }]],
    intervalMs: 20,
  });

  const controller = new AbortController();
  const cleared = spyOn(globalThis, "clearTimeout");

  try {
    const first = backend.events({
      after: 10,
      epoch: "e1",
      signal: controller.signal,
      onState: () => undefined,
      onBatch: () => {
        throw new Error("unsubscribed playback");
      },
    });

    controller.abort();
    await expect(first).resolves.toBe("aborted");
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(cleared.mock.calls[0]?.[0]).toBeDefined();
    await Bun.sleep(30);
    expect((await backend.run(run.id, AbortSignal.timeout(1000))).cursor).toBe(10);
    const next = new AbortController();
    let batches = 0;
    await backend.events({
      after: 10,
      epoch: "e1",
      signal: next.signal,
      onState: () => undefined,
      onBatch: () => {
        batches++;
        next.abort();
      },
    });
    expect(batches).toBe(1);
    expect((await backend.run(run.id, AbortSignal.timeout(1000))).cursor).toBe(11);
  } finally {
    cleared.mockRestore();
  }
});

test("aborting as a subscription opens prevents replay and playback", async () => {
  const backend = fakeBackend({
    epoch: "e1",
    loopies: [],
    runs: [snapshot()],
    batches: [[{ entity: "run", kind: "claimed", runId: run.id, record: running }]],
    intervalMs: 1,
  });

  const first = new AbortController();
  await backend.events({
    after: 10,
    epoch: "e1",
    signal: first.signal,
    onState: () => undefined,
    onBatch: () => first.abort(),
  });
  const second = new AbortController();
  let replayed = 0;

  const end = await backend.events({
    after: 10,
    epoch: "e1",
    signal: second.signal,
    onState: () => second.abort(),
    onBatch: () => {
      replayed++;
    },
  });

  expect(end).toBe("aborted");
  expect(replayed).toBe(0);
});

const waiting: RunView = {
  ...run,
  status: "suspended",
  wakeAt: null,
  waitingOn: { hook: "approve", token: "tok", seq: 1, expiresAt: null },
};

test("a resolved hook drops the run from the inbox in place, without a refetch", () => {
  const client = new QueryClient();
  client.setQueryData(keys.runs(INBOX_QUERY), [waiting]);

  applyBatch(client, [hookEvent(11, "resolved")]);

  const runs = client.getQueryData<RunView[]>(keys.runs(INBOX_QUERY)) ?? [];
  expect(runs.map((item) => item.id)).toEqual(["run-1"]);
  expect(inboxGroups(runs)).toEqual([]);
  expect(client.getQueryState(keys.runs(INBOX_QUERY))?.isInvalidated).toBe(false);
});

test("a run entering a status refetches the lists for that status that lack it", () => {
  const client = new QueryClient();
  const other = { ...waiting, id: "run-2" };
  client.setQueryData(keys.runs(INBOX_QUERY), [other]);
  client.setQueryData(keys.runs({ status: "suspended", slug: "triage" }), [waiting]);
  client.setQueryData(keys.runs({ status: "failed" }), []);

  applyBatch(client, [
    event(11, { entity: "run", kind: "suspended", runId: waiting.id, record: waiting }),
  ]);

  expect(client.getQueryState(keys.runs(INBOX_QUERY))?.isInvalidated).toBe(true);
  expect(
    client.getQueryState(keys.runs({ status: "suspended", slug: "triage" }))?.isInvalidated,
  ).toBe(false);
  expect(client.getQueryState(keys.runs({ status: "failed" }))?.isInvalidated).toBe(false);
});
