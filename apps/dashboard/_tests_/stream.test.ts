import { expect, spyOn, test } from "bun:test";
import { type InfiniteData, QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  executionKeyString,
  type NodeRunView,
  nodeRunViewSchema,
  type RunSnapshotView,
  type RunView,
  type Schedule,
  type ScheduleView,
  type ServerEvent,
} from "loopy/contract";
import type { EventSubscription, StreamEnd } from "../src/backend/backend.ts";
import { type EventDraft, fakeBackend } from "../src/backend/fake.ts";
import { INBOX_QUERY, inboxGroups } from "../src/lib/inbox.ts";
import { keys } from "../src/lib/keys.ts";
import type { RunPage } from "../src/lib/queries.ts";
import {
  applyBatch,
  applyScheduleView,
  applyToSnapshot,
  followSession,
} from "../src/lib/stream.ts";

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

function page(runs: RunView[]): RunPage {
  return { runs, nextCursor: undefined };
}

function snapshot(overrides: Partial<RunSnapshotView> = {}): RunSnapshotView {
  return {
    run,
    nodeRuns: [],
    steps: [],
    logs: [],
    hooks: [],
    cursor: 10,
    epoch: "e1",
    ...overrides,
  };
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

test("a run event updates its run inside every page of a paged list", () => {
  const client = new QueryClient();
  const older = { ...run, id: "run-0" };

  const paged = {
    pages: [page([{ ...run, id: "run-2" }]), page([older, run])],
    pageParams: [undefined, "c1"],
  };

  client.setQueryData(keys.runPages({ slug: "triage" }), paged);

  applyBatch(client, [runEvent(11, running)]);

  expect(client.getQueryData<InfiniteData<RunPage>>(keys.runPages({ slug: "triage" }))).toEqual({
    pages: [page([{ ...run, id: "run-2" }]), page([older, running])],
    pageParams: [undefined, "c1"],
  });
});

test("hook creation updates a paged list from native hook data", () => {
  const client = new QueryClient();
  const holding = keys.runPages({});
  const other = keys.runPages({ slug: "other" });
  client.setQueryData(holding, { pages: [page([]), page([run])], pageParams: [undefined, "c1"] });
  client.setQueryData(other, { pages: [page([{ ...run, id: "other" }])], pageParams: [undefined] });
  applyBatch(client, [hookEvent(11, "created")]);
  expect(
    client.getQueryData<InfiniteData<RunPage>>(holding)?.pages[1]?.runs[0]?.waitingOn?.token,
  ).toBe("tok");
  expect(
    client.getQueryData<InfiniteData<RunPage>>(other)?.pages[0]?.runs[0]?.waitingOn,
  ).toBeNull();
});

test("a list keeps a run that is newer than the event", () => {
  const client = new QueryClient();
  client.setQueryData(keys.runs({}), [running]);

  applyBatch(client, [runEvent(11, run)]);

  expect(client.getQueryData<RunView[]>(keys.runs({}))).toEqual([running]);
});

function nodeEvent(sequence: number, index: number, attempt: number, status: string) {
  const record: NodeRunView = nodeRunViewSchema.parse({
    key: { runId: run.id, nodeId: `1:classify-${index}`, scope: [] },
    attempt,
    maxAttempts: 3,
    startedAt: AT,
    receipt: "started",
    status,
    ...(status === "retrying"
      ? { error: { code: "exit", message: "boom" }, endedAt: AT, nextRetryAt: AT }
      : status === "succeeded"
        ? { output: { ok: true }, endedAt: AT }
        : {}),
  });

  return event(sequence, { entity: "node", kind: record.status, runId: run.id, record });
}

test("node events keep one record per execution key at its latest attempt", () => {
  const next = [
    nodeEvent(11, 0, 1, "running"),
    nodeEvent(12, 1, 1, "running"),
    nodeEvent(13, 0, 1, "retrying"),
    nodeEvent(14, 0, 2, "running"),
    nodeEvent(15, 0, 2, "succeeded"),
    // A replay of an applied event is already part of the snapshot and must not regress it.
    nodeEvent(13, 0, 1, "retrying"),
  ].reduce(applyToSnapshot, snapshot());

  expect(
    next.nodeRuns.map((record) => [String(record.key.nodeId), record.attempt, record.status]),
  ).toEqual([
    ["1:classify-0", 2, "succeeded"],
    ["1:classify-1", 1, "running"],
  ]);
  expect(next.cursor).toBe(15);
});

test("logs land in seq order whatever order the events arrive in", () => {
  const next = [logEvent(13, 3), logEvent(12, 1), logEvent(11, 2)]
    .sort((a, b) => a.sequence - b.sequence)
    .reduce(applyToSnapshot, snapshot());

  expect(next.logs.map((log) => log.seq)).toEqual([1, 2, 3]);
  expect(next.cursor).toBe(13);
});

test("events at or below the cursor are already in the snapshot and change nothing", () => {
  const batch = [logEvent(11, 1), logEvent(12, 2)];
  const once = batch.reduce(applyToSnapshot, snapshot());
  const replayed = [logEvent(10, 9), ...batch].reduce(applyToSnapshot, once);

  expect(replayed).toBe(once);
  expect(replayed.logs.map((log) => log.seq)).toEqual([1, 2]);
});

test("events for another run leave the snapshot alone", () => {
  const start = snapshot();

  expect(applyToSnapshot(start, runEvent(11, { ...running, id: "run-2" }))).toBe(start);
});

test("native wait hooks preserve run expiry and resolving them clears waitingOn", () => {
  const nativeWaiting: RunView = {
    ...run,
    status: "suspended",
    wakeAt: "2026-10-17T11:00:00.000Z",
    waitingOn: {
      hook: "approve",
      token: "tok",
      seq: 1,
      since: AT,
      expiresAt: "2026-10-17T11:00:00.000Z",
    },
  };

  const waiting = applyToSnapshot(snapshot({ run: nativeWaiting }), hookEvent(11, "created"));

  expect(waiting.run.waitingOn).toEqual({
    hook: "approve",
    token: "tok",
    seq: 1,
    expiresAt: "2026-10-17T11:00:00.000Z",
    since: AT,
  });

  const resolved = applyToSnapshot(waiting, hookEvent(13, "resolved"));

  expect(resolved.run.waitingOn).toBeNull();
  expect(resolved.hooks).toHaveLength(1);
  expect(resolved.hooks[0]?.resolvedAt).toBe(AT);
});

test("hook events update waitingOn on list entries too", () => {
  const client = new QueryClient();
  client.setQueryData(keys.runs({}), [run]);
  client.setQueryData(keys.run(run.id), snapshot({ cursor: 9 }));

  applyBatch(client, [hookEvent(11, "created")]);

  expect(client.getQueryData<RunView[]>(keys.runs({}))?.[0]?.waitingOn?.token).toBe("tok");
});

test("a reset from the backend invalidates every query and resubscribes from a fresh global cursor", async () => {
  const client = new QueryClient();
  const controller = new AbortController();
  const fresh = snapshot({ epoch: "e2", cursor: 40 });

  const backend = fakeBackend({
    epoch: "e2",
    loopies: [],
    schedules: [],
    runs: [fresh],
    graphs: [],
    pins: {},
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

  const following = followSession({
    client,
    backend: bounded,
    signal: controller.signal,
    onState: (state) => {
      states.push(state);

      if (state === "live") {
        controller.abort();
      }
    },
  });

  await following;

  expect(client.getQueryState(keys.run("run-1"))?.isInvalidated).toBe(true);
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

  const waitingRun: RunView = {
    ...run,
    waitingOn: {
      hook: "approve",
      token: "tok",
      seq: 1,
      since: AT,
      expiresAt: "2026-10-17T11:00:00.000Z",
    },
  };

  client.setQueryData(keys.run(run.id), snapshot({ run: waitingRun }));
  client.setQueryData(keys.runs({}), [waitingRun]);
  applyBatch(client, [hookEvent(12, "created")]);
  expect(client.getQueryData<RunView[]>(keys.runs({}))?.[0]?.waitingOn?.expiresAt).toBe(
    "2026-10-17T11:00:00.000Z",
  );
  applyBatch(client, [runEvent(13, running), hookEvent(14, "created")]);
  expect(client.getQueryData<RunView[]>(keys.runs({}))?.[0]?.waitingOn).toBeNull();
  expect(client.getQueryData<RunSnapshotView>(keys.run(run.id))?.run.waitingOn).toBeNull();
});

test("hook creation updates only lists containing its run", () => {
  const client = new QueryClient();
  const other = keys.runs({ slug: "other" });
  client.setQueryData(keys.runs({}), [run]);
  client.setQueryData(other, [{ ...run, id: "other" }]);
  applyBatch(client, [hookEvent(11, "created")]);
  expect(client.getQueryData<RunView[]>(keys.runs({}))?.[0]?.waitingOn?.token).toBe("tok");
  expect(client.getQueryData<RunView[]>(other)?.[0]?.waitingOn).toBeNull();
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

test("abort during reset cursor fetch cancels the request and settles followSession", async () => {
  const client = new QueryClient();
  client.setQueryData(keys.run(run.id), snapshot());
  const controller = new AbortController();

  const backend = fakeBackend({
    epoch: "e1",
    loopies: [],
    schedules: [],
    runs: [snapshot()],
    graphs: [],
    pins: {},
    batches: [],
    intervalMs: 10,
  });

  let pending = false;
  let subscriptions = 0;
  let cursors = 0;

  const following = followSession({
    client,
    signal: controller.signal,
    onState: () => undefined,
    backend: {
      ...backend,
      events: async () => {
        subscriptions++;

        return "reset";
      },
      cursor: (signal) => {
        cursors++;

        if (cursors === 1) {
          return backend.cursor(signal);
        }

        const { promise, reject } =
          Promise.withResolvers<Awaited<ReturnType<typeof backend.cursor>>>();

        pending = true;
        signal.addEventListener(
          "abort",
          () => {
            pending = false;
            reject(new Error("cancelled"));
          },
          { once: true },
        );
        queueMicrotask(() => controller.abort());

        return promise;
      },
    },
  });

  await following;
  expect(pending).toBe(false);
  expect(subscriptions).toBe(1);
  expect(client.getQueryState(keys.run(run.id))?.fetchStatus).toBe("idle");
});

const waiting: RunView = {
  ...run,
  status: "suspended",
  wakeAt: null,
  waitingOn: { hook: "approve", token: "tok", seq: 1, expiresAt: null, since: AT },
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

test("an unseen run invalidates matching array and infinite lists once per fresh batch", () => {
  const client = new QueryClient();
  const array = keys.runs({ status: "running", slug: run.slug });
  const pages = keys.runPages({ status: "running", slug: run.slug });
  const unrelated = keys.runPages({ status: "running", slug: "other" });
  client.setQueryData(array, []);
  client.setQueryData(pages, { pages: [page([])], pageParams: [undefined] });
  client.setQueryData(unrelated, { pages: [page([])], pageParams: [undefined] });
  const invalidations = spyOn(client, "invalidateQueries");
  const batch = [runEvent(11, running), runEvent(12, running)];
  applyBatch(client, batch);
  expect(client.getQueryState(array)?.isInvalidated).toBe(true);
  expect(client.getQueryState(pages)?.isInvalidated).toBe(true);
  expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
  expect(client.getQueryData(keys.run(run.id))).toBeUndefined();
  expect(invalidations).toHaveBeenCalledTimes(2);
  client.setQueryData(array, []);
  client.setQueryData(pages, { pages: [page([])], pageParams: [undefined] });
  invalidations.mockClear();
  applyBatch(client, batch);
  expect(invalidations).not.toHaveBeenCalled();
  expect(client.getQueryState(array)?.isInvalidated).toBe(false);
  expect(client.getQueryState(pages)?.isInvalidated).toBe(false);
  invalidations.mockRestore();
});

test("queued to running removes old membership and refetches the destination pages", () => {
  const client = new QueryClient();
  const queued = keys.runPages({ status: "queued", slug: run.slug });
  const active = keys.runPages({ status: "running", slug: run.slug });
  const array = keys.runs({ status: "queued" });
  client.setQueryData(queued, { pages: [page([run])], pageParams: [undefined] });
  client.setQueryData(active, { pages: [page([])], pageParams: [undefined] });
  client.setQueryData(array, [run]);
  applyBatch(client, [runEvent(11, running)]);
  expect(client.getQueryData<InfiniteData<RunPage>>(queued)?.pages).toEqual([page([])]);
  expect(client.getQueryData<RunView[]>(array)).toEqual([]);
  expect(client.getQueryState(active)?.isInvalidated).toBe(true);
  expect(client.getQueryState(queued)?.isInvalidated).toBe(false);
});

/** Status lists whose fetches read the server when they start and answer only when released. */
function heldLists(client: QueryClient) {
  let server: RunView[] = [];
  const held: (() => void)[] = [];
  const fetches = new Map<RunView["status"], number>();

  return {
    queryFn(status: RunView["status"]) {
      return () => {
        fetches.set(status, (fetches.get(status) ?? 0) + 1);
        const answer = server.filter((row) => row.status === status);

        return new Promise<RunView[]>((resolve) => held.push(() => resolve(answer)));
      };
    },
    /** Without rows the list has no data yet, so subscribing starts its first load. */
    observe(status: RunView["status"], rows?: RunView[]) {
      if (rows !== undefined) {
        client.setQueryData(keys.runs({ status }), rows);
      }

      const observer = new QueryObserver(client, {
        queryKey: keys.runs({ status }),
        staleTime: Infinity,
        queryFn: this.queryFn(status),
      });

      observer.subscribe(() => {});

      return observer;
    },
    serve(rows: RunView[]) {
      server = rows;
    },
    fetches: (status: RunView["status"]) => fetches.get(status) ?? 0,
    async release() {
      for (const answer of held.splice(0)) {
        answer();
      }

      await Bun.sleep(0);
    },
  };
}

test("a status change restarts a list fetch that started before it, even when the list lacks the run", async () => {
  const client = new QueryClient();
  const lists = heldLists(client);
  lists.observe("queued", []);
  lists.observe("running", []);
  void lists.observe("failed", []).refetch();
  lists.serve([run]);
  applyBatch(client, [event(11, { entity: "run", kind: "created", runId: run.id, record: run })]);
  lists.serve([running]);
  applyBatch(client, [runEvent(12, running)]);
  const beat = { ...running, updatedAt: "2026-10-17T10:00:02.000Z" };
  applyBatch(client, [
    event(13, { entity: "run", kind: "heartbeat", runId: run.id, record: beat }),
  ]);
  await lists.release();

  expect(client.getQueryData<RunView[]>(keys.runs({ status: "queued" }))).toEqual([]);
  expect(client.getQueryData<RunView[]>(keys.runs({ status: "running" }))).toEqual([running]);
  expect(lists.fetches("queued")).toBe(2);
  expect(lists.fetches("running")).toBe(1);
  expect(lists.fetches("failed")).toBe(1);
});

test("a run leaving a list restarts that list's fetch already in flight", async () => {
  const client = new QueryClient();
  const lists = heldLists(client);
  lists.serve([run]);
  void lists.observe("queued", [run]).refetch();
  lists.serve([running]);
  applyBatch(client, [runEvent(11, running)]);
  await lists.release();

  expect(client.getQueryData<RunView[]>(keys.runs({ status: "queued" }))).toEqual([]);
  expect(lists.fetches("queued")).toBe(2);
});

test("a status change restarts a list's first load that read the server before it", async () => {
  const client = new QueryClient();
  const lists = heldLists(client);
  applyBatch(client, [event(11, { entity: "run", kind: "created", runId: run.id, record: run })]);
  lists.serve([run]);
  const queued = lists.observe("queued");
  lists.observe("failed");
  lists.observe("running", []);
  lists.serve([running]);
  applyBatch(client, [runEvent(12, running)]);
  await lists.release();
  await lists.release();

  expect(client.getQueryData<RunView[]>(keys.runs({ status: "queued" }))).toEqual([]);
  expect(client.getQueryData<RunView[]>(keys.runs({ status: "running" }))).toEqual([running]);
  expect(client.getQueryData<RunView[]>(keys.runs({ status: "failed" }))).toEqual([]);
  expect(queued.getCurrentResult()).toMatchObject({ status: "success", fetchStatus: "idle" });
  expect(lists.fetches("queued")).toBe(2);
  expect(lists.fetches("running")).toBe(1);
  expect(lists.fetches("failed")).toBe(1);
});

test("a restarted first load without an observer still answers its loader", async () => {
  const client = new QueryClient();
  const lists = heldLists(client);
  applyBatch(client, [event(11, { entity: "run", kind: "created", runId: run.id, record: run })]);
  lists.serve([run]);

  const loaded = client.fetchQuery({
    queryKey: keys.runs({ status: "queued" }),
    queryFn: lists.queryFn("queued"),
  });

  lists.serve([running]);
  applyBatch(client, [runEvent(12, running)]);
  await lists.release();
  await lists.release();

  expect(await loaded).toEqual([]);
  expect(client.getQueryState(keys.runs({ status: "queued" }))?.fetchStatus).toBe("idle");
  expect(lists.fetches("queued")).toBe(2);
});

test("status transitions and schedule events invalidate summaries once while heartbeat and replay do not", () => {
  const client = new QueryClient();
  client.setQueryData(keys.loopies, []);
  client.setQueryData(keys.workspaceLoopies("/other"), []);
  client.setQueryData(keys.scheduleOverview, { workspaces: [], active: 0, next: [] });
  client.setQueryData(keys.runs({}), [run]);
  const invalidations = spyOn(client, "invalidateQueries");

  const schedule = event(13, {
    entity: "schedule",
    kind: "deleted",
    runId: null,
    record: { workspace: "/work", slug: "triage" },
  });

  applyBatch(client, [runEvent(11, running), runEvent(12, waiting), schedule]);
  expect(invalidations).toHaveBeenCalledTimes(2);
  expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.workspaceLoopies("/other"))?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(true);
  invalidations.mockClear();
  client.setQueryData(keys.loopies, []);
  client.setQueryData(keys.workspaceLoopies("/other"), []);
  client.setQueryData(keys.scheduleOverview, { workspaces: [], active: 0, next: [] });
  applyBatch(client, [
    schedule,
    runEvent(11, running),
    event(14, { entity: "run", kind: "heartbeat", runId: run.id, record: waiting }),
  ]);
  expect(invalidations).not.toHaveBeenCalled();
  expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(false);
  expect(client.getQueryState(keys.workspaceLoopies("/other"))?.isInvalidated).toBe(false);
  expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(false);
  applyBatch(client, [{ ...schedule, sequence: 15 }]);
  expect(invalidations).toHaveBeenCalledTimes(2);
  invalidations.mockRestore();
});

test("a newer detail cursor cannot hide a fresh list event or summary transition", () => {
  const client = new QueryClient();
  client.setQueryData(keys.run(run.id), snapshot({ run: running, cursor: 20 }));
  client.setQueryData(keys.runs({}), [run]);
  client.setQueryData(keys.loopies, []);
  applyBatch(client, [runEvent(11, running)]);
  expect(client.getQueryData<RunView[]>(keys.runs({}))).toEqual([running]);
  expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(true);
  expect(client.getQueryData<RunSnapshotView>(keys.run(run.id))?.cursor).toBe(20);
});

/** A schedule as the store emits it; the view adds a null lastFireKey. */
const record: Schedule = {
  workspace: "/work",
  slug: "triage",
  cron: "*/5 * * * *",
  tz: "UTC",
  input: {},
  enabled: true,
  nextFireAt: "2026-10-17T10:05:00.000Z",
  version: 2,
};

const scheduled: ScheduleView = { ...record, lastFireKey: null };

function scheduleSaved(sequence: number, saved: Schedule) {
  return event(sequence, { entity: "schedule", kind: "saved", runId: null, record: saved });
}

test("a saved schedule replaces its row, and an older version leaves the row alone", () => {
  const client = new QueryClient();
  const other = { ...scheduled, slug: "digest" };
  client.setQueryData(keys.schedules("/work"), [scheduled, other]);

  applyBatch(client, [scheduleSaved(11, { ...record, enabled: false, version: 3 })]);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([
    { ...scheduled, enabled: false, version: 3 },
    other,
  ]);

  applyBatch(client, [scheduleSaved(12, { ...record, cron: "@daily", version: 1 })]);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))?.[0]?.cron).toBe(
    "*/5 * * * *",
  );
  expect(client.getQueryState(keys.schedules("/work"))?.isInvalidated).toBe(false);
});

test("a fired schedule keeps its version and carries the fire key into the row", () => {
  const client = new QueryClient();
  client.setQueryData(keys.schedules("/work"), [scheduled]);
  const next = "2026-10-17T10:10:00.000Z";

  applyBatch(client, [
    event(11, {
      entity: "schedule",
      kind: "fired",
      runId: null,
      record: { ...record, nextFireAt: next, lastFireKey: "triage@2026-10-17T10:05Z" },
    }),
  ]);

  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([
    { ...scheduled, nextFireAt: next, lastFireKey: "triage@2026-10-17T10:05Z" },
  ]);
});

test("a save in another workspace leaves the selected workspace list alone", () => {
  const client = new QueryClient();
  client.setQueryData(keys.schedules("/work"), []);

  applyBatch(client, [scheduleSaved(11, { ...record, workspace: "/elsewhere" })]);

  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([]);
  expect(client.getQueryState(keys.schedules("/work"))?.isInvalidated).toBe(false);
});

test("a deleted schedule leaves the list without a refetch, and only for its workspace", () => {
  const client = new QueryClient();
  const elsewhere = { ...scheduled, workspace: "/elsewhere" };
  client.setQueryData(keys.schedules("/work"), [scheduled, elsewhere]);

  applyBatch(client, [
    event(11, {
      entity: "schedule",
      kind: "deleted",
      runId: null,
      record: { workspace: "/work", slug: "triage" },
    }),
  ]);

  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([elsewhere]);
  expect(client.getQueryState(keys.schedules("/work"))?.isInvalidated).toBe(false);
});

test("a delayed HTTP response cannot undo a fire at the same version", () => {
  const client = new QueryClient();
  client.setQueryData(keys.schedules("/work"), [scheduled]);
  const fired = { ...record, nextFireAt: "2026-10-17T10:10:00.000Z", lastFireKey: "fire-1" };
  applyBatch(client, [
    event(11, { entity: "schedule", kind: "fired", runId: null, record: fired }),
  ]);

  applyScheduleView(client, scheduled);

  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([fired]);
  applyScheduleView(client, { ...fired, nextFireAt: "2026-10-17T10:15:00.000Z" });
  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))?.[0]?.nextFireAt).toBe(
    "2026-10-17T10:15:00.000Z",
  );
});

test("an equal-version schedule with the same fire time leaves the cached row unchanged", () => {
  const client = new QueryClient();
  const current = { ...scheduled, lastFireKey: "fire-1" };
  client.setQueryData(keys.schedules("/work"), [current]);

  applyScheduleView(client, { ...current, lastFireKey: "fire-2" });

  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))?.[0]).toBe(current);
});

test("an unseen save cannot skip a later delete in the same batch", () => {
  const client = new QueryClient();
  client.setQueryData(keys.schedules("/work"), [scheduled]);
  applyBatch(client, [
    scheduleSaved(11, { ...record, slug: "unseen" }),
    event(12, {
      entity: "schedule",
      kind: "deleted",
      runId: null,
      record: { workspace: record.workspace, slug: record.slug },
    }),
  ]);

  expect(client.getQueryData<ScheduleView[]>(keys.schedules("/work"))).toEqual([]);
  expect(client.getQueryState(keys.schedules("/work"))?.isInvalidated).toBe(true);
});

test("stream snapshots retain bounded root nodes, logs and hooks across long sessions", () => {
  let current = snapshot();
  let sequence = 11;

  for (let index = 0; index < 1000; index++) {
    const root = nodeEvent(sequence++, index, 1, "running");
    current = applyToSnapshot(current, root);
    current = applyToSnapshot(current, logEvent(sequence++, index + 1));
    current = applyToSnapshot(
      current,
      event(sequence++, {
        entity: "hook",
        kind: "created",
        runId: run.id,
        record: { ...hook, token: `token-${index}`, seq: index + 1 },
      }),
    );
  }

  expect(current.nodeRuns).toHaveLength(200);
  expect(current.nodeRunsNext).toBeTruthy();
  expect(current.logs).toHaveLength(200);
  expect(current.hooks).toHaveLength(200);
  expect(current.logs[0]?.seq).toBe(801);
  expect(current.hooksTruncated).toBe(true);
  expect(current.cursor).toBe(sequence - 1);
});

test("stream overflow keeps the execution keyset boundary and preview metadata bounded", () => {
  let current = snapshot();
  const keysWritten: string[] = [];

  for (let index = 0; index < 201; index++) {
    const record = nodeRunViewSchema.parse({
      key: { runId: run.id, nodeId: `${index}:work`, scope: [] },
      attempt: 1,
      maxAttempts: 1,
      startedAt: AT,
      endedAt: AT,
      receipt: "finished",
      status: "succeeded",
      output: null,
    });

    keysWritten.push(executionKeyString(record.key));
    current = applyToSnapshot(
      current,
      event(11 + index, {
        entity: "node",
        kind: "succeeded",
        runId: run.id,
        record,
        truncatedOutputBytes: 20_002,
      }),
    );
  }

  const firstPage = keysWritten.sort().slice(0, 200);

  expect(current.nodeRuns.map((node) => executionKeyString(node.key))).toEqual(firstPage);
  expect(current.nodeRunsNext).toBe(firstPage.at(-1));
  expect(Object.keys(current.truncatedOutputs ?? {}).sort()).toEqual(firstPage);
});

test("scoped node bursts invalidate aggregates and refetch active queries once", async () => {
  const client = new QueryClient();
  const activeKey = keys.scopes(run.id, "[]");
  const inactiveKey = keys.scopes(run.id, '[{"nodeId":"0:map","index":0}]');
  client.setQueryData(activeKey, []);
  client.setQueryData(inactiveKey, []);
  client.setQueryData(keys.run(run.id), snapshot());
  let fetches = 0;

  const observer = new QueryObserver(client, {
    queryKey: activeKey,
    staleTime: Infinity,
    queryFn: async () => {
      fetches++;

      return [];
    },
  });

  const unsubscribe = observer.subscribe(() => undefined);

  try {
    const root = nodeEvent(11, 0, 1, "running");

    if (root.entity !== "node") {
      throw new Error("Expected a node fixture.");
    }

    const scoped: ServerEvent = {
      ...root,
      record: nodeRunViewSchema.parse({
        ...root.record,
        key: { ...root.record.key, scope: [{ nodeId: "0:map", index: 0 }] },
      }),
    };

    applyBatch(client, [scoped]);
    applyBatch(client, [{ ...scoped, sequence: 12 }]);
    expect(fetches).toBe(0);
    expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
    expect(client.getQueryData<RunSnapshotView>(keys.run(run.id))?.nodeRuns).toEqual([]);
    expect(client.getQueryData<RunSnapshotView>(keys.run(run.id))?.cursor).toBe(12);
    await Bun.sleep(300);
    expect(fetches).toBe(1);
    expect(client.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("large streamed outputs stay previews while detail queries remain lazy", () => {
  const root = nodeEvent(11, 0, 1, "succeeded");

  if (root.entity !== "node" || root.record.status !== "succeeded") {
    throw new Error("Expected a completed node fixture.");
  }

  const value = "x".repeat(20_000);

  const next = applyToSnapshot(snapshot(), {
    ...root,
    record: {
      ...root.record,
      output: value,
      inputView: { state: "available", value: { private: "input" } },
    },
  });

  const node = next.nodeRuns[0];
  expect(node?.status === "succeeded" ? node.output : undefined).toBeNull();
  expect(node?.inputView).toBeUndefined();
  expect(Object.values(next.truncatedOutputs ?? {})).toEqual([20_002]);
  expect(next.cursor).toBe(11);
});
