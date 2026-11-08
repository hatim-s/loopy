import { expect, test } from "bun:test";
import { join } from "node:path";
import { executionKeyString, type ScheduleView } from "@loopy/contract";
import { QueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { onCleanup, runScoped } from "../../../packages/runtime/_tests_/fixtures/test-scope";
import { startServer } from "../../../packages/runtime/src/local/server/start-server";
import { localHttpBackend } from "../src/backend/local-http";
import { graphModel } from "../src/lib/graph";
import { keys } from "../src/lib/keys";
import { toggleSchedule } from "../src/lib/mutations";
import { loopiesQuery } from "../src/lib/queries";
import { runMarks } from "../src/lib/run-marks";
import { applyScheduleView, removeScheduleView } from "../src/lib/stream/schedules";
import { reviewDataFixture } from "./review-data-fixture";

async function fixture() {
  const f = await runScoped(reviewDataFixture());

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

  onCleanup(() => server.stop());

  return {
    ...f,
    baseUrl: new URL(server.url).origin,
    backend: localHttpBackend({ baseUrl: new URL(server.url).origin, token }),
  };
}

test("schedule cache mutations keep default A and project B independent for the same slug", async () => {
  const { backend, service, workspaceA, workspaceB } = await fixture();
  const body = { cron: "@daily", tz: "UTC", input: { items: ["item"] }, enabled: true };
  const a = await Effect.runPromise(service.putSchedule("review-data", body, workspaceA));
  const inB = { params: { slug: "review-data" }, query: { workspace: workspaceB } };
  const b = await backend.call("putSchedule", { ...inB, body: { ...body, cron: "@hourly" } });

  const client = new QueryClient();
  onCleanup(() => client.clear());
  client.setQueryData(keys.schedules(workspaceA), [a]);
  client.setQueryData(keys.schedules(workspaceB), [b]);
  applyScheduleView(
    client,
    await backend.call("putSchedule", { ...inB, body: { cron: "@weekly", input: body.input } }),
  );

  const disabled = await toggleSchedule(
    client,
    { slug: "review-data", workspace: workspaceB, enabled: false },
    () => backend.call("setScheduleEnabled", { ...inB, body: { enabled: false } }),
  );

  applyScheduleView(client, disabled);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceB))).toEqual([disabled]);

  await backend.call("deleteSchedule", inB);
  removeScheduleView(client, { slug: "review-data", workspace: workspaceB });
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceB))).toEqual([]);
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

test("schedule edits in project B invalidate the overview and B's loopies but keep A's cached schedule", async () => {
  const { backend, service, workspaceA, workspaceB } = await fixture();
  const body = { cron: "@daily", tz: "UTC", input: { items: ["item"] }, enabled: true };
  const inB = { params: { slug: "review-data" }, query: { workspace: workspaceB } };
  const b = await backend.call("putSchedule", { ...inB, body });

  const a = await Effect.runPromise(
    service.putSchedule("review-data", { ...body, enabled: false }, workspaceA),
  );

  const client = new QueryClient();
  onCleanup(() => client.clear());
  client.setQueryData(keys.schedules(workspaceA), [a]);
  client.setQueryData(keys.schedules(workspaceB), [b]);
  await client.fetchQuery(loopiesQuery(backend, workspaceB));

  const expectBInvalidated = () => {
    expect(client.getQueryState(keys.scheduleOverview)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.workspaceLoopies(workspaceB))?.isInvalidated).toBe(true);
    expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
  };

  client.setQueryData(keys.scheduleOverview, await backend.call("scheduleOverview", {}));
  applyScheduleView(
    client,
    await backend.call("putSchedule", { ...inB, body: { ...body, cron: "@hourly" } }),
  );
  expectBInvalidated();

  client.setQueryData(keys.scheduleOverview, await backend.call("scheduleOverview", {}));

  const toggled = await toggleSchedule(
    client,
    { slug: b.slug, workspace: workspaceB, enabled: false },
    () => backend.call("setScheduleEnabled", { ...inB, body: { enabled: false } }),
  );

  applyScheduleView(client, toggled);
  expectBInvalidated();

  client.setQueryData(keys.scheduleOverview, await backend.call("scheduleOverview", {}));
  await backend.call("deleteSchedule", inB);
  removeScheduleView(client, { slug: b.slug, workspace: workspaceB });
  expectBInvalidated();

  const definitions = await client.fetchQuery(loopiesQuery(backend, workspaceB));

  const unscheduled = definitions.filter(
    (row) => row.workspace === workspaceB && row.schedule === null,
  );

  expect(unscheduled.map((row) => row.slug)).toEqual(["review-data"]);
  const definition = unscheduled[0]!;

  const recreated = await backend.call("putSchedule", {
    params: { slug: definition.slug },
    query: { workspace: definition.workspace },
    body,
  });

  expect(recreated.workspace).toBe(workspaceB);
  expect(client.getQueryData<ScheduleView[]>(keys.schedules(workspaceA))).toEqual([a]);
});
