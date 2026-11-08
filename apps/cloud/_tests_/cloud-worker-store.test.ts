import { beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { decodeBoundary, encodeRunCursor, jsonSchema, routes } from "@loopy/contract";
import { waitRecordSchema } from "@loopy/core";
import { Schema } from "effect";
import type { Miniflare } from "miniflare";
import { bundleForBrowser } from "../../../packages/runtime/_tests_/fixtures/bundle";
import { qualityTestRoot } from "../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { fileScope, onCleanup } from "../../../packages/runtime/_tests_/fixtures/test-scope";
import { cloudBucket, startWorkerd, testWorker } from "./fixtures/workerd";

let runtime: Miniflare;

const scope = fileScope();

beforeAll(async () => {
  const directory = qualityTestRoot("workerd-store", { scope });
  await bundleForBrowser([resolve(import.meta.dir, "fixtures/cloud-worker-probe.ts")], directory);

  runtime = await startWorkerd(
    testWorker({
      name: "probe",
      scriptPath: resolve(directory, "cloud-worker-probe.js"),
      durableObjects: { PROBES: { className: "CloudWorkerProbe", useSQLite: true } },
      r2Buckets: { ARTIFACTS: cloudBucket("ARTIFACTS") },
    }),
  );
  onCleanup(() => runtime.dispose(), scope);
}, 60_000);

async function probe(command: string, instance = command) {
  const namespace = await runtime.getDurableObjectNamespace("PROBES", "probe");

  const response = await namespace
    .get(namespace.idFromName(instance))
    .fetch(`http://probe/${command}`);

  const body: unknown = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status: 200 });

  return decodeBoundary(jsonSchema)(body);
}

test("workerd rolls back logs, usage and outbox rows when an apply batch fails", async () => {
  expect(await probe("rollback")).toMatchObject({
    error: "Invalid store timestamp 'invalid-date'. Validate timestamps before persistence.",
    before: { cursor: 2 },
    after: { cursor: 2 },
    logs: [],
    usage: [],
    published: [],
  });
});

test("workerd reopens durable records and fences stale lease owners without emitting events", async () => {
  expect(await probe("owners")).toMatchObject({
    live: expect.stringContaining("not owned"),
    stale: expect.stringContaining("not owned"),
    heartbeat: false,
    before: { cursor: 5 },
    after: { cursor: 5 },
    run: { owner: { token: "second", pid: null, host: "probe" } },
    marker: "retained",
    logs: [],
  });
  await runtime.unsafeEvictDurableObject("probe", "CloudWorkerProbe", { name: "owners" });
  expect(await probe("reopen", "owners")).toMatchObject({
    cursor: { cursor: 5 },
    marker: "retained",
    run: { owner: { token: "second", host: "probe", pid: null } },
  });
});

test("workerd schedule fire rolls back its pointer on conflict and deduplicates a repeated fire", async () => {
  expect(await probe("schedules")).toMatchObject({
    error: "Storage operation 'fireSchedule' failed: Run 'run' already exists. Use a new run ID.",
    before: { cursor: 2 },
    rolledBack: { schedule: { nextFireAt: "2026-10-22T00:00:00.000Z" }, cursor: { cursor: 2 } },
    fired: true,
    duplicate: false,
    cursor: { cursor: 4 },
    after: { cursor: 4 },
    runs: ["run", "scheduled"],
    events: [
      { entity: "run", kind: "created" },
      { entity: "schedule", kind: "fired" },
    ],
  });
});

test("workerd validates wait payloads and commits exactly one hook, node and wake transaction", async () => {
  expect(await probe("waits")).toMatchObject({
    invalid: { kind: "rejected", code: "bad_request" },
    before: { cursor: 5 },
    unchanged: { cursor: 5 },
    results: [{ kind: "resolved" }, { kind: "rejected" }],
    transactions: 1,
    events: [
      { entity: "hook", kind: "resolved", txn: expect.any(String) },
      { entity: "node", kind: "succeeded" },
      { entity: "run", kind: "woken" },
    ],
    snapshot: {
      run: { status: "suspended", wakeAt: "2026-10-22T00:00:00.000Z" },
      nodeRuns: [{ status: "succeeded", output: { approved: true } }],
      hooks: [{ resolvedAt: "2026-10-22T00:00:00.000Z" }],
    },
  });
});

test("workerd pruning removes the whole transaction across an age boundary and preserves cursor monotonicity", async () => {
  expect(await probe("prune")).toMatchObject({
    removed: 4,
    empty: [],
    cursor: { cursor: 4 },
    next: [{ sequence: 5, kind: "heartbeat" }],
    oldest: 5,
  });
});

test("workerd run pages retain all pending hooks through the 200-row contract limit", async () => {
  const namespace = await runtime.getDurableObjectNamespace("PROBES", "probe");
  const object = namespace.get(namespace.idFromName("pagination"));
  const seeded = await object.fetch("http://probe/pagination/seed");

  const seed = decodeBoundary(
    Schema.Struct({
      total: Schema.Number,
      hooks: Schema.Array(
        Schema.Struct({ ...waitRecordSchema.fields, expiresAt: Schema.NullOr(Schema.String) }),
      ),
    }),
  )(await seeded.json());

  const seededHooks = new Map(seed.hooks.map((hook) => [hook.runId, hook]));
  expect({ status: seeded.status, seed }).toMatchObject({ status: 200 });
  expect(seed).toMatchObject({
    total: 205,
    hooks: expect.arrayContaining([
      expect.objectContaining({ runId: "page-200", resolvedAt: "2026-10-22T00:00:00.000Z" }),
      expect.objectContaining({ runId: "page-201", expiredAt: "2026-10-22T00:00:00.000Z" }),
      expect.objectContaining({ runId: "page-202", expiresAt: "2026-10-22T00:00:00.000Z" }),
    ]),
  });

  async function page(query: string) {
    const response = await object.fetch(`http://probe/pagination/runs?${query}`);
    const body: unknown = await response.json();
    expect({ status: response.status, body }).toMatchObject({ status: 200 });

    return decodeBoundary(routes.runs.response)(body).runs;
  }

  const boundaries = [];

  for (const limit of [99, 100, 200]) {
    const response = await object.fetch(`http://probe/pagination/runs?limit=${limit}`);
    const body: unknown = await response.json();
    boundaries.push({
      limit,
      status: response.status,
      result: response.ok ? decodeBoundary(routes.runs.response)(body).runs.length : body,
    });
  }

  expect(boundaries).toEqual([
    { limit: 99, status: 200, result: 99 },
    { limit: 100, status: 200, result: 100 },
    { limit: 200, status: 200, result: 200 },
  ]);

  const expectedIds = Array.from(
    Array(205).keys(),
    (index) => `page-${String(index).padStart(3, "0")}`,
  ).reverse();

  for (const limit of [99, 100, 200]) {
    const first = await page(`limit=${limit}`);
    expect(first.map(({ id }) => id)).toEqual(expectedIds.slice(0, limit));

    const last = first.at(-1);

    if (!last) {
      throw new Error("Synthetic first page was empty.");
    }

    const rest = await page(`limit=200&before=${encodeURIComponent(encodeRunCursor(last))}`);
    const all = [...first, ...rest];
    expect(all.map(({ id }) => id)).toEqual(expectedIds);
    expect(new Set(all.map(({ id }) => id)).size).toBe(205);

    for (const row of all) {
      const index = Number(row.id.slice(5));

      if (index >= 200) {
        expect(row.waitingOn).toBeNull();
        continue;
      }

      expect(row.waitingOn).toMatchObject({
        hook: `approve-${row.id}`,
        seq: 1,
        expiresAt: index % 2 === 0 ? "2126-10-22T01:00:00.000Z" : null,
        since: "2026-10-22T00:00:00.000Z",
      });
      expect(seededHooks.get(row.id)).toMatchObject({
        runId: row.id,
        name: row.waitingOn?.hook,
        token: row.waitingOn?.token,
        expiresAt: row.waitingOn?.expiresAt,
        createdAt: row.waitingOn?.since,
      });
    }
  }

  const waiting = await page("limit=200&waiting=true");
  expect(waiting.map(({ id }) => id)).toEqual(expectedIds.slice(5));
  expect(new Set(waiting.map(({ waitingOn }) => waitingOn?.token)).size).toBe(200);
  expect((await page("limit=200&waiting=false")).map(({ id }) => id)).toEqual(
    expectedIds.slice(0, 5),
  );
  const oldest = waiting.at(-1);

  if (!oldest) {
    throw new Error("Synthetic waiting page was empty.");
  }

  expect(await page(`limit=200&before=${encodeURIComponent(encodeRunCursor(oldest))}`)).toEqual([]);
  expect((await object.fetch("http://probe/pagination/runs?limit=201")).status).toBe(400);
});

test("R2 conditional create preserves the original bytes and enforces bounded tenant reads", async () => {
  expect(await probe("r2")).toEqual({
    value: "original",
    conditionalRejected: true,
    other: null,
    oversized: "Object exceeds its 7 byte limit.",
  });
});
