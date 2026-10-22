import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { jsonSchema, routes } from "../src/contract/index.js";
import { revision } from "../src/core/index.js";
import { log, loopy, wait } from "../src/sdk/graph/index.js";
import { compiledBody } from "./compiled-fixture.js";

let runtime: Miniflare;

let directory: string;

const tokenA = "synthetic-workerd-credential-alpha-0001";

const tokenB = "synthetic-workerd-credential-bravo-0002";

beforeAll(async () => {
  const root = resolve(import.meta.dir, "../../..");
  const parent = resolve(root, ".loopy/cloud/tests");
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(`${parent}/workerd-`);

  const bundle = await Bun.build({
    entrypoints: [
      resolve(root, "apps/cloud/src/worker.ts"),
      resolve(import.meta.dir, "fixtures/cloud-worker-probe.ts"),
    ],
    target: "browser",
    format: "esm",
    outdir: directory,
    naming: "[name].js",
  });

  expect(bundle.logs).toEqual([]);
  expect(bundle.success).toBe(true);
  runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        name: "cloud",
        modules: true,
        scriptPath: resolve(directory, "worker.js"),
        compatibilityDate: "2026-07-30",
        durableObjects: { WORKSPACES: { className: "Workspace", useSQLite: true } },
        r2Buckets: { ARTIFACTS: "synthetic-artifacts" },
        bindings: {
          LOOPY_STAGE: "local",
          LOCAL_AUTH: JSON.stringify([
            { token: tokenA, workspace: "alpha" },
            { token: tokenB, workspace: "bravo" },
          ]),
          SANDBOX_URL: "http://127.0.0.1:1",
          SANDBOX_TOKEN: "synthetic-unused-provider-token",
          CONCURRENCY: "1",
        },
      },
      {
        name: "probe",
        modules: true,
        scriptPath: resolve(directory, "cloud-worker-probe.js"),
        compatibilityDate: "2026-07-30",
        durableObjects: { PROBES: { className: "CloudWorkerProbe", useSQLite: true } },
        r2Buckets: { ARTIFACTS: "synthetic-artifacts" },
      },
    ],
  });
  await runtime.ready;
}, 60_000);

afterAll(async () => {
  try {
    await runtime?.dispose();
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function probe(command: string, instance = command) {
  const namespace = await runtime.getDurableObjectNamespace("PROBES", "probe");

  const response = await namespace
    .get(namespace.idFromName(instance))
    .fetch(`http://probe/${command}`);

  const body: unknown = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status: 200 });

  return jsonSchema.parse(body);
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
    error: "Invalid time value",
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
    before: { cursor: 4 },
    after: { cursor: 4 },
    run: { owner: { token: "second", pid: null, host: "probe" } },
    marker: "retained",
    logs: [],
  });
  await runtime.unsafeEvictDurableObject("probe", "CloudWorkerProbe", { name: "owners" });
  expect(await probe("reopen", "owners")).toMatchObject({
    cursor: { cursor: 4 },
    marker: "retained",
    run: { owner: { token: "second", host: "probe", pid: null } },
  });
});

test("workerd schedule fire rolls back its pointer on conflict and deduplicates a repeated fire", async () => {
  expect(await probe("schedules")).toMatchObject({
    error: "Run 'run' already exists. Use a new run ID.",
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

test("R2 conditional create preserves the original bytes and enforces bounded tenant reads", async () => {
  expect(await probe("r2")).toEqual({
    value: "original",
    conditionalRejected: true,
    other: null,
    oversized: "Artifact exceeds its 7 byte limit.",
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
  expect(routes.runs.response.parse(await runs.json())).toEqual([]);
  expect(
    routes.loopies.response
      .parse(await (await api("/loopies")).json())
      .some(({ slug }) => slug === "invalid"),
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
  }).graph;
  body.revision = await revision(body.graph);
  expect((await api("/loopies/alarm-wait", { method: "PUT", body })).status).toBe(200);

  const started = routes.startRun.response.parse(
    await (await api("/loopies/alarm-wait/runs", { method: "POST", body: { input: {} } })).json(),
  );

  let snapshot = routes.run.response.parse(await (await api(`/runs/${started.id}`)).json());
  const deadline = Date.now() + 5000;

  while (snapshot.hooks.length === 0 && Date.now() < deadline) {
    await Bun.sleep(25);
    snapshot = routes.run.response.parse(await (await api(`/runs/${started.id}`)).json());
  }

  const hook = snapshot.hooks[0];
  expect(hook).toBeDefined();

  if (!hook) {
    throw new Error("Worker alarm did not persist its wait within five seconds.");
  }

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
  const feed = routes.globalLogs.response.parse(await (await api("/logs?text=approval")).json());
  expect(feed.items).toMatchObject([{ runId: started.id, message: "Synthetic approval ready" }]);
  expect(
    routes.globalLogs.response.parse(
      await (await api("/logs?text=approval", { token: tokenB })).json(),
    ).items,
  ).toEqual([]);

  const history = routes.eventHistory.response.parse(
    await (await api(`/event-history?runId=${started.id}`)).json(),
  );

  expect(history.items.some((event) => event.entity === "hook" && event.kind === "created")).toBe(
    true,
  );
  expect(
    routes.eventHistory.response.parse(
      await (await api(`/event-history?runId=${started.id}`, { token: tokenB })).json(),
    ).items,
  ).toEqual([]);
  expect((await api(`/logs/${feed.items[0]?.id}`, { token: tokenB })).status).toBe(404);
  expect(
    (await api(`/event-history/${history.items[0]?.sequence}`, { token: tokenB })).status,
  ).toBe(404);
  const executions = await api(`/runs/${started.id}/executions`);
  expect(executions.status).toBe(200);
  expect(routes.executions.response.parse(await executions.json()).items.length).toBeGreaterThan(0);

  const window = new URLSearchParams({
    from: new Date(Date.now() - 60_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  });

  const overview = await api(`/overview?${window}`);
  expect(overview.status).toBe(200);
  routes.overview.response.parse(await overview.json());
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
  const started = routes.startRun.response.parse(await start.json());
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
  expect(routes.graph.response.parse(await latest.json())).toMatchObject({
    revision: second.revision,
  });
  expect(
    routes.source.response.parse(await (await api("/loopies/tenant-proof/source")).json()),
  ).toEqual(second.sourceArtifact);
  const overwrite = structuredClone(first);
  overwrite.sourceArtifact = {
    ...first.sourceArtifact,
    files: [{ id: "file-1", path: "tenant-proof.ts", content: "overwrite attempt" }],
  };
  expect((await api("/loopies/tenant-proof", { method: "PUT", body: overwrite })).status).toBe(200);
  const historical = await api(`/runs/${started.id}/source`);
  expect(routes.runSource.response.parse(await historical.json())).toMatchObject(
    first.sourceArtifact,
  );
  const graph = await api(`/runs/${started.id}/graph`);
  expect(routes.runGraph.response.parse(await graph.json())).toMatchObject({
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
  const alphaCursor = routes.cursor.response.parse(await (await api("/cursor")).json());

  const bravoCursor = routes.cursor.response.parse(
    await (await api("/cursor", { token: tokenB })).json(),
  );

  expect(alphaCursor.epoch).not.toBe(bravoCursor.epoch);
  expect((await api(`/events?after=0&epoch=${alphaCursor.epoch}`, { token: tokenB })).status).toBe(
    410,
  );
  expect(routes.runs.response.parse(await (await api("/runs", { token: tokenB })).json())).toEqual(
    [],
  );
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
    routes.source.response.parse(
      await (await api("/loopies/tenant-proof/source", { token: tokenB })).json(),
    ),
  ).toEqual(bravo.sourceArtifact);
  expect(
    routes.source.response.parse(await (await api("/loopies/tenant-proof/source")).json()),
  ).toEqual(first.sourceArtifact);
});
