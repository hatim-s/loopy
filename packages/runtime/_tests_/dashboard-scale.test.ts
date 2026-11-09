import { expect, test } from "bun:test";
import {
  decodeBoundary,
  executionKeyString,
  MAX_PREVIEW_BYTES,
  PAGE_LIMIT,
  routes,
} from "@loopy/contract";
import { Effect } from "effect";
import { dashboardReads, queryPlans } from "./fixtures/dashboard-reads";
import { largeMapFixture, manyRunsFixture } from "./fixtures/dashboard-scale";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { fixtureScope } from "./fixtures/test-scope";

function bytes<T>(value: T) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

test("dashboard queries bound payloads independently across 10k map rows and 10k workflow runs", async () => {
  const scope = fixtureScope();
  const map = await largeMapFixture(qualityTestRoot("dashboard-10k-map"), scope);
  const runs = await manyRunsFixture(qualityTestRoot("dashboard-10k-runs"), scope);
  const reads = dashboardReads(map, runs);

  const snapshot = decodeBoundary(routes.run.response)((await reads.mapSnapshot()).value);
  expect(snapshot.nodeRuns.length).toBeLessThanOrEqual(PAGE_LIMIT);
  expect(snapshot.logs).toEqual([]);
  expect(snapshot.scopes?.[0]?.total).toBe(10000);
  expect(bytes(snapshot)).toBeLessThan(25000);
  expect(snapshot.run.truncatedFields?.input).toBeGreaterThan(MAX_PREVIEW_BYTES);

  const items = (await reads.mapItemPage()).value;
  expect(items.items).toHaveLength(50);
  expect(items.next).toBe(49);

  const selected = (await reads.mapSelectedItem()).value;
  expect(selected.items).toHaveLength(1);
  expect(selected.items[0]).not.toHaveProperty("inputView");
  const key = selected.items[0] ? executionKeyString(selected.items[0].key) : "";
  const detail = await Effect.runPromise(map.service.execution(map.runId, { key }));
  expect(detail.node.inputView?.state).toBe("available");
  expect((await Effect.runPromise(map.service.runSource(map.runId))).status).toBe("available");
  expect((await Effect.runPromise(map.service.runGraph(map.runId))).graph.name).toBe(
    "reindex-docs",
  );

  const logs = (await reads.mapLogPage()).value;
  expect(logs.items).toHaveLength(100);
  expect(logs.scanned).toBe(100);
  expect(logs.items[0]).not.toHaveProperty("data");

  const events = (await reads.mapEventPage()).value;
  expect(events.items).toHaveLength(100);
  expect(events.items[0]).not.toHaveProperty("record");

  const page = (await reads.runPage()).value;
  expect(page).toHaveLength(50);
  const last = page.at(-1);
  expect(last).toBeDefined();

  const next = await Effect.runPromise(
    runs.service.listRuns({
      limit: 50,
      before: last ? `${last.createdAt}|${last.id}` : undefined,
    }),
  );

  expect(next).toHaveLength(50);
  expect(new Set([...page, ...next].map((run) => run.id)).size).toBe(100);

  const workspacePage = (await reads.workspaceRunPage()).value;
  expect(workspacePage).toHaveLength(50);
  expect(workspacePage.every((run) => run.workspace === runs.root)).toBe(true);

  const summary = (await reads.overview()).value;
  expect(summary.counts.succeeded).toBe(9000);
  expect(summary.counts.failed).toBe(1000);
  expect(summary.buckets).toHaveLength(168);

  const loopies = (await reads.loopySummaries()).value;
  expect(loopies[0]?.latestRuns).toHaveLength(10);
  expect(loopies[0]?.counts.succeeded).toBe(9000);

  expect(JSON.stringify(queryPlans(map)["scope filtered items"])).toContain(
    "status=? AND item_index>?",
  );
}, 60000);
