import { afterEach, expect, test } from "bun:test";
import {
  definitionSummary,
  graphView,
  nodeIdSchema,
  routes,
  type SavedLoopy,
  type SourceArtifact,
} from "../src/contract/index.js";
import { revision } from "../src/core/index.js";
import {
  type ArtifactRegistry,
  apiRoutes,
  dispatch,
  eventStream,
  LoopyService,
  ServiceError,
} from "../src/service/index.js";
import { SqlRunStore } from "../src/store/portable.js";
import { BunSqlDriver } from "../src/store/sqlite/bun-driver.js";
import { compiledBody } from "./compiled-fixture.js";

const drivers: BunSqlDriver[] = [];

const aborters: AbortController[] = [];

const now = Date.parse("2026-10-22T00:00:00.000Z");

afterEach(() => {
  for (const aborter of aborters.splice(0)) {
    aborter.abort();
  }

  for (const driver of drivers.splice(0)) {
    driver.close();
  }
});

function unsupported(): never {
  throw new ServiceError("not_yet", "This operation is unavailable on this host.");
}

function fixture() {
  const driver = new BunSqlDriver(":memory:");
  drivers.push(driver);

  const store = new SqlRunStore(driver, {
    owner: { identity: { pid: 0, host: "cloud" }, isAlive: () => false },
    now: () => now,
  });

  const entries = new Map<string, SavedLoopy>();
  const graphs = new Map<string, SavedLoopy["graph"]>();
  const sources = new Map<string, SourceArtifact>();

  const registry: ArtifactRegistry = {
    workspace: async () => "cloud-workspace",
    listSummaries: async () => [...entries.values()].map(definitionSummary),
    summary: async (slug) => {
      const saved = entries.get(slug);

      return saved ? definitionSummary(saved) : null;
    },
    get: async (slug) => {
      const saved = entries.get(slug);

      if (!saved) {
        throw new ServiceError("not_found", `No saved loopy '${slug}'.`);
      }

      return saved;
    },
    revisionGraph: async (hash) => {
      const graph = graphs.get(hash);

      if (!graph) {
        throw new Error("Graph revision is missing.");
      }

      return graph;
    },
    revisionSource: async (slug, hash) =>
      sources.get(`${slug}:${hash}`) ?? {
        version: 1,
        status: "unavailable",
        revision: hash,
        reason: "not_captured",
      },
    save: async (body) => {
      const { graph } = body;
      entries.set(graph.name, {
        version: 2,
        slug: graph.name,
        graph,
        revision: body.revision,
        bundles: [],
        source: body.source.path,
        input: graph.input,
        ...graph.meta,
        savedAt: new Date(now).toISOString(),
      });
      graphs.set(body.revision, graph);

      if (body.sourceArtifact) {
        sources.set(`${graph.name}:${body.revision}`, body.sourceArtifact);
      }
    },
  };

  const service = new LoopyService({
    store,
    registry: () => registry,
    clock: { now: () => now },
    canonicalWorkspace: (workspace) => workspace,
    secrets: { list: unsupported, set: unsupported, remove: unsupported },
    generateTypes: async () => unsupported(),
  });

  return { store, service };
}

test("portable service validates input and pins graph/source revisions through async artifacts", async () => {
  const { service, store } = fixture();
  const first = await compiledBody("portable", "/virtual/portable.ts");
  first.graph.input = { name: "string" };
  first.revision = await revision(first.graph);
  first.sourceArtifact = {
    version: 1,
    status: "available",
    revision: first.revision,
    files: [{ id: "file-1", path: "portable.ts", content: "original source" }],
    ranges: [],
  };
  await service.putLoopy("portable", first);
  await expect(service.startRun("portable", {}, "cloud-workspace")).rejects.toMatchObject({
    code: "bad_request",
  });
  expect(await store.listRuns()).toEqual([]);
  const run = await service.startRun("portable", { name: "Hatim" }, "cloud-workspace");
  expect(await store.getRun(run.id)).toMatchObject({
    workspace: "cloud-workspace",
    revision: first.revision,
  });

  const second = structuredClone(first);
  second.graph.meta.description = "Updated definition";
  second.graph.input = {};
  second.revision = await revision(second.graph);
  second.sourceArtifact = {
    version: 1,
    status: "available",
    revision: second.revision,
    files: [{ id: "file-1", path: "portable.ts", content: "updated source" }],
    ranges: [],
  };
  await service.putLoopy("portable", second);
  expect(await service.graph("portable", "cloud-workspace")).toEqual({
    revision: second.revision,
    graph: graphView(second.graph),
  });
  expect(await service.runGraph(run.id)).toEqual({
    revision: first.revision,
    graph: graphView(first.graph),
  });
  expect(await service.runSource(run.id)).toEqual(first.sourceArtifact);
  expect(await service.loopySource("portable", "cloud-workspace")).toEqual(second.sourceArtifact);
  expect(await service.listLoopies("cloud-workspace")).toMatchObject([
    { slug: "portable", description: "Updated definition", counts: { queued: 1 } },
  ]);
});

test("portable schedules use registry workspace identity", async () => {
  const { service } = fixture();

  const body = await compiledBody("portable", "/virtual/portable.ts", {
    schedule: { cron: "0 * * * *", tz: "UTC" },
  });

  await service.putLoopy("portable", body);
  expect(await service.putSchedule("portable", {}, "alias")).toMatchObject({
    workspace: "cloud-workspace",
  });
  expect(await service.listSchedules("alias")).toHaveLength(1);
  expect(await service.setScheduleEnabled("portable", false, "alias")).toMatchObject({
    enabled: false,
  });
  await service.deleteSchedule("portable", "alias");
  expect(await service.listSchedules("alias")).toEqual([]);
});

test("portable routes use explicit daemon identity and return unsupported operation errors", async () => {
  const { service, store } = fixture();

  const table = apiRoutes({
    service,
    store,
    cwd: "cloud-workspace",
    daemon: { pid: 0, startedAt: new Date(now).toISOString(), concurrency: 4 },
  });

  const daemonRequest = new Request("https://loopy.example/api/daemon");
  const daemon = await dispatch(table, daemonRequest, new URL(daemonRequest.url));
  expect(routes.daemon.response.parse(await daemon.json())).toMatchObject({ pid: 0, running: 0 });

  for (const request of [
    new Request("https://loopy.example/api/secrets"),
    new Request("https://loopy.example/api/secrets/TOKEN", {
      method: "PUT",
      body: JSON.stringify({ value: "private" }),
    }),
    new Request("https://loopy.example/api/secrets/TOKEN", { method: "DELETE" }),
    new Request("https://loopy.example/api/types", {
      method: "POST",
      body: JSON.stringify({ binary: "tool", path: [], name: null }),
    }),
  ]) {
    const response = await dispatch(table, request, new URL(request.url));
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: { code: "not_yet" } });
  }
});

async function seededTransaction() {
  const f = fixture();
  const body = await compiledBody("portable", "/virtual/portable.ts");
  await f.service.putLoopy("portable", body);
  const run = await f.service.startRun("portable", {}, "cloud-workspace");
  await f.store.claim(run.id, "owner");
  const before = await f.store.eventCursor();
  await f.store.apply({
    runId: run.id,
    token: "owner",
    effects: ["first", "second"].map((nodeId) => ({
      kind: "write_node_run",
      nodeRun: {
        key: { runId: run.id, nodeId: nodeIdSchema.parse(nodeId), scope: [] },
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: new Date(now).toISOString(),
        receipt: "none",
      },
    })),
  });

  return { ...f, before };
}

test("portable SSE delivers whole SQL transactions and aborts without polling", async () => {
  const { service, store, before } = await seededTransaction();
  expect("dataVersion" in store).toBe(false);
  const aborter = new AbortController();
  aborters.push(aborter);

  const response = await eventStream(
    store,
    service,
    { after: before.cursor, epoch: before.epoch },
    aborter.signal,
  );

  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  const frame = new TextDecoder().decode((await reader.read()).value);
  const events = await store.events(before.cursor, 10);
  expect(frame).toContain(`id: ${events.at(-1)!.sequence}\nevent: txn\n`);

  const data = frame
    .split("\n")
    .find((line) => line.startsWith("data: "))!
    .slice(6);

  expect(
    routes.events.response
      .array()
      .parse(JSON.parse(data))
      .map((event) => event.sequence),
  ).toEqual(events.map((event) => event.sequence));
  const waiting = reader.read();
  aborter.abort();
  expect(await waiting).toEqual({ value: undefined, done: true });
});

test("portable SSE rejects partial transaction cursors, epoch changes and pruned history", async () => {
  const { store, service, before } = await seededTransaction();
  const [first] = await store.events(before.cursor, 10);
  const signal = new AbortController().signal;
  await expect(
    eventStream(store, service, { after: first!.sequence, epoch: before.epoch }, signal),
  ).rejects.toMatchObject({ code: "stale_cursor" });
  await expect(
    eventStream(store, service, { after: before.cursor, epoch: "other" }, signal),
  ).rejects.toMatchObject({ code: "stale_cursor" });
  await store.pruneEvents("2027-10-22T00:00:00.000Z");
  await expect(
    eventStream(store, service, { after: before.cursor, epoch: before.epoch }, signal),
  ).rejects.toMatchObject({ code: "stale_cursor" });
});
