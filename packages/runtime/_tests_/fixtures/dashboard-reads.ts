import { Database } from "bun:sqlite";
import { join } from "node:path";
import { PAGE_LIMIT } from "@loopy/contract";
import { Effect } from "effect";
import { FEED_SCAN_LIMIT } from "../../src/store/query/scan";
import type { largeMapFixture, manyRunsFixture } from "./dashboard-scale";

type LargeMap = Awaited<ReturnType<typeof largeMapFixture>>;

type ManyRuns = Awaited<ReturnType<typeof manyRunsFixture>>;

const measured =
  <T>(read: () => Promise<T>, rows: (value: T) => number) =>
  async () => {
    const value = await read();

    return { value, rows: rows(value) };
  };

/** The dashboard's bounded reads over both datasets, each with the row count it returns. */
export function dashboardReads(map: LargeMap, runs: ManyRuns) {
  return {
    mapSnapshot: measured(
      () => Effect.runPromise(map.service.runSnapshot(map.runId)),
      (value) => value.nodeRuns.length,
    ),
    mapItemPage: measured(
      () =>
        Effect.runPromise(
          map.store.scopeItems(map.runId, { nodeId: map.mapNodeId, parentScope: "[]", limit: 50 }),
        ),
      (value) => value.items.length,
    ),
    mapSelectedItem: measured(
      () =>
        Effect.runPromise(
          map.store.nodePage(map.runId, {
            scope: JSON.stringify([{ nodeId: map.mapNodeId, index: 9999 }]),
            limit: 50,
          }),
        ),
      (value) => value.items.length,
    ),
    mapLogPage: measured(
      () => Effect.runPromise(map.store.logPage({ runId: map.runId, limit: 100 })),
      (value) => value.items.length,
    ),
    mapEventPage: measured(
      () => Effect.runPromise(map.store.eventPage({ runId: map.runId, limit: 100 })),
      (value) => value.items.length,
    ),
    runPage: measured(
      () => Effect.runPromise(runs.service.listRuns({ limit: 50 })),
      (value) => value.length,
    ),
    workspaceRunPage: measured(
      () =>
        Effect.runPromise(
          runs.store.queryRuns({ workspace: runs.root, limit: 50, now: new Date().toISOString() }),
        ),
      (value) => value.length,
    ),
    overview: measured(
      () =>
        Effect.runPromise(
          runs.service.overview({
            from: "2026-10-15T00:00:00.000Z",
            to: "2026-10-22T00:00:00.000Z",
            bucketSeconds: 3600,
          }),
        ),
      (value) => value.buckets.length,
    ),
    loopySummaries: measured(
      () => Effect.runPromise(runs.service.listLoopies(runs.root)),
      (value) => value.length,
    ),
  };
}

/** SQLite plans for the hot dashboard queries, read from the map dataset's database. */
export function queryPlans(map: LargeMap) {
  const queries = [
    [
      "node scope",
      "SELECT record FROM node_runs WHERE run_id=? AND scope=? ORDER BY execution_key LIMIT ?",
      [map.runId, "[]", PAGE_LIMIT + 1],
    ],
    [
      "scope items",
      "SELECT DISTINCT item_index FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index>? ORDER BY item_index LIMIT ?",
      [map.runId, map.mapNodeId, "[]", -1, 51],
    ],
    [
      "scope filtered items",
      "SELECT DISTINCT item_index FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index>? AND status=? ORDER BY item_index LIMIT ?",
      [map.runId, map.mapNodeId, "[]", -1, "succeeded", 51],
    ],
    [
      "log append seq",
      "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM logs WHERE run_id=?",
      [map.runId],
    ],
    [
      "logs run",
      "SELECT id FROM logs WHERE run_id=? AND id<? ORDER BY id DESC LIMIT ?",
      [map.runId, Number.MAX_SAFE_INTEGER, FEED_SCAN_LIMIT + 1],
    ],
    [
      "events run",
      "SELECT sequence FROM events WHERE run_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
      [map.runId, Number.MAX_SAFE_INTEGER, FEED_SCAN_LIMIT + 1],
    ],
  ] as const;

  const db = new Database(join(map.home, "runs.sqlite"), { readonly: true });

  try {
    return Object.fromEntries(
      queries.map(([name, sql, params]) => [
        name,
        db
          .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params),
      ]),
    );
  } finally {
    db.close();
  }
}
