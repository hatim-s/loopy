import { expect, test } from "bun:test";
import {
  encodeRunCursor,
  type RunPage,
  type RunSnapshotView,
  type RunView,
  type ServerEvent,
} from "@loopy/contract";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/lib/keys";
import { applyBatch } from "../src/lib/stream/apply";
import { applyToSnapshot } from "../src/lib/stream/snapshot";

const queued: RunView = {
  id: "run-a",
  slug: "triage",
  workspace: "/work",
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

const queuedList = keys.runPage({ status: "queued", limit: 25 });

const runningList = keys.runPage({ status: "running", limit: 25 });

function page(runs: RunView[]): RunPage {
  return { runs, next: null };
}

function snapshot(run: RunView): RunSnapshotView {
  return {
    run,
    nodeRuns: [],
    nodeRunsNext: null,
    truncatedOutputs: {},
    hooks: [],
    hooksTruncated: false,
    cursor: 10,
    epoch: "e1",
  };
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
  client.setQueryData(queuedList, page([queued]));
  client.setQueryData(runningList, page([]));
  client.setQueryData(keys.loopies, []);

  return client;
}

test("detail heartbeat and queued-to-running delivery in either order reconcile lists once", () => {
  for (const heartbeatFirst of [true, false]) {
    const client = cache();

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

    expect(client.getQueryState(runningList)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(true);

    // A replay of the same transaction plus a heartbeat changes no list again.
    client.setQueryData(runningList, page([running]));
    client.setQueryData(keys.loopies, []);
    applyBatch(client, [event(heartbeat, 12, "heartbeat"), event(running, 11, "claimed")]);

    expect(client.getQueryData<RunPage>(queuedList)?.runs).toEqual([]);
    expect(client.getQueryData<RunPage>(runningList)?.runs).toEqual([heartbeat]);
    expect(client.getQueryState(runningList)?.isInvalidated).toBe(false);
    expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(false);
    expect(client.getQueryData<RunSnapshotView>(keys.run(queued.id))?.run).toEqual(heartbeat);
  }
});

test("garbage collecting a list discards its stream freshness history", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  client.setQueryData(queuedList, page([queued]));
  applyBatch(client, [event(running, 12, "claimed")]);
  expect(client.getQueryData<RunPage>(queuedList)?.runs).toEqual([]);

  const query = client.getQueryCache().find({ queryKey: queuedList, exact: true });

  const removed = new Promise<void>((resolve) => {
    const unsubscribe = client.getQueryCache().subscribe((change) => {
      if (change.type === "removed" && change.query === query) {
        unsubscribe();
        resolve();
      }
    });
  });

  await removed;
  expect(client.getQueryCache().find({ queryKey: queuedList, exact: true })).toBeUndefined();

  client.setQueryData(queuedList, page([queued]));
  applyBatch(client, [event(running, 11, "claimed")]);
  expect(client.getQueryData<RunPage>(queuedList)?.runs).toEqual([]);
  client.clear();
});

test("the displayed run page keeps its next cursor after the oldest row leaves", () => {
  const client = new QueryClient();
  const key = keys.runPage({ status: "queued", limit: 1 });
  const cursor = encodeRunCursor(queued);
  client.setQueryData(key, { runs: [queued], next: cursor });
  applyBatch(client, [event(running, 11, "claimed")]);
  expect(client.getQueryData<RunPage>(key)).toEqual({ runs: [], next: cursor });
  client.clear();
});
