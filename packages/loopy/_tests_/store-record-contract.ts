import { expect, test } from "bun:test";
import { type DashboardReader, nodeIdSchema } from "@loopy/contract";
import type { NodeRun, Store, StoreEffect } from "@loopy/core";
import { Effect, Schema } from "effect";
import { newRun } from "./fixture";

const at = newRun().createdAt;

const key = { runId: "run", nodeId: Schema.decodeUnknownSync(nodeIdSchema)("0:code"), scope: [] };

const node: NodeRun = {
  key,
  attempt: 1,
  maxAttempts: 3,
  startedAt: at,
  status: "succeeded",
  output: { nested: [1] },
  endedAt: at,
  receipt: "finished",
};

export function storeRecordContract(
  makeStore: () => (Store & DashboardReader) | Promise<Store & DashboardReader>,
) {
  test("run, node and log inputs and every returned view isolate nested records", async () => {
    const store = await makeStore();
    const run = newRun();
    await Effect.runPromise(store.createRun(run));
    run.input = { changed: true };
    const claimed = await Effect.runPromise(store.claim("run", "owner"));
    claimed.input = null;
    claimed.status = "failed";

    const effects: StoreEffect[] = [
      { kind: "write_node_run", nodeRun: structuredClone(node) },
      {
        kind: "write_log",
        executionKey: structuredClone(key),
        attempt: 1,
        at,
        log: { message: "hello", data: { nested: [1] } },
      },
    ];

    await Effect.runPromise(store.apply({ runId: "run", token: "owner", effects }));
    const write = effects[0];
    const log = effects[1];

    if (
      write?.kind !== "write_node_run" ||
      write.nodeRun.status !== "succeeded" ||
      log?.kind !== "write_log"
    ) {
      throw new Error("Invalid fixture");
    }

    write.nodeRun.output = null;
    write.nodeRun.key.scope.push({ nodeId: key.nodeId, index: 2 });
    log.log.data = null;

    const views = [
      await Effect.runPromise(store.getRun("run")),
      ...(await Effect.runPromise(store.queryRuns({ limit: 200, now: at }))),
      ...(await Effect.runPromise(store.dueRuns(at))),
    ];

    for (const view of views) {
      if (view) {
        view.input = null;
        view.status = "failed";
      }
    }

    const nodes = await Effect.runPromise(store.getNodeRuns("run"));
    const logs = await Effect.runPromise(store.getLogs("run"));

    if (nodes[0]?.status === "succeeded") {
      nodes[0].output = null;
      nodes[0].key.scope.push({ nodeId: key.nodeId, index: 3 });
    }

    if (logs[0]) {
      logs[0].data = null;
      logs[0].message = "changed";
    }

    const snapshot = await Effect.runPromise(store.dashboardSnapshot("run"));

    if (snapshot) {
      snapshot.run.input = null;
      snapshot.nodeRuns.splice(0);
      snapshot.logs.splice(0);
    }

    expect(await Effect.runPromise(store.getRun("run"))).toMatchObject({
      input: { value: 42 },
      status: "running",
    });
    expect(await Effect.runPromise(store.getNodeRuns("run"))).toEqual([node]);
    expect(await Effect.runPromise(store.getLogs("run"))).toMatchObject([
      { message: "hello", data: { nested: [1] } },
    ]);
    const outcome = { status: "succeeded" as const, output: { nested: [1] } };
    await Effect.runPromise(
      store.apply({ runId: "run", token: "owner", effects: [{ kind: "finish_run", outcome, at }] }),
    );
    outcome.output.nested.push(2);
    expect((await Effect.runPromise(store.getRun("run")))?.output).toEqual({ nested: [1] });
    await Effect.runPromise(store.release("run", "owner"));
    const terminal = await Effect.runPromise(store.getRun("run"));

    if (terminal) {
      terminal.output = null;
    }

    expect((await Effect.runPromise(store.getRun("run")))?.output).toEqual({ nested: [1] });
  });

  test("due runs filter terminal, future, indefinite and owned states", async () => {
    const store = await makeStore();

    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      await Effect.runPromise(store.createRun({ ...newRun(), id: status, status, wakeAt: at }));
    }

    await Effect.runPromise(
      store.createRun({ ...newRun(), id: "indefinite", status: "suspended" }),
    );
    await Effect.runPromise(
      store.createRun({
        ...newRun(),
        id: "future",
        status: "suspended",
        wakeAt: "2100-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(store.createRun({ ...newRun(), id: "owned" }));
    await Effect.runPromise(store.claim("owned", "owner"));
    await Effect.runPromise(
      store.createRun({ ...newRun(), id: "due", status: "suspended", wakeAt: at }),
    );
    await Effect.runPromise(store.createRun({ ...newRun(), id: "queued" }));
    expect((await Effect.runPromise(store.dueRuns(at))).map((run) => run.id)).toEqual([
      "due",
      "queued",
    ]);
  });

  test("due runs sort chronologically across timestamp offsets", async () => {
    const store = await makeStore();
    await Effect.runPromise(
      store.createRun({ ...newRun(), id: "later", createdAt: "2026-10-16T01:00:00.000Z" }),
    );
    await Effect.runPromise(
      store.createRun({ ...newRun(), id: "earlier", createdAt: "2026-10-16T05:00:00+05:00" }),
    );
    expect((await Effect.runPromise(store.dueRuns(at))).map((run) => run.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect((await Effect.runPromise(store.getRun("earlier")))?.createdAt).toBe(at);
  });

  test("run, node, log and retry timestamp writes normalize UTC and due comparisons accept offsets", async () => {
    const store = await makeStore();
    const offset = "2026-10-16T05:00:00+05:00";
    await Effect.runPromise(
      store.createRun({
        ...newRun(),
        createdAt: offset,
        updatedAt: offset,
        status: "suspended",
        wakeAt: offset,
        nextRetryAt: offset,
        owner: { token: "owner", host: "test", pid: 1, heartbeatAt: offset },
      }),
    );
    expect(await Effect.runPromise(store.getRun("run"))).toMatchObject({
      createdAt: at,
      updatedAt: at,
      wakeAt: at,
      nextRetryAt: at,
      owner: { heartbeatAt: at },
    });
    await Effect.runPromise(store.release("run", "owner"));
    expect((await Effect.runPromise(store.dueRuns(offset))).map((run) => run.id)).toEqual(["run"]);
    await Effect.runPromise(store.claim("run", "next"));
    await Effect.runPromise(
      store.apply({
        runId: "run",
        token: "next",
        effects: [
          {
            kind: "write_node_run",
            nodeRun: {
              key,
              attempt: 1,
              maxAttempts: 3,
              receipt: "finished",
              startedAt: offset,
              endedAt: offset,
              status: "retrying",
              error: { code: "execution", message: "retry" },
              nextRetryAt: offset,
            },
          },
          {
            kind: "write_log",
            executionKey: key,
            attempt: 1,
            log: { message: "hello", data: null },
            at: offset,
          },
          { kind: "schedule_activation", at: offset },
        ],
      }),
    );
    expect(await Effect.runPromise(store.getNodeRuns("run"))).toMatchObject([
      { startedAt: at, endedAt: at, nextRetryAt: at },
    ]);
    expect(await Effect.runPromise(store.getLogs("run"))).toMatchObject([{ at }]);
    expect(await Effect.runPromise(store.getRun("run"))).toMatchObject({
      nextRetryAt: at,
      wakeAt: at,
    });
    await Effect.runPromise(
      store.apply({
        runId: "run",
        token: "next",
        effects: [{ kind: "suspend_run", wakeAt: offset, at: offset }],
      }),
    );
    await Effect.runPromise(store.release("run", "next"));
    expect((await Effect.runPromise(store.getRun("run")))?.wakeAt).toBe(at);
    expect(await Effect.runPromise(store.dueRuns("2026-10-16T04:59:59+05:00"))).toEqual([]);
    expect((await Effect.runPromise(store.dueRuns(offset))).map((run) => run.id)).toEqual(["run"]);
  });
}
