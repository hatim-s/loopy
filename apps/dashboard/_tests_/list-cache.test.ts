import { expect, spyOn, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import {
  encodeRunCursor,
  nodeRunViewSchema,
  type RunSnapshotView,
  type RunView,
  type ServerEvent,
} from "loopy/contract";
import { fakeBackend } from "../src/backend/fake.ts";
import { keys } from "../src/lib/keys.ts";
import {
  eventPagesQuery,
  logPagesQuery,
  RUN_PAGE_SIZE,
  type RunPage,
  runPagesQuery,
  scopeItemsQuery,
} from "../src/lib/queries.ts";
import { applyBatch, applyToSnapshot } from "../src/lib/stream.ts";

const queued: RunView = {
  id: "run-a",
  slug: "triage",
  workspace: "/work",
  loopy: { slug: "triage", description: null },
  input: null,
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
  owner: null,
  ownerStale: false,
  waitingOn: null,
  status: "queued",
};

const running: RunView = { ...queued, status: "running", updatedAt: "2026-10-17T10:00:01.000Z" };

const heartbeat: RunView = { ...running, updatedAt: "2026-10-17T10:00:02.000Z" };

function snapshot(run: RunView): RunSnapshotView {
  return { run, nodeRuns: [], steps: [], logs: [], hooks: [], cursor: 10, epoch: "e1" };
}

function event(record: RunView, sequence: number, kind: "claimed" | "heartbeat"): ServerEvent {
  return {
    entity: "run",
    runId: record.id,
    record,
    sequence,
    kind,
    at: record.updatedAt,
    txn: `t${sequence}`,
  };
}

function cache() {
  const client = new QueryClient();
  client.setQueryData(keys.run(queued.id), snapshot(queued));
  client.setQueryData(keys.runs({ status: "queued" }), [queued]);
  client.setQueryData(keys.runs({ status: "running" }), []);
  client.setQueryData(keys.loopies, []);

  return client;
}

test("detail heartbeat and queued-to-running delivery in either order reconcile lists once", () => {
  for (const heartbeatFirst of [true, false]) {
    const client = cache();
    const invalidations = spyOn(client, "invalidateQueries");

    const detailHeartbeat = () =>
      client.setQueryData<RunSnapshotView>(
        keys.run(queued.id),
        (current) => current && applyToSnapshot(current, event(heartbeat, 12, "heartbeat")),
      );

    if (heartbeatFirst) {
      detailHeartbeat();
    }

    applyBatch(client, [event(running, 11, "claimed")]);

    if (!heartbeatFirst) {
      detailHeartbeat();
    }

    applyBatch(client, [event(heartbeat, 12, "heartbeat"), event(running, 11, "claimed")]);
    expect(client.getQueryData<RunView[]>(keys.runs({ status: "queued" }))).toEqual([]);
    expect(client.getQueryState(keys.runs({ status: "running" }))?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(true);
    expect(client.getQueryData<RunSnapshotView>(keys.run(queued.id))?.run).toEqual(heartbeat);
    expect(invalidations.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      keys.runLists,
      keys.loopies,
    ]);
    invalidations.mockRestore();
  }
});

function pagedCache() {
  const runs = Array.from(Array.from({ length: RUN_PAGE_SIZE }).keys(), (index) => ({
    ...queued,
    id: `run-${index}`,
    createdAt: new Date(Date.parse(queued.createdAt) - index * 1000).toISOString(),
  }));

  const oldest = runs.at(-1);

  if (oldest === undefined) {
    throw new Error("The fixture needs a full page.");
  }

  const backend = fakeBackend({
    epoch: "e1",
    loopies: [],
    schedules: [],
    runs: runs.map(snapshot),
    graphs: [],
    pins: {},
    batches: [],
    intervalMs: 0,
  });

  const requests = spyOn(backend, "runs");
  const client = new QueryClient();
  const observer = new InfiniteQueryObserver(client, runPagesQuery(backend, { status: "queued" }));
  const unsubscribe = observer.subscribe(() => undefined);

  return { oldest, requests, client, observer, unsubscribe };
}

test("removing the oldest row from a full page preserves its next cursor", async () => {
  const { oldest, requests, client, observer, unsubscribe } = pagedCache();

  try {
    await observer.refetch();
    applyBatch(client, [event({ ...running, id: oldest.id }, 11, "claimed")]);
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    await observer.fetchNextPage();
    expect(requests.mock.calls.at(-1)?.[0]?.before).toBe(encodeRunCursor(oldest));
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
  } finally {
    unsubscribe();
    client.clear();
    requests.mockRestore();
  }
});

test("garbage collecting a list discards its stream freshness history", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const queryKey = keys.runs({ status: "queued" });
  client.setQueryData(queryKey, [queued]);
  applyBatch(client, [event(running, 12, "claimed")]);
  expect(client.getQueryData<RunView[]>(queryKey)).toEqual([]);

  const query = client.getQueryCache().find({ queryKey, exact: true });

  const removed = new Promise<void>((resolve) => {
    const unsubscribe = client.getQueryCache().subscribe((change) => {
      if (change.type === "removed" && change.query === query) {
        unsubscribe();
        resolve();
      }
    });
  });

  await removed;
  expect(client.getQueryCache().find({ queryKey, exact: true })).toBeUndefined();

  client.setQueryData(queryKey, [queued]);
  applyBatch(client, [event(running, 11, "claimed")]);
  expect(client.getQueryData<RunView[]>(queryKey)).toEqual([]);
  client.clear();
});

test("run pagination evicts old pages without losing its next server cursor", async () => {
  const rows = Array.from(Array.from({ length: 300 }).keys(), (index) => ({
    ...queued,
    id: `run-${index}`,
    createdAt: new Date(Date.parse(queued.createdAt) - index * 1000).toISOString(),
  }));

  const backend = fakeBackend({
    epoch: "e1",
    runs: rows.map(snapshot),
    loopies: [],
    schedules: [],
    graphs: [],
    pins: {},
    batches: [],
    intervalMs: 0,
  });

  const client = new QueryClient();
  const observer = new InfiniteQueryObserver(client, runPagesQuery(backend, {}));
  const unsubscribe = observer.subscribe(() => undefined);

  try {
    await observer.refetch();

    for (let page = 0; page < 10; page++) {
      await observer.fetchNextPage();
      expect(observer.getCurrentResult().data?.pages.flat().length).toBeLessThanOrEqual(200);
    }

    expect(observer.getCurrentResult().data?.pages.flat().at(-1)?.id).toBe("run-274");
    expect(observer.getCurrentResult().data?.pages.flat().at(0)?.id).toBe("run-75");
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("the displayed run page keeps its next cursor after the oldest row leaves", () => {
  const client = new QueryClient();
  const key = keys.runPage({ status: "queued", limit: 1 });
  const cursor = encodeRunCursor(queued);
  client.setQueryData(key, { runs: [queued], nextCursor: cursor });
  applyBatch(client, [event(running, 11, "claimed")]);
  expect(client.getQueryData<RunPage>(key)).toEqual({ runs: [], nextCursor: cursor });
  client.clear();
});

test("map item pagination retains at most 200 rows and continues numeric cursors", async () => {
  const nodeRuns = Array.from(Array.from({ length: 250 }).keys(), (index) =>
    nodeRunViewSchema.parse({
      key: { runId: queued.id, nodeId: "1:work", scope: [{ nodeId: "0:map", index }] },
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: queued.createdAt,
      receipt: "started",
    }),
  );

  const backend = fakeBackend({
    epoch: "e1",
    runs: [{ ...snapshot(queued), nodeRuns }],
    loopies: [],
    schedules: [],
    graphs: [],
    pins: {},
    batches: [],
    intervalMs: 0,
  });

  const client = new QueryClient();

  const observer = new InfiniteQueryObserver(
    client,
    scopeItemsQuery(backend, queued.id, { nodeId: "0:map", parentScope: "[]" }),
  );

  const unsubscribe = observer.subscribe(() => undefined);

  try {
    await observer.refetch();

    for (let page = 0; page < 4; page++) {
      await observer.fetchNextPage();
    }

    const rows = observer.getCurrentResult().data?.pages.flatMap((page) => page.items);
    expect(rows).toHaveLength(200);
    expect(rows?.[0]?.index).toBe(50);
    expect(rows?.at(-1)?.index).toBe(249);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("a filtered log scan continues from its cursor even when no rows matched", async () => {
  const backend = fakeBackend({
    epoch: "e1",
    runs: [],
    loopies: [],
    schedules: [],
    graphs: [],
    pins: {},
    batches: [],
    intervalMs: 0,
  });

  const cursors: unknown[] = [];
  backend.globalLogs = async (query) => {
    cursors.push(query.before);

    return {
      items: [],
      next: query.before === undefined ? 400 : null,
      hasMore: query.before === undefined,
      scanned: 2000,
      oldest: 1,
      newest: 2400,
    };
  };

  const client = new QueryClient();
  const observer = new InfiniteQueryObserver(client, logPagesQuery(backend, { text: "rare" }));
  const unsubscribe = observer.subscribe(() => undefined);

  try {
    await observer.refetch();
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    await observer.fetchNextPage();
    expect(cursors).toEqual([undefined, 400]);
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("a filtered event scan continues independently of the returned row count", async () => {
  const backend = fakeBackend({
    epoch: "e1",
    runs: [],
    loopies: [],
    schedules: [],
    graphs: [],
    pins: {},
    batches: [],
    intervalMs: 0,
  });

  const cursors: unknown[] = [];
  backend.eventHistory = async (query) => {
    cursors.push(query.before);

    return {
      items: [],
      next: query.before === undefined ? 300 : null,
      hasMore: query.before === undefined,
      scanned: 2000,
      oldest: 1,
      newest: 2300,
    };
  };

  const client = new QueryClient();
  const observer = new InfiniteQueryObserver(client, eventPagesQuery(backend, { kind: "rare" }));
  const unsubscribe = observer.subscribe(() => undefined);

  try {
    await observer.refetch();
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    await observer.fetchNextPage();
    expect(cursors).toEqual([undefined, 300]);
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
  } finally {
    unsubscribe();
    client.clear();
  }
});
