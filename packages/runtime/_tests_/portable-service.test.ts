import { expect, test } from "bun:test";
import {
  CLOUD_MAX_REQUEST_BYTES,
  canResumeRun,
  decodeBoundary,
  definitionSummary,
  graphView,
  nodeIdSchema,
  routes,
  type SavedLoopy,
  type SourceArtifact,
} from "@loopy/contract";
import { Effect, Schema } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import {
  type ArtifactRegistry,
  apiRoutes,
  dispatch,
  eventStream,
  makeService,
  RegistryError,
  ServiceError,
} from "../src/service";
import { BunSqlDriver } from "../src/store/bun-driver";
import { SqlRunStore } from "../src/store/portable";
import { runAt } from "./fixtures/clock";
import { compiledBody } from "./fixtures/compiled";
import { onCleanup } from "./fixtures/test-scope";

const now = Date.parse("2026-10-22T00:00:00.000Z");

function unsupported() {
  return Effect.fail(new ServiceError("not_yet", "This operation is unavailable on this host."));
}

function fixture(isAlive = () => false) {
  const driver = new BunSqlDriver(":memory:");
  onCleanup(() => driver.close());

  const store = new SqlRunStore(driver, {
    owner: { identity: { pid: 0, host: "cloud" }, isAlive },
  });

  const entries = new Map<string, SavedLoopy>();
  const graphs = new Map<string, SavedLoopy["graph"]>();
  const sources = new Map<string, SourceArtifact>();

  const registry: ArtifactRegistry = {
    workspace: () => Effect.succeed("cloud-workspace"),
    listSummaries: () => Effect.sync(() => [...entries.values()].map(definitionSummary)),
    get: (slug) => Effect.sync(() => entries.get(slug) ?? null),
    revisionGraph: (hash) =>
      Effect.suspend(() => {
        const graph = graphs.get(hash);

        if (!graph) {
          return Effect.fail(
            new RegistryError({ operation: "read graph", cause: "Graph revision is missing." }),
          );
        }

        return Effect.succeed(graph);
      }),
    revisionSource: (slug, hash) =>
      Effect.sync(
        () =>
          sources.get(`${slug}:${hash}`) ?? {
            version: 1,
            status: "unavailable",
            revision: hash,
            reason: "not_captured",
          },
      ),
    save: (body) =>
      Effect.sync(() => {
        const { graph } = body;
        entries.set(graph.name, {
          version: 3,
          slug: graph.name,
          graph,
          revision: body.revision,
          bundles: [],
          source: body.source.path,
          savedAt: new Date(now).toISOString(),
        });
        graphs.set(body.revision, graph);

        if (body.sourceArtifact) {
          sources.set(`${graph.name}:${body.revision}`, body.sourceArtifact);
        }
      }),
  };

  const service = makeService({
    store,
    registry: () => Effect.succeed(registry),
    canonicalWorkspace: (workspace) => Effect.succeed(workspace),
    secrets: { list: unsupported, set: unsupported, remove: unsupported },
    generateTypes: unsupported,
  });

  return { store, service };
}

test("portable service validates input and pins graph/source revisions through async artifacts", async () => {
  const { service, store } = fixture();

  const first = await compiledBody("portable", "/virtual/portable.ts", {
    input: { name: "string" },
  });

  first.sourceArtifact = {
    version: 1,
    status: "available",
    revision: first.revision,
    files: [{ id: "file-1", path: "portable.ts", content: "original source" }],
    ranges: [],
  };
  await Effect.runPromise(service.putLoopy("portable", first));
  await expect(
    Effect.runPromise(service.startRun("portable", {}, "cloud-workspace")),
  ).rejects.toMatchObject({
    code: "bad_request",
  });
  expect(
    await Effect.runPromise(store.queryRuns({ limit: 200, now: new Date(now).toISOString() })),
  ).toEqual([]);

  const run = await Effect.runPromise(
    service.startRun("portable", { name: "Hatim" }, "cloud-workspace"),
  );

  expect(await Effect.runPromise(store.getRun(run.id))).toMatchObject({
    workspace: "cloud-workspace",
    revision: first.revision,
  });

  const second = await compiledBody("portable", "/virtual/portable.ts", {
    description: "Updated definition",
  });

  second.sourceArtifact = {
    version: 1,
    status: "available",
    revision: second.revision,
    files: [{ id: "file-1", path: "portable.ts", content: "updated source" }],
    ranges: [],
  };
  await Effect.runPromise(service.putLoopy("portable", second));
  expect(await Effect.runPromise(service.graph("portable", "cloud-workspace"))).toEqual({
    revision: second.revision,
    graph: graphView(second.graph),
  });
  expect(await Effect.runPromise(service.runGraph(run.id))).toEqual({
    revision: first.revision,
    graph: graphView(first.graph),
  });
  expect(await Effect.runPromise(service.runSource(run.id))).toEqual(first.sourceArtifact);
  expect(await Effect.runPromise(service.loopySource("portable", "cloud-workspace"))).toEqual(
    second.sourceArtifact,
  );
  expect(await Effect.runPromise(service.listLoopies("cloud-workspace"))).toMatchObject([
    { slug: "portable", description: "Updated definition", counts: { queued: 1 } },
  ]);
});

test("portable schedules use registry workspace identity", async () => {
  const { service } = fixture();

  const body = await compiledBody("portable", "/virtual/portable.ts", {
    schedule: { cron: "0 * * * *", tz: "UTC" },
  });

  await Effect.runPromise(service.putLoopy("portable", body));
  expect(await Effect.runPromise(service.putSchedule("portable", {}, "alias"))).toMatchObject({
    workspace: "cloud-workspace",
  });
  expect(await Effect.runPromise(service.listSchedules("alias"))).toHaveLength(1);
  expect(
    await Effect.runPromise(service.setScheduleEnabled("portable", false, "alias")),
  ).toMatchObject({
    enabled: false,
  });
  await Effect.runPromise(service.deleteSchedule("portable", "alias"));
  expect(await Effect.runPromise(service.listSchedules("alias"))).toEqual([]);
});

test("portable routes use explicit daemon identity", async () => {
  const { service, store } = fixture();

  const table = apiRoutes({
    service,
    store,
    cwd: "cloud-workspace",
    daemon: { pid: 0, startedAt: new Date(now).toISOString(), concurrency: 4 },
    maxBodyBytes: CLOUD_MAX_REQUEST_BYTES,
  });

  const daemonRequest = new Request("https://loopy.example/api/daemon");
  const daemon = await dispatch(table, daemonRequest, new URL(daemonRequest.url));
  expect(decodeBoundary(routes.daemon.response)(await daemon.json())).toMatchObject({
    pid: 0,
    running: 0,
  });

  for (const [method, suffix, body] of [
    ["POST", "runs", { input: {} }],
    ["GET", "graph", undefined],
    ["GET", "source", undefined],
    ["PUT", "schedule", { cron: "* * * * *" }],
    ["POST", "schedule/enabled", { enabled: true }],
    ["DELETE", "schedule", undefined],
  ] as const) {
    const request = new Request(`https://loopy.example/api/loopies/absent/${suffix}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const response = await dispatch(table, request, new URL(request.url));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "No saved loopy 'absent'. Use loopy save <file.ts> first.",
      },
    });
  }

  expect(
    await Effect.runPromise(store.queryRuns({ limit: 200, now: new Date(now).toISOString() })),
  ).toEqual([]);
  expect(await Effect.runPromise(store.listSchedules())).toEqual([]);
});

test("run views call an owner stale only when the store would let a resume claim the run", async () => {
  for (const alive of [true, false]) {
    const { service, store } = fixture(() => alive);
    let clock = now;
    const at = runAt(() => clock);
    await at(store.createRun({ ...newRun(), id: "owned" }));
    await at(store.claim("owned", "first"));
    clock += store.leaseMs + 1;
    const view = (await at(service.runSnapshot("owned"))).run;

    expect(view.ownerStale).toBe(!alive);
    expect(canResumeRun(view)).toBe(!alive);
    expect((await at(Effect.exit(store.claim("owned", "second"))))._tag).toBe(
      alive ? "Failure" : "Success",
    );
  }
});

async function seededTransaction() {
  const f = fixture();
  const body = await compiledBody("portable", "/virtual/portable.ts");
  await Effect.runPromise(f.service.putLoopy("portable", body));
  const run = await Effect.runPromise(f.service.startRun("portable", {}, "cloud-workspace"));
  await Effect.runPromise(f.store.claim(run.id, "owner"));
  const before = await Effect.runPromise(f.store.eventCursor());
  await Effect.runPromise(
    f.store.apply({
      runId: run.id,
      token: "owner",
      effects: ["first", "second"].map((nodeId) => ({
        kind: "write_node_run",
        nodeRun: {
          key: { runId: run.id, nodeId: decodeBoundary(nodeIdSchema)(nodeId), scope: [] },
          status: "running",
          attempt: 1,
          maxAttempts: 1,
          startedAt: new Date(now).toISOString(),
          receipt: "none",
        },
      })),
    }),
  );

  return { ...f, before };
}

test("portable SSE delivers whole SQL transactions and aborts without polling", async () => {
  const { service, store, before } = await seededTransaction();
  const aborter = new AbortController();
  onCleanup(() => aborter.abort());

  const response = await Effect.runPromise(
    eventStream(store, service, { after: before.cursor, epoch: before.epoch }, aborter.signal),
  );

  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  const frame = new TextDecoder().decode((await reader.read()).value);
  const events = await Effect.runPromise(store.events(before.cursor, 10));
  expect(frame).toContain(`id: ${events.at(-1)!.sequence}\nevent: txn\n`);

  const data = frame
    .split("\n")
    .find((line) => line.startsWith("data: "))!
    .slice(6);

  expect(
    decodeBoundary(Schema.Array(routes.events.response))(JSON.parse(data)).map(
      (event) => event.sequence,
    ),
  ).toEqual(events.map((event) => event.sequence));
  const waiting = reader.read();
  aborter.abort();
  expect(await waiting).toEqual({ value: undefined, done: true });
});

test("portable SSE rejects partial transaction cursors, epoch changes and pruned history", async () => {
  const { store, service, before } = await seededTransaction();
  const [first] = await Effect.runPromise(store.events(before.cursor, 10));
  const signal = new AbortController().signal;
  await expect(
    Effect.runPromise(
      eventStream(store, service, { after: first!.sequence, epoch: before.epoch }, signal),
    ),
  ).rejects.toMatchObject({ code: "stale_cursor" });
  await expect(
    Effect.runPromise(
      eventStream(store, service, { after: before.cursor, epoch: "other" }, signal),
    ),
  ).rejects.toMatchObject({ code: "stale_cursor" });
  await Effect.runPromise(store.pruneEvents("2027-10-22T00:00:00.000Z"));
  await expect(
    Effect.runPromise(
      eventStream(store, service, { after: before.cursor, epoch: before.epoch }, signal),
    ),
  ).rejects.toMatchObject({ code: "stale_cursor" });
});

test("portable routes refuse a request body over their limit before parsing it", async () => {
  const { service, store } = fixture();

  const table = apiRoutes({
    service,
    store,
    cwd: "cloud-workspace",
    daemon: { pid: 0, startedAt: new Date(now).toISOString(), concurrency: 4 },
    maxBodyBytes: 64,
  });

  const request = new Request("https://loopy.example/api/loopies/absent/schedule", {
    method: "PUT",
    body: JSON.stringify({ cron: "* * * * *", input: { padding: "x".repeat(100) } }),
  });

  const response = await dispatch(table, request, new URL(request.url));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { code: "bad_request", message: "Body exceeds its 64 byte limit. Send a smaller body." },
  });
});
