import { expect, test } from "bun:test";
import { join } from "node:path";
import { decodeBoundary, nodeIdSchema, routes } from "@loopy/contract";
import { localDaemon, makeLocalService } from "@loopy/runtime/local";
import { Effect, Scope } from "effect";
import { newRun } from "../../../packages/core/_tests_/fixtures/run";
import { fixture, runFixture, save } from "../../../packages/runtime/_tests_/fixtures/project";
import { fixtureStore } from "../../../packages/runtime/_tests_/fixtures/service-runtime";
import { fixtureScope } from "../../../packages/runtime/_tests_/fixtures/test-scope";
import { applyToSnapshot } from "../src/lib/stream/snapshot";

test("the cache retains the server's streamed output preview size", async () => {
  const f = fixture("stream-preview", "run: () => null");
  const store = await fixtureStore(f.home);

  const service = makeLocalService({
    store,
    home: f.home,
  });

  try {
    await Effect.runPromise(store.createRun(newRun()));
    await Effect.runPromise(store.claim("run", "owner"));
    await Effect.runPromise(
      store.apply({
        runId: "run",
        token: "owner",
        effects: [
          {
            kind: "write_node_run",
            nodeRun: {
              key: { runId: "run", nodeId: decodeBoundary(nodeIdSchema)("code"), scope: [] },
              attempt: 1,
              maxAttempts: 1,
              startedAt: newRun().createdAt,
              endedAt: newRun().createdAt,
              status: "succeeded",
              receipt: "finished",
              output: "x".repeat(20000),
            },
          },
        ],
      }),
    );

    const event = (
      await Effect.runPromise(service.events(await Effect.runPromise(store.events(0, 20))))
    ).find((value) => value.entity === "node");

    if (!event || event.record.status !== "succeeded") {
      throw new Error("Expected a successful node event.");
    }

    const wire = decodeBoundary(routes.events.response)(event);
    expect(event.record.output).toBeNull();
    expect(event.truncatedOutputBytes).toBe(20002);

    const initial = decodeBoundary(routes.run.response)(
      await Effect.runPromise(service.runSnapshot("run")),
    );

    const cached = applyToSnapshot(
      { ...initial, cursor: 0, nodeRuns: [], truncatedOutputs: {} },
      wire,
    );

    expect(Object.values(cached.truncatedOutputs ?? {})).toEqual([20002]);
    expect(cached.nodeRuns[0]).toMatchObject({ status: "succeeded", output: null });
  } finally {
    await Effect.runPromise(store.close());
  }
});

test("HTTP dashboard reads pin source and page diagnostic payloads outside the slim snapshot", async () => {
  const f = fixture(
    "dashboard-http",
    `run: () => {
    log("inspection", { count: 4 });
    log("second inspection");
    return wait("approve", { payload: { kind: "value", type: "boolean" } });
  }`,
  );

  await save(f);
  const run = await runFixture(f);
  const store = await fixtureStore(f.home);

  const daemon = await Effect.runPromise(
    localDaemon({
      home: f.home,
      cwd: f.cwd,
      store,
      concurrency: 1,
      port: 0,
      assets: join(f.cwd, "assets"),
    }).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

  const url = new URL(await Effect.runPromise(daemon.start));

  const headers = {
    Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
  };

  async function get(path: string) {
    const response = await fetch(`${url.origin}/api${path}`, { headers });
    expect(response.status).toBe(200);

    return response.json();
  }

  try {
    const snapshot = decodeBoundary(routes.run.response)(await get(`/runs/${run.id}`));

    const firstLogs = decodeBoundary(routes.logs.response)(
      await get(`/runs/${run.id}/logs?limit=1`),
    );

    expect(firstLogs).toHaveLength(1);

    const nextLogs = decodeBoundary(routes.logs.response)(
      await get(`/runs/${run.id}/logs?limit=1&after=${firstLogs[0]?.seq}`),
    );

    expect(nextLogs).toHaveLength(1);
    expect(nextLogs[0]?.seq).toBeGreaterThan(firstLogs[0]!.seq);
    expect(snapshot.run.waitingOn?.hook).toBe("approve");
    const source = decodeBoundary(routes.runSource.response)(await get(`/runs/${run.id}/source`));
    expect(source.status).toBe("available");

    if (source.status === "available") {
      expect(source.files[0]?.content).toContain('wait("approve"');
      expect(source.ranges.length).toBeGreaterThan(0);
    }

    const logs = decodeBoundary(routes.globalLogs.response)(
      await get(`/logs?runId=${run.id}&limit=1`),
    );

    expect(logs.items).toHaveLength(1);
    expect(logs.items[0]?.message).toBe("second inspection");
    expect(logs.items[0]).not.toHaveProperty("data");
    const detail = decodeBoundary(routes.log.response)(await get(`/logs/${logs.items[0]?.id}`));
    expect(detail.log.message).toBe("second inspection");

    const events = decodeBoundary(routes.eventHistory.response)(
      await get(`/event-history?runId=${run.id}&limit=2`),
    );

    expect(events.items).toHaveLength(2);
    expect(events.items[0]).not.toHaveProperty("record");

    const event = decodeBoundary(routes.event.response)(
      await get(`/event-history/${events.items[0]?.sequence}`),
    );

    expect(event.runId).toBe(run.id);

    const nodes = decodeBoundary(routes.executions.response)(
      await get(`/runs/${run.id}/executions?limit=1`),
    );

    expect(nodes.items).toHaveLength(1);
    expect(nodes.next).not.toBeNull();
    const from = new Date(Date.now() - 60000).toISOString();
    const to = new Date(Date.now() + 60000).toISOString();

    const overview = decodeBoundary(routes.overview.response)(
      await get(`/overview?from=${from}&to=${to}&bucketSeconds=60`),
    );

    expect(overview.counts.suspended).toBe(1);
    expect(
      (
        await fetch(`${url.origin}/api/runs/${run.id}/source`, {
          headers: { ...headers, Origin: "https://untrusted.example" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await Effect.runPromise(daemon.stop);
    await Effect.runPromise(store.close());
  }
});
