import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { executionKeyString, type ScheduleView } from "@loopy/contract";
import { QueryClient } from "@tanstack/react-query";
import { Effect, Exit, Scope } from "effect";
import { startServer } from "../../../packages/runtime/src/local/server/start-server";
import { localHttpBackend } from "../src/backend/local-http";
import { graphModel } from "../src/lib/graph";
import { keys } from "../src/lib/keys";
import { toggleSchedule } from "../src/lib/mutations";
import { loopiesQuery } from "../src/lib/queries";
import { runMarks } from "../src/lib/run-marks";
import { applyScheduleView, removeScheduleView } from "../src/lib/stream/schedules";
import { reviewDataFixture } from "./review-data-fixture";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function fixture() {
  const scope = Scope.makeUnsafe();
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));

  const f = await Effect.runPromise(
    reviewDataFixture().pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const token = "isolated-review-test";

  const server = startServer({
    service: f.service,
    store: f.store,
    cwd: f.workspaceA,
    token,
    port: 0,
    assets: join(f.root, "assets"),
    daemon: { pid: process.pid, startedAt: new Date().toISOString(), concurrency: 1 },
  });

  cleanups.push(() => server.stop());

  return {
    ...f,
    baseUrl: new URL(server.url).origin,
    backend: localHttpBackend({ baseUrl: new URL(server.url).origin, token }),
  };
}

test("schedule HTTP and cache mutations keep default A and project B independent for the same slug", async () => {
  const { backend, service, workspaceA, workspaceB } = await fixture();
  const body = { cron: "@daily", tz: "UTC", input: { items: ["item"] }, enabled: true };
  const a = await Effect.runPromise(service.putSchedule("review-data", body, workspaceA));

  const b = await backend.call("putSchedule", {
    params: { slug: "review-data" },
    query: { workspace: workspaceB },
    body: { ...body, cron: "@hourly" },
  });

  expect(a.workspace).toBe(workspaceA);
  expect(b.workspace).toBe(workspaceB);
  expect(await backend.call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);
  expect(await backend.call("schedules", { query: { workspace: workspaceB } })).toEqual([b]);

  const client = new QueryClient();
  cleanups.push(() => client.clear());
  client.setQueryData(keys.schedules(workspaceA), [a]);
  client.setQueryData(keys.schedules(workspaceB), [b]);

  const edited = await backend.call("putSchedule", {
    params: { slug: "review-data" },
    query: { workspace: workspaceB },
    body: {
      cron: "@weekly",
      input: body.input,
    },
  });

  applyScheduleView(client, edited);

  const disabled = await toggleSchedule(
    client,
    {
      slug: "review-data",
      workspace: workspaceB,
      enabled: false,
    },
    () =>
      backend.call("setScheduleEnabled", {
        params: { slug: "review-data" },
        query: { workspace: workspaceB },
        body: { enabled: false },
      }),
  );

  applyScheduleView(client, disabled);
  expect(await backend.call("schedules", { query: { workspace: workspaceB } })).toEqual([disabled]);
  expect(disabled).toMatchObject({ cron: "@weekly", enabled: false, version: 3 });
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceB))).toEqual([disabled]);

  await backend.call("deleteSchedule", {
    params: { slug: "review-data" },
    query: { workspace: workspaceB },
  });
  removeScheduleView(client, { slug: "review-data", workspace: workspaceB });
  expect(await backend.call("schedules", { query: { workspace: workspaceB } })).toEqual([]);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceB))).toEqual([]);
  expect(await backend.call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
});

test("201 root and 51 item executions remain unknown outside bounded pages and reconcile on selection", async () => {
  const { backend, runId, itemScope, records } = await fixture();
  const snapshot = await backend.call("run", { params: { id: runId } }, AbortSignal.timeout(1000));
  const graph = (await backend.call("runGraph", { params: { id: runId } })).graph;

  const itemPage = await backend.call("executions", {
    params: { id: runId },
    query: { scope: JSON.stringify(itemScope), limit: 50 },
  });

  expect(records.filter((record) => record.key.scope.length === 0)).toHaveLength(201);
  expect(records.filter((record) => record.key.scope.length > 0)).toHaveLength(51);
  expect(snapshot.nodeRuns).toHaveLength(200);
  expect(snapshot.nodeRunsNext).not.toBeNull();
  expect(itemPage.items).toHaveLength(50);
  expect(itemPage.next).not.toBeNull();

  const nodeRuns = [...snapshot.nodeRuns, ...itemPage.items];
  const loaded = new Set(nodeRuns.map((node) => executionKeyString(node.key)));
  const missing = records.filter((node) => !loaded.has(executionKeyString(node.key)));
  expect(missing).toHaveLength(2);

  const coverage = [
    { scope: [], complete: false },
    { scope: itemScope, complete: false },
  ];

  const model = graphModel(graph, { status: snapshot.run.status, nodeRuns, coverage });

  const marks = runMarks({
    model,
    itemOpen: true,
    scopes: [],
    now: Date.now(),
  });

  expect(model.historyIncomplete).toBe(true);

  for (const record of missing) {
    expect(model.nodes.find((node) => node.id === record.key.nodeId)?.state).toEqual({
      kind: "idle",
      reason: "not_loaded",
    });
    expect(marks.get(record.key.nodeId)).toMatchObject({
      status: null,
      skipped: false,
      note: "not loaded",
    });

    const detail = await backend.call("execution", {
      params: { id: runId },
      query: { key: executionKeyString(record.key) },
    });

    const selected = graphModel(graph, {
      status: snapshot.run.status,
      nodeRuns,
      coverage,
      selectedExecutions: [detail.node],
    });

    const selectedNode = selected.nodes.find((node) => node.id === record.key.nodeId);
    expect(selectedNode?.state).toMatchObject({ kind: "ran", status: "succeeded" });
    expect(selectedNode?.executions).toEqual([detail.node]);
    expect(selected.nodes.flatMap((node) => node.executions)).toHaveLength(251);
    expect(
      runMarks({
        model: selected,
        itemOpen: true,
        scopes: [],
        now: Date.now(),
      }).get(record.key.nodeId),
    ).toMatchObject({ status: "succeeded", skipped: false });
  }

  const nextItemPage = await backend.call("executions", {
    params: { id: runId },
    query: {
      scope: JSON.stringify(itemScope),
      limit: 50,
      after: itemPage.next ?? undefined,
    },
  });

  expect(nextItemPage.items).toHaveLength(1);
  expect(nextItemPage.next).toBeNull();

  const finalPageOnly = graphModel(graph, {
    status: snapshot.run.status,
    nodeRuns: nextItemPage.items,
    coverage: [{ scope: itemScope, complete: false }],
  });

  expect(
    finalPageOnly.nodes.find((node) => node.id === itemPage.items[0]?.key.nodeId)?.state,
  ).toEqual({
    kind: "idle",
    reason: "not_loaded",
  });

  const logged = records[0];

  if (!logged) {
    throw new Error("Fixture requires a logged execution.");
  }

  const logsQuery = { runId, executionKey: executionKeyString(logged.key), limit: 50 };
  const firstLogs = await backend.call("globalLogs", { query: logsQuery });

  const olderLogs = await backend.call("globalLogs", {
    query: { ...logsQuery, before: firstLogs.next ?? undefined },
  });

  expect(firstLogs.items).toHaveLength(50);
  expect(firstLogs.hasMore).toBe(true);
  expect(olderLogs.items).toHaveLength(25);
  expect(olderLogs.hasMore).toBe(false);
  expect(new Set([...firstLogs.items, ...olderLogs.items].map((log) => log.id)).size).toBe(75);

  const search = await backend.call("globalLogs", {
    query: { runId, text: "DIAGNOSTIC_END", limit: 50 },
  });

  const preview = search.items[0];

  if (!preview) {
    throw new Error("Fixture requires a search hit beyond its message preview.");
  }

  expect(preview.message).toHaveLength(1024);
  expect(preview.dataBytes).toBe(0);

  const detail = await backend.call("log", { params: { id: preview.id } });

  expect(detail.log.message).toEndWith("DIAGNOSTIC_END");
  expect(detail.log).not.toHaveProperty("data");
});

test("fresh HTTP schedule overview and loopy rows list B beside default A's same slug", async () => {
  const { backend, baseUrl, service, store, workspaceA, workspaceB } = await fixture();
  const body = { cron: "@daily", tz: "UTC", input: { items: ["item"] }, enabled: true };

  const b = await backend.call("putSchedule", {
    params: { slug: "review-data" },
    query: { workspace: workspaceB },
    body: body,
  });

  expect((await fetch(`${baseUrl}/api/schedules/overview`)).status).toBe(401);
  expect((await backend.call("loopies", {})).map((row) => row.workspace).sort()).toEqual(
    [workspaceA, workspaceB].sort(),
  );
  expect(await backend.call("schedules", { query: { workspace: workspaceA } })).toEqual([]);
  const overview = await backend.call("scheduleOverview", {});
  expect(overview).toEqual({
    workspaces: [workspaceB],
    active: 1,
    next: [
      { workspace: workspaceB, slug: b.slug, cron: b.cron, tz: b.tz, nextFireAt: b.nextFireAt },
    ],
  });

  const discovered = await Promise.all(
    overview.workspaces.map((workspace) =>
      backend.call("schedules", { query: { workspace: workspace } }),
    ),
  );

  expect(discovered.flat()).toEqual([b]);

  const a = await Effect.runPromise(
    service.putSchedule("review-data", { ...body, enabled: false }, workspaceA),
  );

  const client = new QueryClient();
  cleanups.push(() => client.clear());
  client.setQueryData(keys.schedules(workspaceA), [a]);
  client.setQueryData(keys.schedules(workspaceB), [b]);
  await client.fetchQuery(loopiesQuery(backend, workspaceB));
  client.setQueryData(keys.scheduleOverview, await backend.call("scheduleOverview", {}));

  const edited = await backend.call("putSchedule", {
    params: { slug: "review-data" },
    query: { workspace: workspaceB },
    body: { ...body, cron: "@hourly" },
  });

  applyScheduleView(client, edited);
  expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.workspaceLoopies(workspaceB))?.isInvalidated).toBe(true);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  expect((await backend.call("scheduleOverview", {})).next[0]?.cron).toBe("@hourly");

  client.setQueryData(keys.scheduleOverview, await backend.call("scheduleOverview", {}));

  const toggled = await toggleSchedule(
    client,
    {
      slug: b.slug,
      workspace: workspaceB,
      enabled: false,
    },
    () =>
      backend.call("setScheduleEnabled", {
        params: { slug: b.slug },
        query: { workspace: workspaceB },
        body: { enabled: false },
      }),
  );

  applyScheduleView(client, toggled);
  expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.workspaceLoopies(workspaceB))?.isInvalidated).toBe(true);
  expect(await backend.call("scheduleOverview", {})).toEqual({
    workspaces: [workspaceA, workspaceB],
    active: 0,
    next: [],
  });
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  expect(await backend.call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);

  client.setQueryData(keys.scheduleOverview, await backend.call("scheduleOverview", {}));
  await backend.call("deleteSchedule", {
    params: { slug: b.slug },
    query: { workspace: workspaceB },
  });
  removeScheduleView(client, { slug: b.slug, workspace: workspaceB });
  expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.workspaceLoopies(workspaceB))?.isInvalidated).toBe(true);
  expect(await backend.call("scheduleOverview", {})).toEqual({
    workspaces: [workspaceA],
    active: 0,
    next: [],
  });
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  expect(await backend.call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);

  const definitions = await client.fetchQuery(loopiesQuery(backend, workspaceB));

  const unscheduled = definitions.filter(
    (row) => row.workspace === workspaceB && row.schedule === null,
  );

  expect(unscheduled.map((row) => row.slug)).toEqual(["review-data"]);
  const definition = unscheduled[0]!;

  const recreated = await backend.call("putSchedule", {
    params: { slug: definition.slug },
    query: { workspace: definition.workspace },
    body: body,
  });

  expect(recreated.workspace).toBe(workspaceB);
  expect(await backend.call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  await backend.call("deleteSchedule", {
    params: { slug: recreated.slug },
    query: { workspace: workspaceB },
  });

  for (let index = 0; index < 12; index++) {
    await Effect.runPromise(
      store.putSchedule({
        workspace: workspaceB,
        cron: b.cron,
        tz: b.tz,
        input: body.input,
        enabled: true,
        slug: `bounded-${index}`,
        nextFireAt: `2030-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
  }

  const bounded = await backend.call("scheduleOverview", {});
  expect(bounded.active).toBe(12);
  expect(bounded.next).toHaveLength(10);
  expect(bounded.next.map((row) => row.slug)).toEqual(
    [...Array(10).keys()].map((index) => `bounded-${index}`),
  );
  expect(JSON.stringify(bounded)).not.toContain('"input"');
});
