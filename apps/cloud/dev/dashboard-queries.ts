// Times the dashboard's bounded reads over the 10k-row fixtures and records their SQLite plans.
// Usage: bun --no-env-file apps/cloud/dev/dashboard-queries.ts [receipt.json]
// The fixture state stays under .loopy/dashboard-queries for inspection; delete it when done.
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_OVERVIEW_BUCKETS, MAX_PREVIEW_BYTES, PAGE_LIMIT } from "@loopy/contract";
import { Effect, Exit, Scope } from "effect";
import {
  largeMapFixture,
  manyRunsFixture,
} from "../../../packages/loopy/_tests_/dashboard-scale-fixture";
import {
  dashboardReads,
  queryPlans,
} from "../../../packages/loopy/_tests_/fixtures/dashboard-reads";
import { FEED_SCAN_LIMIT } from "../../../packages/runtime/src/store/query/scan";

const parent = resolve(import.meta.dir, "../../..", ".loopy/dashboard-queries");

function datasetRoot(name: string) {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `${name}-`));
  mkdirSync(join(root, ".loopy/loopies"), { recursive: true });

  return root;
}

const scope = Scope.makeUnsafe();

try {
  const map = await largeMapFixture(datasetRoot("10k-map"), scope);
  const runs = await manyRunsFixture(datasetRoot("10k-runs"), scope);
  const measurements: { name: string; ms: number; bytes: number; rows: number }[] = [];

  for (const [name, read] of Object.entries(dashboardReads(map, runs))) {
    const started = performance.now();
    const { value, rows } = await read();
    const ms = performance.now() - started;
    measurements.push({
      name,
      ms,
      bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
      rows,
    });
  }

  const receipt = {
    map: {
      home: map.home,
      workspace: map.root,
      runId: map.runId,
      mapNodeId: map.mapNodeId,
      nodeId: map.nodeId,
      ingestMs: map.ingestMs,
    },
    runs: { home: runs.home, workspace: runs.root, ingestMs: runs.ingestMs },
    measurements,
    plans: queryPlans(map),
    limits: {
      page: PAGE_LIMIT,
      feedCandidates: FEED_SCAN_LIMIT,
      nodeOutputPreviewBytes: MAX_PREVIEW_BYTES,
      overviewBuckets: MAX_OVERVIEW_BUCKETS,
    },
    note: "Local synthetic read measurements only. Ingest uses store writes without activation, executors, or provider calls. Both datasets contain terminal runs.",
  };

  const text = JSON.stringify(receipt, null, 2);
  await Bun.write(process.argv[2] ?? join(map.root, "benchmark.json"), text);
  console.log(text);
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void));
}
