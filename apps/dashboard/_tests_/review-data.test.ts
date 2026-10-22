import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { executionKeyString, type ScheduleView } from "loopy/contract";
import { startServer } from "../../../packages/loopy/src/local/server/start-server.ts";
import { localHttpBackend } from "../src/backend/local-http.ts";
import { graphModel } from "../src/lib/graph.ts";
import { keys } from "../src/lib/keys.ts";
import { toggleSchedule } from "../src/lib/mutations.ts";
import { workspaceLoopiesQuery } from "../src/lib/queries.ts";
import { runMarks } from "../src/lib/run-marks.ts";
import { applyScheduleView, removeScheduleView } from "../src/lib/stream.ts";
import { reviewDataFixture } from "./review-data-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function fixture() {
  const f = await reviewDataFixture();
  cleanups.push(() => {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const token = "isolated-review-test";

  const server = startServer({
    service: f.service,
    store: f.store,
    cwd: f.workspaceA,
    token,
    port: 0,
    assets: join(f.root, "assets"),
    daemon: { startedAt: new Date().toISOString(), concurrency: 1 },
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
  const a = await service.putSchedule("review-data", body);
  const b = await backend.putSchedule("review-data", workspaceB, { ...body, cron: "@hourly" });
  expect(a.workspace).toBe(workspaceA);
  expect(b.workspace).toBe(workspaceB);
  expect(await backend.schedules(workspaceA)).toEqual([a]);
  expect(await backend.schedules(workspaceB)).toEqual([b]);

  const client = new QueryClient();
  cleanups.push(() => client.clear());
  client.setQueryData(keys.schedules(workspaceA), [a]);
  client.setQueryData(keys.schedules(workspaceB), [b]);

  const edited = await backend.putSchedule("review-data", workspaceB, {
    cron: "@weekly",
    input: body.input,
  });

  applyScheduleView(client, edited);

  const disabled = await toggleSchedule(client, backend, {
    slug: "review-data",
    workspace: workspaceB,
    enabled: false,
  });

  applyScheduleView(client, disabled);
  expect(await backend.schedules(workspaceB)).toEqual([disabled]);
  expect(disabled).toMatchObject({ cron: "@weekly", enabled: false, version: 3 });
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceB))).toEqual([disabled]);

  await backend.deleteSchedule("review-data", workspaceB);
  removeScheduleView(client, { slug: "review-data", workspace: workspaceB });
  expect(await backend.schedules(workspaceB)).toEqual([]);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceB))).toEqual([]);
  expect(await backend.schedules(workspaceA)).toEqual([a]);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
});

test("201 root and 51 item executions remain unknown outside bounded pages and reconcile on selection", async () => {
  const { backend, runId, itemScope, records } = await fixture();
  const snapshot = await backend.run(runId, AbortSignal.timeout(1000));
  const graph = (await backend.runGraph(runId)).graph;
  const itemPage = await backend.executions(runId, { scope: JSON.stringify(itemScope), limit: 50 });
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
    perItem: new Set(),
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
    const detail = await backend.execution(runId, { key: executionKeyString(record.key) });

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
        perItem: new Set(),
        itemOpen: true,
        scopes: [],
        now: Date.now(),
      }).get(record.key.nodeId),
    ).toMatchObject({ status: "succeeded", skipped: false });
  }

  const nextItemPage = await backend.executions(runId, {
    scope: JSON.stringify(itemScope),
    limit: 50,
    after: itemPage.next ?? undefined,
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
  const firstLogs = await backend.globalLogs(logsQuery);
  const olderLogs = await backend.globalLogs({ ...logsQuery, before: firstLogs.next ?? undefined });

  expect(firstLogs.items).toHaveLength(50);
  expect(firstLogs.hasMore).toBe(true);
  expect(olderLogs.items).toHaveLength(25);
  expect(olderLogs.hasMore).toBe(false);
  expect(new Set([...firstLogs.items, ...olderLogs.items].map((log) => log.id)).size).toBe(75);

  const search = await backend.globalLogs({ runId, text: "DIAGNOSTIC_END", limit: 50 });
  const preview = search.items[0];

  if (!preview) {
    throw new Error("Fixture requires a search hit beyond its message preview.");
  }

  expect(preview.message).toHaveLength(1024);
  expect(preview.dataBytes).toBe(0);

  const detail = await backend.log(preview.id);

  expect(detail.log.message).toEndWith("DIAGNOSTIC_END");
  expect(detail.log).not.toHaveProperty("data");
});

test("fresh HTTP schedule overview discovers enabled B hidden by default A's same slug", async () => {
  const { backend, baseUrl, service, store, workspaceA, workspaceB } = await fixture();
  const body = { cron: "@daily", tz: "UTC", input: { items: ["item"] }, enabled: true };
  const b = await backend.putSchedule("review-data", workspaceB, body);
  expect((await fetch(`${baseUrl}/api/schedules/overview`)).status).toBe(401);
  expect((await backend.loopies()).map((row) => row.workspace)).toEqual([workspaceA]);
  expect(await backend.schedules(workspaceA)).toEqual([]);
  const overview = await backend.scheduleOverview();
  expect(overview).toEqual({
    workspaces: [workspaceB],
    active: 1,
    next: [
      { workspace: workspaceB, slug: b.slug, cron: b.cron, tz: b.tz, nextFireAt: b.nextFireAt },
    ],
  });

  expect((await backend.loopies(workspaceB)).map((row) => row.workspace)).toEqual([workspaceB]);

  const discovered = await Promise.all(
    overview.workspaces.map((workspace) => backend.schedules(workspace)),
  );

  expect(discovered.flat()).toEqual([b]);

  const a = await service.putSchedule("review-data", { ...body, enabled: false });
  const client = new QueryClient();
  cleanups.push(() => client.clear());
  client.setQueryData(keys.schedules(workspaceA), [a]);
  client.setQueryData(keys.schedules(workspaceB), [b]);
  await client.fetchQuery(workspaceLoopiesQuery(backend, workspaceB));
  client.setQueryData(keys.scheduleOverview, await backend.scheduleOverview());
  const edited = await backend.putSchedule("review-data", workspaceB, { ...body, cron: "@hourly" });
  applyScheduleView(client, edited);
  expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.workspaceLoopies(workspaceB))?.isInvalidated).toBe(true);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  expect((await backend.scheduleOverview()).next[0]?.cron).toBe("@hourly");

  client.setQueryData(keys.scheduleOverview, await backend.scheduleOverview());

  const toggled = await toggleSchedule(client, backend, {
    slug: b.slug,
    workspace: workspaceB,
    enabled: false,
  });

  applyScheduleView(client, toggled);
  expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.workspaceLoopies(workspaceB))?.isInvalidated).toBe(true);
  expect(await backend.scheduleOverview()).toEqual({
    workspaces: [workspaceA, workspaceB],
    active: 0,
    next: [],
  });
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  expect(await backend.schedules(workspaceA)).toEqual([a]);

  client.setQueryData(keys.scheduleOverview, await backend.scheduleOverview());
  await backend.deleteSchedule(b.slug, workspaceB);
  removeScheduleView(client, { slug: b.slug, workspace: workspaceB });
  expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.workspaceLoopies(workspaceB))?.isInvalidated).toBe(true);
  expect(await backend.scheduleOverview()).toEqual({
    workspaces: [workspaceA],
    active: 0,
    next: [],
  });
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  expect(await backend.schedules(workspaceA)).toEqual([a]);

  const definitions = await client.fetchQuery(workspaceLoopiesQuery(backend, workspaceB));

  const unscheduled = definitions.filter(
    (row) => row.workspace === workspaceB && row.schedule === null,
  );

  expect(unscheduled.map((row) => row.slug)).toEqual(["review-data"]);
  const definition = unscheduled[0]!;
  const recreated = await backend.putSchedule(definition.slug, definition.workspace, body);
  expect(recreated.workspace).toBe(workspaceB);
  expect(await backend.schedules(workspaceA)).toEqual([a]);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  await backend.deleteSchedule(recreated.slug, workspaceB);

  for (let index = 0; index < 12; index++) {
    await store.putSchedule({
      workspace: workspaceB,
      cron: b.cron,
      tz: b.tz,
      input: body.input,
      enabled: true,
      slug: `bounded-${index}`,
      nextFireAt: `2030-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }

  const bounded = await backend.scheduleOverview();
  expect(bounded.active).toBe(12);
  expect(bounded.next).toHaveLength(10);
  expect(bounded.next.map((row) => row.slug)).toEqual(
    [...Array(10).keys()].map((index) => `bounded-${index}`),
  );
  expect(JSON.stringify(bounded)).not.toContain('"input"');
});
