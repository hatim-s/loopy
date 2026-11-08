import { beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { decodeBoundary, encodeRunCursor, jsonSchema, routes } from "@loopy/contract";
import { revision, waitRecordSchema } from "@loopy/core";
import { log, loopy, wait } from "@loopy/sdk/graph";
import { Schema } from "effect";
import type { Miniflare } from "miniflare";
import { bundleForBrowser } from "../../../packages/runtime/_tests_/fixtures/bundle";
import { compiledBody } from "../../../packages/runtime/_tests_/fixtures/compiled";
import { qualityTestRoot } from "../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { fileScope, onCleanup } from "../../../packages/runtime/_tests_/fixtures/test-scope";
import { until } from "../../../packages/runtime/_tests_/fixtures/wait";
import { cloudBucket, cloudWorker, startWorkerd, testWorker } from "./fixtures/workerd";

let runtime: Miniflare;

let directory: string;

const tokenA = "synthetic-workerd-credential-alpha-0001";

const tokenB = "synthetic-workerd-credential-bravo-0002";

const scope = fileScope();

beforeAll(async () => {
  const root = resolve(import.meta.dir, "../../..");
  directory = qualityTestRoot("workerd", { scope });

  await bundleForBrowser(
    [
      resolve(root, "apps/cloud/src/worker.ts"),
      resolve(import.meta.dir, "fixtures/cloud-worker-probe.ts"),
    ],
    directory,
  );

  runtime = await startWorkerd({
    workers: [
      cloudWorker(directory, {
        LOCAL_AUTH: JSON.stringify([
          { token: tokenA, workspace: "alpha" },
          { token: tokenB, workspace: "bravo" },
        ]),
        SANDBOX_URL: "http://127.0.0.1:1",
        SANDBOX_TOKEN: "synthetic-unused-provider-token",
        CONCURRENCY: "1",
      }),
      testWorker({
        name: "probe",
        scriptPath: resolve(directory, "cloud-worker-probe.js"),
        durableObjects: { PROBES: { className: "CloudWorkerProbe", useSQLite: true } },
        r2Buckets: { ARTIFACTS: cloudBucket("ARTIFACTS") },
      }),
    ],
  });
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

function api(
  path: string,
  options: {
    token?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return runtime.dispatchFetch(`http://127.0.0.1/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${options.token ?? tokenA}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
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

    return decodeBoundary(routes.runs.response)(body);
  }

  const boundaries = [];

  for (const limit of [99, 100, 200]) {
    const response = await object.fetch(`http://probe/pagination/runs?limit=${limit}`);
    const body: unknown = await response.json();
    boundaries.push({
      limit,
      status: response.status,
      result: response.ok ? decodeBoundary(routes.runs.response)(body).length : body,
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

test("Worker derives workspace from credentials and rejects workspace/header/origin spoofing", async () => {
  expect((await api("/cursor", { token: "invalid" })).status).toBe(401);
  const status = await api("/cloud/status", { headers: { "X-Loopy-Workspace": "bravo" } });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ workspace: "alpha" });
  expect((await api("/loopies?workspace=bravo")).status).toBe(403);
  expect((await api("/loopies", { headers: { Origin: "https://untrusted.invalid" } })).status).toBe(
    403,
  );
});

test("Worker rejects invalid save/run inputs without publishing or creating runs", async () => {
  expect((await api("/loopies/invalid", { method: "PUT", body: {} })).status).toBe(400);

  const first = await compiledBody("input-check", "synthetic/input-check.ts", {
    workspace: "alpha",
  });

  first.graph.input = { required: "string" };
  first.revision = await revision(first.graph);
  expect((await api("/loopies/input-check", { method: "PUT", body: first })).status).toBe(200);
  expect(
    (await api("/loopies/input-check/runs", { method: "POST", body: { input: {} } })).status,
  ).toBe(400);
  expect(
    (
      await api("/loopies/input-check/runs", {
        method: "POST",
        body: { input: { required: "ok" }, workspace: "bravo" },
      })
    ).status,
  ).toBe(403);
  const runs = await api("/runs?slug=input-check");
  expect(decodeBoundary(routes.runs.response)(await runs.json())).toEqual([]);
  expect(
    decodeBoundary(routes.loopies.response)(await (await api("/loopies")).json()).some(
      ({ slug }) => slug === "invalid",
    ),
  ).toBe(false);
});

test("Worker alarm persists hooks and supports SQL dashboard queries without crossing tenants", async () => {
  const body = await compiledBody("alarm-wait", "synthetic/alarm-wait.ts", { workspace: "alpha" });
  body.graph = loopy("alarm-wait", {
    input: {},
    run: () => {
      log("Synthetic approval ready");

      return wait("approve", {
        timeout: "1h",
        payload: { kind: "record", fields: { approved: "boolean" } },
      });
    },
  });
  body.revision = await revision(body.graph);
  expect((await api("/loopies/alarm-wait", { method: "PUT", body })).status).toBe(200);

  const started = decodeBoundary(routes.startRun.response)(
    await (await api("/loopies/alarm-wait/runs", { method: "POST", body: { input: {} } })).json(),
  );

  // Miniflare has no deterministic alarm trigger, so poll until the alarm persists the wait.
  const hook = await until(
    "the Worker alarm to persist its wait",
    async () =>
      decodeBoundary(routes.run.response)(await (await api(`/runs/${started.id}`)).json()).hooks[0],
  );

  const status = await api("/cloud/status");
  expect(await status.json()).toMatchObject({ errors: [], schedulerError: null });
  expect(
    (
      await api(`/hooks/${hook.token}`, {
        token: tokenB,
        method: "POST",
        body: { payload: { approved: true } },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api(`/runs/${started.id}/hooks/approve`, {
        token: tokenB,
        method: "POST",
        body: { payload: { approved: true } },
      })
    ).status,
  ).toBe(404);

  const feed = decodeBoundary(routes.globalLogs.response)(
    await (await api("/logs?text=approval")).json(),
  );

  expect(feed.items).toMatchObject([{ runId: started.id, message: "Synthetic approval ready" }]);
  expect(
    decodeBoundary(routes.globalLogs.response)(
      await (await api("/logs?text=approval", { token: tokenB })).json(),
    ).items,
  ).toEqual([]);

  const history = decodeBoundary(routes.eventHistory.response)(
    await (await api(`/event-history?runId=${started.id}`)).json(),
  );

  expect(history.items.some((event) => event.entity === "hook" && event.kind === "created")).toBe(
    true,
  );
  expect(
    decodeBoundary(routes.eventHistory.response)(
      await (await api(`/event-history?runId=${started.id}`, { token: tokenB })).json(),
    ).items,
  ).toEqual([]);
  expect((await api(`/logs/${feed.items[0]?.id}`, { token: tokenB })).status).toBe(404);
  expect(
    (await api(`/event-history/${history.items[0]?.sequence}`, { token: tokenB })).status,
  ).toBe(404);
  const executions = await api(`/runs/${started.id}/executions`);
  expect(executions.status).toBe(200);
  expect(
    decodeBoundary(routes.executions.response)(await executions.json()).items.length,
  ).toBeGreaterThan(0);

  const window = new URLSearchParams({
    from: new Date(Date.now() - 60_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  });

  const overview = await api(`/overview?${window}`);
  expect(overview.status).toBe(200);
  decodeBoundary(routes.overview.response)(await overview.json());
  expect(
    (
      await api(`/hooks/${hook.token}`, {
        method: "POST",
        body: { payload: { approved: "invalid" } },
      })
    ).status,
  ).toBe(400);
  expect(
    (await api(`/hooks/${hook.token}`, { method: "POST", body: { payload: { approved: true } } }))
      .status,
  ).toBe(200);
  expect(
    (await api(`/hooks/${hook.token}`, { method: "POST", body: { payload: { approved: false } } }))
      .status,
  ).toBe(404);
});

test("Worker pins historical graph/source revisions and isolates tenant runs, hooks, sources and cursors", async () => {
  const first = await compiledBody("tenant-proof", "synthetic/tenant-proof.ts", {
    workspace: "alpha",
  });

  first.sourceArtifact = {
    version: 1,
    status: "available",
    revision: first.revision,
    files: [{ id: "file-1", path: "tenant-proof.ts", content: "original source" }],
    ranges: [],
  };
  expect((await api("/loopies/tenant-proof", { method: "PUT", body: first })).status).toBe(200);
  const start = await api("/loopies/tenant-proof/runs", { method: "POST", body: { input: {} } });
  expect(start.status).toBe(200);
  const started = decodeBoundary(routes.startRun.response)(await start.json());
  const second = structuredClone(first);
  second.graph.meta.description = "second revision";
  second.revision = await revision(second.graph);
  second.sourceArtifact = {
    ...first.sourceArtifact,
    revision: second.revision,
    files: [{ id: "file-1", path: "tenant-proof.ts", content: "new source" }],
  };
  expect((await api("/loopies/tenant-proof", { method: "PUT", body: second })).status).toBe(200);
  const latest = await api("/loopies/tenant-proof/graph");
  expect(decodeBoundary(routes.graph.response)(await latest.json())).toMatchObject({
    revision: second.revision,
  });
  expect(
    decodeBoundary(routes.source.response)(
      await (await api("/loopies/tenant-proof/source")).json(),
    ),
  ).toEqual(second.sourceArtifact);
  const overwrite = structuredClone(first);
  overwrite.sourceArtifact = {
    ...first.sourceArtifact,
    files: [{ id: "file-1", path: "tenant-proof.ts", content: "overwrite attempt" }],
  };
  expect((await api("/loopies/tenant-proof", { method: "PUT", body: overwrite })).status).toBe(200);
  const historical = await api(`/runs/${started.id}/source`);
  expect(decodeBoundary(routes.runSource.response)(await historical.json())).toMatchObject(
    first.sourceArtifact,
  );
  const graph = await api(`/runs/${started.id}/graph`);
  expect(decodeBoundary(routes.runGraph.response)(await graph.json())).toMatchObject({
    revision: first.revision,
  });

  for (const path of [
    `/runs/${started.id}`,
    `/runs/${started.id}/source`,
    `/runs/${started.id}/graph`,
    `/runs/${started.id}/logs`,
    `/runs/${started.id}/payload`,
    "/loopies/tenant-proof/source",
  ]) {
    expect((await api(path, { token: tokenB })).status).toBe(404);
  }

  expect(
    (
      await api(`/runs/${started.id}/hooks/approve`, {
        token: tokenB,
        method: "POST",
        body: { payload: true },
      })
    ).status,
  ).toBe(404);
  const alphaCursor = decodeBoundary(routes.cursor.response)(await (await api("/cursor")).json());

  const bravoCursor = decodeBoundary(routes.cursor.response)(
    await (await api("/cursor", { token: tokenB })).json(),
  );

  expect(alphaCursor.epoch).not.toBe(bravoCursor.epoch);
  expect((await api(`/events?after=0&epoch=${alphaCursor.epoch}`, { token: tokenB })).status).toBe(
    410,
  );
  expect(
    decodeBoundary(routes.runs.response)(await (await api("/runs", { token: tokenB })).json()),
  ).toEqual([]);
  const bravo = structuredClone(first);
  bravo.source.workspace = "bravo";
  bravo.sourceArtifact = {
    ...first.sourceArtifact,
    files: [{ id: "file-1", path: "tenant-proof.ts", content: "bravo source" }],
  };
  expect(
    (await api("/loopies/tenant-proof", { token: tokenB, method: "PUT", body: bravo })).status,
  ).toBe(200);
  expect(
    decodeBoundary(routes.source.response)(
      await (await api("/loopies/tenant-proof/source", { token: tokenB })).json(),
    ),
  ).toEqual(bravo.sourceArtifact);
  expect(
    decodeBoundary(routes.source.response)(
      await (await api("/loopies/tenant-proof/source")).json(),
    ),
  ).toEqual(first.sourceArtifact);
});
