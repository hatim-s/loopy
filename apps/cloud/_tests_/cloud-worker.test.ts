import { beforeAll, expect, test } from "bun:test";
import { decodeBoundary, routes } from "@loopy/contract";
import { cloudRoutes, WORKSPACE_HEADER } from "@loopy/contract/sandbox";
import { revision } from "@loopy/core";
import { log, loopy, wait } from "@loopy/sdk/graph";
import type { Miniflare } from "miniflare";
import { compiledBody } from "../../../packages/runtime/_tests_/fixtures/compiled";
import { fileScope, onCleanup } from "../../../packages/runtime/_tests_/fixtures/test-scope";
import { until } from "../../../packages/runtime/_tests_/fixtures/wait";
import { cloudWorker, cloudWorkerBundle, startWorkerd } from "./fixtures/workerd";

let runtime: Miniflare;

const tokenA = "synthetic-workerd-credential-alpha-0001";

const tokenB = "synthetic-workerd-credential-bravo-0002";

const scope = fileScope();

beforeAll(async () => {
  runtime = await startWorkerd(
    cloudWorker(await cloudWorkerBundle(), {
      LOCAL_AUTH: JSON.stringify([
        { token: tokenA, workspace: "alpha" },
        { token: tokenB, workspace: "bravo" },
      ]),
      SANDBOX_URL: "http://127.0.0.1:1",
      SANDBOX_TOKEN: "synthetic-unused-provider-token",
      CONCURRENCY: "1",
    }),
  );
  onCleanup(() => runtime.dispose(), scope);
}, 60_000);

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

test("Worker derives workspace from credentials and rejects workspace/header/origin spoofing", async () => {
  expect((await api("/cursor", { token: "invalid" })).status).toBe(401);
  const status = await api(cloudRoutes.status.path, { headers: { [WORKSPACE_HEADER]: "bravo" } });
  expect(status.status).toBe(200);
  expect(decodeBoundary(cloudRoutes.status.response)(await status.json())).toMatchObject({
    workspace: "alpha",
  });
  expect((await api("/loopies?workspace=bravo")).status).toBe(403);
  expect((await api("/loopies", { headers: { Origin: "https://untrusted.invalid" } })).status).toBe(
    403,
  );
});

test("Worker rejects foreign run and save bodies and answers not_yet for cloud-unsupported routes", async () => {
  const foreign = await compiledBody("foreign", "/fixture.ts", { workspace: "other" });

  for (const [path, method, body] of [
    ["/loopies/foreign/runs", "POST", { input: {}, workspace: "other" }],
    ["/loopies/foreign", "PUT", foreign],
  ] as const) {
    const response = await api(path, { method, body });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  }

  for (const [path, method, body] of [
    ["/secrets", "GET", undefined],
    ["/secrets/token", "PUT", { value: "secret" }],
    ["/secrets/token", "DELETE", undefined],
    ["/types", "POST", { binary: "git", path: [], name: null }],
  ] as const) {
    const response = await api(path, { method, body });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: { code: "not_yet" } });
  }
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

  const status = await api(cloudRoutes.status.path);
  expect(decodeBoundary(cloudRoutes.status.response)(await status.json())).toMatchObject({
    errors: [],
    schedulerError: null,
  });
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
