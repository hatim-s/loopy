import { expect, spyOn, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import {
  encodeRunCursor,
  type RunSnapshotView,
  type RunView,
  type ServerEvent,
} from "loopy/contract";
import { fakeBackend } from "../src/backend/fake.ts";
import { keys } from "../src/lib/keys.ts";
import { RUN_PAGE_SIZE, runPagesQuery } from "../src/lib/queries.ts";
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
