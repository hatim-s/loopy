import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { executionKeyString, routes } from "../src/contract/index.js";
import { RUN_PREVIEW_COLUMNS } from "../src/store/sqlite/query-runs.js";
import { largeMapFixture, manyRunsFixture } from "./dashboard-scale-fixture.js";

function bytes<T>(value: T) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function benchmarkDashboardQueries() {
  const map = await largeMapFixture();
  const runs = await manyRunsFixture();
  const measurements: { name: string; ms: number; bytes: number; rows: number }[] = [];

  async function measure<T extends object>(
    name: string,
    query: () => Promise<T>,
    rows: (value: T) => number,
  ) {
    const started = performance.now();
    const result = await query();
    measurements.push({
      name,
      ms: performance.now() - started,
      bytes: bytes(result),
      rows: rows(result),
    });

    return result;
  }

  const snapshot = routes.run.response.parse(
    await measure(
      "10k map slim snapshot",
      () => map.service.runSnapshot(map.runId),
      (value) => value.nodeRuns.length,
    ),
  );

  expect(snapshot.nodeRuns.length).toBeLessThanOrEqual(200);
  expect(snapshot.logs).toEqual([]);
  expect(snapshot.scopes?.[0]?.total).toBe(10000);
  expect(bytes(snapshot)).toBeLessThan(25000);
  expect(snapshot.run.truncatedFields?.input).toBeGreaterThan(16384);

  const items = await measure(
    "10k map item page50",
    () => map.store.scopeItems(map.runId, { nodeId: map.mapNodeId, parentScope: "[]", limit: 50 }),
    (value) => value.items.length,
  );

  expect(items.items).toHaveLength(50);
  expect(items.next).toBe(49);

  const selected = await measure(
    "10k map selected item",
    () =>
      map.store.nodePage(map.runId, {
        scope: JSON.stringify([{ nodeId: map.mapNodeId, index: 9999 }]),
        limit: 50,
      }),
    (value) => value.items.length,
  );

  expect(selected.items).toHaveLength(1);
  expect(selected.items[0]).not.toHaveProperty("inputView");
  const key = selected.items[0] ? executionKeyString(selected.items[0].key) : "";
  const detail = await map.service.execution(map.runId, { key });
  expect(detail.node.inputView?.state).toBe("available");
  expect((await map.service.runSource(map.runId)).status).toBe("available");
  expect((await map.service.runGraph(map.runId)).graph.name).toBe("reindex-docs");

  const logs = await measure(
    "10k map log page100",
    () => map.store.logPage({ runId: map.runId, limit: 100 }),
    (value) => value.items.length,
  );

  expect(logs.items).toHaveLength(100);
  expect(logs.scanned).toBe(100);
  expect(logs.items[0]).not.toHaveProperty("data");

  const events = await measure(
    "10k map event page100",
    () => map.store.eventPage({ runId: map.runId, limit: 100 }),
    (value) => value.items.length,
  );

  expect(events.items).toHaveLength(100);
  expect(events.items[0]).not.toHaveProperty("record");

  const page = await measure(
    "10k workflow run page50",
    () => runs.service.listRuns({ limit: 50 }),
    (value) => value.length,
  );

  expect(page).toHaveLength(50);
  const last = page.at(-1);
  expect(last).toBeDefined();

  const next = await runs.service.listRuns({
    limit: 50,
    before: last ? `${last.createdAt}|${last.id}` : undefined,
  });

  expect(next).toHaveLength(50);
  expect(new Set([...page, ...next].map((run) => run.id)).size).toBe(100);

  const summary = await measure(
    "10k workflow overview",
    () =>
      runs.service.overview({
        from: "2026-10-15T00:00:00.000Z",
        to: "2026-10-22T00:00:00.000Z",
        bucketSeconds: 3600,
      }),
    (value) => value.buckets.length,
  );

  expect(summary.counts.succeeded).toBe(9000);
  expect(summary.counts.failed).toBe(1000);
  expect(summary.buckets).toHaveLength(168);

  const loopies = await measure(
    "10k workflow loopy summaries/latest10",
    () => runs.service.listLoopies(runs.root),
    (value) => value.length,
  );

  expect(loopies[0]?.latestRuns).toHaveLength(10);
  expect(loopies[0]?.counts.succeeded).toBe(9000);
  const plans: Record<string, object[]> = {};

  for (const [name, home, sql, params] of [
    [
      "runs keyset",
      runs.home,
      `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE (r.created_at,r.id)<(?,?) ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
      [last?.createdAt ?? "", last?.id ?? "", 50],
    ],
    [
      "runs slug",
      runs.home,
      `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE r.slug=? ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
      ["queue-drain", 50],
    ],
    [
      "runs workspace",
      runs.home,
      `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE r.workspace=? ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
      [runs.root, 50],
    ],
    [
      "node scope",
      map.home,
      "SELECT record FROM node_runs WHERE run_id=? AND scope=? ORDER BY execution_key LIMIT ?",
      [map.runId, "[]", 201],
    ],
    [
      "scope items",
      map.home,
      "SELECT DISTINCT item_index FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index>? ORDER BY item_index LIMIT ?",
      [map.runId, map.mapNodeId, "[]", -1, 51],
    ],
    [
      "scope filtered items",
      map.home,
      "SELECT DISTINCT item_index FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index>? AND status=? ORDER BY item_index LIMIT ?",
      [map.runId, map.mapNodeId, "[]", -1, "succeeded", 51],
    ],
    [
      "log append seq",
      map.home,
      "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM logs WHERE run_id=?",
      [map.runId],
    ],
    [
      "logs run",
      map.home,
      "SELECT id FROM logs WHERE run_id=? AND id<? ORDER BY id DESC LIMIT ?",
      [map.runId, Number.MAX_SAFE_INTEGER, 2001],
    ],
    [
      "events run",
      map.home,
      "SELECT sequence FROM events WHERE run_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
      [map.runId, Number.MAX_SAFE_INTEGER, 2001],
    ],
  ] as const) {
    const db = new Database(join(home, "runs.sqlite"), { readonly: true });
    plans[name] = db
      .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params);
    db.close();
  }

  expect(JSON.stringify(plans["runs keyset"])).toContain("runs_created_id");
  expect(JSON.stringify(plans["runs workspace"])).toContain("runs_workspace_created_id");
  expect(JSON.stringify(plans["scope filtered items"])).toContain("status=? AND item_index>?");

  return {
    map,
    runs,
    measurements,
    plans,
    limits: {
      page: 200,
      feedCandidates: 2000,
      nodeOutputPreviewBytes: 16384,
      overviewBuckets: 744,
    },
    note: "Local synthetic read measurements only. Ingest uses store writes without activation, executors, or provider calls. Both datasets contain terminal runs.",
  };
}

test("dashboard queries bound payloads independently across 10k map rows and 10k workflow runs", async () => {
  const result = await benchmarkDashboardQueries();

  if (process.env.LOOPY_RETAIN_QUERY_FIXTURE === "1") {
    const receipt = {
      map: {
        home: result.map.home,
        workspace: result.map.root,
        runId: result.map.runId,
        mapNodeId: result.map.mapNodeId,
        nodeId: result.map.nodeId,
        ingestMs: result.map.ingestMs,
      },
      runs: { home: result.runs.home, workspace: result.runs.root, ingestMs: result.runs.ingestMs },
      measurements: result.measurements,
      plans: result.plans,
      limits: result.limits,
      note: result.note,
    };

    result.map.store.close();
    result.runs.store.close();
    await Bun.write(
      process.env.LOOPY_QUERY_RECEIPT ?? join(result.map.root, "benchmark.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt, null, 2));

    return;
  }

  for (const fixture of [result.map, result.runs]) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 60000);
