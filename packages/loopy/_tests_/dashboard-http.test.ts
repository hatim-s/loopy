import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { applyToSnapshot } from "../../../apps/dashboard/src/lib/stream.ts";
import { nodeIdSchema, routes } from "../src/contract/index.js";
import { SYSTEM_CLOCK } from "../src/host/index.js";
import { LoopyService, localDaemon, openRunStore, Registry } from "../src/local/index.js";
import { fixture, object, roots, runFixture, save } from "./cli-fixture.js";
import { newRun } from "./fixture.js";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the cache retains the server's streamed output preview size", async () => {
  const f = fixture("stream-preview", "run: () => null");
  const store = openRunStore(f.home);

  const service = new LoopyService({
    store,
    registry: () => new Registry(f.home, f.cwd),
    clock: SYSTEM_CLOCK,
  });

  try {
    await store.createRun(newRun());
    await store.claim("run", "owner");
    await store.apply({
      runId: "run",
      token: "owner",
      effects: [
        {
          kind: "write_node_run",
          nodeRun: {
            key: { runId: "run", nodeId: nodeIdSchema.parse("code"), scope: [] },
            attempt: 1,
            maxAttempts: 1,
            startedAt: newRun().createdAt,
            endedAt: newRun().createdAt,
            status: "succeeded",
            receipt: "finished",
            output: "x".repeat(20_000),
          },
        },
      ],
    });

    const event = (await service.events(await store.events(0, 20))).find(
      (value) => value.entity === "node",
    );

    if (!event || event.record.status !== "succeeded") {
      throw new Error("Expected a successful node event.");
    }

    const wire = routes.events.response.parse(event);
    expect(event.record.output).toBeNull();
    expect(event.truncatedOutputBytes).toBe(20_002);
    const initial = routes.run.response.parse(await service.runSnapshot("run"));

    const cached = applyToSnapshot(
      { ...initial, cursor: 0, nodeRuns: [], truncatedOutputs: {} },
      wire,
    );

    expect(Object.values(cached.truncatedOutputs ?? {})).toEqual([20_002]);
    expect(cached.nodeRuns[0]).toMatchObject({ status: "succeeded", output: null });
  } finally {
    store.close();
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
  const run = object((await runFixture(f)).stdout);
  const store = openRunStore(f.home);
  const daemon = localDaemon({ home: f.home, cwd: f.cwd, store, concurrency: 1, port: 0 });
  const url = new URL(daemon.start());

  const headers = {
    Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
  };

  async function get(path: string) {
    const response = await fetch(`${url.origin}/api${path}`, { headers });
    expect(response.status).toBe(200);

    return response.json();
  }

  try {
    const snapshot = routes.run.response.parse(await get(`/runs/${run.id}`));
    expect(snapshot.logs).toEqual([]);
    const firstLogs = routes.logs.response.parse(await get(`/runs/${run.id}/logs?limit=1`));
    expect(firstLogs).toHaveLength(1);

    const nextLogs = routes.logs.response.parse(
      await get(`/runs/${run.id}/logs?limit=1&after=${firstLogs[0]?.seq}`),
    );

    expect(nextLogs).toHaveLength(1);
    expect(nextLogs[0]?.seq).toBeGreaterThan(firstLogs[0]!.seq);
    expect(snapshot.run.waitingOn?.hook).toBe("approve");
    const source = routes.runSource.response.parse(await get(`/runs/${run.id}/source`));
    expect(source.status).toBe("available");

    if (source.status === "available") {
      expect(source.files[0]?.content).toContain('wait("approve"');
      expect(source.ranges.length).toBeGreaterThan(0);
    }

    const logs = routes.globalLogs.response.parse(await get(`/logs?runId=${run.id}&limit=1`));
    expect(logs.items).toHaveLength(1);
    expect(logs.items[0]?.message).toBe("second inspection");
    expect(logs.items[0]).not.toHaveProperty("data");
    const detail = routes.log.response.parse(await get(`/logs/${logs.items[0]?.id}`));
    expect(detail.log.message).toBe("second inspection");

    const events = routes.eventHistory.response.parse(
      await get(`/event-history?runId=${run.id}&limit=2`),
    );

    expect(events.items).toHaveLength(2);
    expect(events.items[0]).not.toHaveProperty("record");

    const event = routes.event.response.parse(
      await get(`/event-history/${events.items[0]?.sequence}`),
    );

    expect(run.id).toBe(event.runId);
    const nodes = routes.executions.response.parse(await get(`/runs/${run.id}/executions?limit=1`));
    expect(nodes.items).toHaveLength(1);
    expect(nodes.next).not.toBeNull();
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const overview = routes.overview.response.parse(
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
    await daemon.stop();
    store.close();
  }
});
