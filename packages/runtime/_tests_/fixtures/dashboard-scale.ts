import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type NodeRun, type StoreEffect } from "@loopy/core";
import { code, loopy, map } from "@loopy/sdk";
import { Effect, Scope } from "effect";
import { makeLocalService, Registry } from "../../src/local";
import { openRunStore } from "../../src/store";
import { runAt } from "./clock";
import { builtBody } from "./compiled";

// The dashboard-scale test and the apps/cloud/dev/dashboard-queries.ts benchmark both seed these
// datasets, so the caller owns the root and the scope.
const openStore = (home: string, scope: Scope.Scope) =>
  Effect.runPromise(openRunStore(home).pipe(Effect.provideService(Scope.Scope, scope)));

/** Seeds one finished 10,000-item map run in `root`, which must hold a registry marker. */
export async function largeMapFixture(root: string, scope: Scope.Scope) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const source = join(root, "reindex-docs.loopy.ts");

  const compiled = await builtBody(
    loopy("reindex-docs", {
      description: "Synthetic completed 10,000-item fixture. No engine or provider calls.",
      input: { items: "string[]" },
      run: ({ input }) =>
        map(
          input.get("items"),
          (item) =>
            code("index-doc", {
              in: { path: item },
              out: { kind: "record", fields: { path: "string" } },
              module: "./index-doc.ts",
            }),
          { onError: "collect" },
        ),
    }),
    { path: source, workspace: root },
    'export default loopy("reindex-docs", ...);\n',
  );

  const registry = await Effect.runPromise(Registry.make(home, root));
  let now = Date.parse("2026-10-22T06:00:00.000Z");
  const store = await openStore(home, scope);
  const onClock = runAt(() => now);

  const service = makeLocalService({ store, home });

  await Effect.runPromise(service.putLoopy("reindex-docs", compiled));
  const runId = "synthetic-map-10000";
  const at = "2026-10-22T06:00:00.000Z";

  const items = Array.from(
    Array(10000).keys(),
    (index) => `docs/document-${String(index).padStart(5, "0")}.md`,
  );

  const mapNode = compiled.graph.nodes.find((node) => node.kind === "map");
  const work = compiled.graph.nodes.find((node) => node.kind === "code");

  if (!mapNode || !work) {
    throw new Error("Fixture graph lacks its map/code nodes.");
  }

  await onClock(
    store.createRun({
      id: runId,
      slug: "reindex-docs",
      workspace: root,
      revision: compiled.revision,
      input: { items },
      status: "queued",
      createdAt: at,
      updatedAt: at,
    }),
  );
  await onClock(store.claim(runId, "synthetic-owner"));
  const started = performance.now();

  for (let base = 0; base < items.length; base += 500) {
    const effects: StoreEffect[] = items.slice(base, base + 500).flatMap((path, offset) => {
      const index = base + offset;

      const node: NodeRun = {
        key: { runId, nodeId: work.id, scope: [{ nodeId: mapNode.id, index }] },
        attempt: 1,
        maxAttempts: 3,
        startedAt: at,
        endedAt: "2026-10-22T06:01:00.000Z",
        receipt: "finished",
        status: "succeeded",
        output: { path },
        inputView: { state: "available", value: { path } },
      };

      return [
        { kind: "write_node_run", nodeRun: node },
        {
          kind: "write_log",
          executionKey: node.key,
          attempt: 1,
          log: { message: `Indexed ${path}`, data: { index, path } },
          at,
        },
      ];
    });

    await onClock(store.apply({ runId, token: "synthetic-owner", effects }));
  }

  const rootEffects: StoreEffect[] = compiled.graph.nodes
    .filter((node) => node.scope === null)
    .map((node) => ({
      kind: "write_node_run",
      nodeRun: {
        key: { runId, nodeId: node.id, scope: [] },
        attempt: 1,
        maxAttempts: 1,
        startedAt: at,
        endedAt: "2026-10-22T06:01:00.000Z",
        receipt: "none",
        status: "succeeded",
        output: items,
      },
    }));

  now = Date.parse("2026-10-22T06:01:00.000Z");
  await onClock(
    store.apply({
      runId,
      token: "synthetic-owner",
      effects: [
        ...rootEffects,
        {
          kind: "finish_run",
          outcome: { status: "succeeded", output: items },
          at: "2026-10-22T06:01:00.000Z",
        },
      ],
    }),
  );
  await onClock(store.release(runId, "synthetic-owner"));

  return {
    root,
    home,
    store,
    service,
    registry,
    runId,
    mapNodeId: mapNode.id,
    nodeId: work.id,
    ingestMs: performance.now() - started,
  };
}

/** Seeds 10,000 terminal runs of one loopy in `root`, which must hold a registry marker. */
export async function manyRunsFixture(root: string, scope: Scope.Scope) {
  const home = join(root, "home");
  const store = await openStore(home, scope);

  const service = makeLocalService({
    store,
    home: home,
  });

  const compiled = await builtBody(loopy("queue-drain", { input: {}, run: () => null }), {
    path: join(root, "queue-drain.loopy.ts"),
    workspace: root,
  });

  await Effect.runPromise(service.putLoopy("queue-drain", compiled));
  const started = performance.now();

  for (let index = 0; index < 10000; index++) {
    const at = new Date(
      Date.parse("2026-10-15T00:00:00.000Z") + Math.floor(index / 2) * 60000,
    ).toISOString();

    await Effect.runPromise(
      store.createRun({
        id: `run-${String(index).padStart(5, "0")}`,
        slug: "queue-drain",
        workspace: root,
        revision: compiled.revision,
        input: {},
        ...(index % 10 === 0
          ? { status: "failed", error: "Synthetic failure" }
          : { status: "succeeded", output: null }),
        createdAt: at,
        updatedAt: at,
      }),
    );
  }

  return { root, home, store, service, ingestMs: performance.now() - started };
}
