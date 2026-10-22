import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compile } from "../src/compiler/index.js";
import { type NodeRun, type StoreEffect } from "../src/core/index.js";
import { SYSTEM_CLOCK } from "../src/host/index.js";
import { LoopyService, openRunStore, Registry, SqliteRunStore } from "../src/local/index.js";

export async function largeMapFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-dashboard-10k-map-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const source = join(root, "reindex-docs.loopy.ts");
  writeFileSync(
    source,
    `import {loopy,map,code} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))};
export default loopy("reindex-docs", {
  description: "Synthetic completed 10,000-item fixture. No engine or provider calls.",
  input: {items:"string[]"},
  run: ({input}) => map(input.get("items"), (item) =>
    code("index-doc", {in:{path:item},out:{kind:"record",fields:{path:"string"}},module:"./index-doc.ts"})
  , {onError:"collect"})
});\n`,
  );
  writeFileSync(
    join(root, "index-doc.ts"),
    "export default (input: {path:string}) => ({path:input.path});\n",
  );
  const compiled = await compile(source);

  if (!compiled.ok) {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }

  const registry = new Registry(home, root);
  let now = Date.parse("2026-10-22T06:00:00.000Z");
  const store = new SqliteRunStore(join(home, "runs.sqlite"), () => now);

  const service = new LoopyService({
    store,
    registry: () => registry,
    clock: { ...SYSTEM_CLOCK, now: () => now },
  });

  await service.putLoopy("reindex-docs", {
    graph: compiled.graph,
    revision: compiled.revision,
    bundles: compiled.bundles.map((bundle) => ({
      ...bundle,
      bytes: Buffer.from(bundle.bytes).toString("base64"),
    })),
    source: { path: source, workspace: root },
    sourceArtifact: compiled.sourceArtifact,
    replace: false,
  });
  const runId = "synthetic-map-10000";
  const at = "2026-10-22T06:00:00.000Z";

  const items = Array.from(
    Array(10000).keys(),
    (index) => `docs/document-${String(index).padStart(5, "0")}.md`,
  );

  const map = compiled.graph.nodes.find((node) => node.kind === "map");
  const work = compiled.graph.nodes.find((node) => node.kind === "code");

  if (!map || !work) {
    throw new Error("Fixture graph lacks its map/code nodes.");
  }

  await store.createRun({
    id: runId,
    slug: "reindex-docs",
    workspace: root,
    revision: compiled.revision,
    input: { items },
    status: "queued",
    createdAt: at,
    updatedAt: at,
  });
  await store.claim(runId, "synthetic-owner");
  const started = performance.now();

  for (let base = 0; base < items.length; base += 500) {
    const effects: StoreEffect[] = items.slice(base, base + 500).flatMap((path, offset) => {
      const index = base + offset;

      const node: NodeRun = {
        key: { runId, nodeId: work.id, scope: [{ nodeId: map.id, index }] },
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

    await store.apply({ runId, token: "synthetic-owner", effects });
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
  await store.apply({
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
  });
  await store.release(runId, "synthetic-owner");

  return {
    root,
    home,
    store,
    service,
    registry,
    runId,
    mapNodeId: map.id,
    nodeId: work.id,
    ingestMs: performance.now() - started,
  };
}

export async function manyRunsFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-dashboard-10k-runs-")));
  const home = join(root, "home");
  const store = openRunStore(home);
  const registry = new Registry(home, root);
  const service = new LoopyService({ store, registry: () => registry, clock: SYSTEM_CLOCK });
  const source = join(root, "queue-drain.loopy.ts");
  writeFileSync(
    source,
    `import {loopy} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))};\nexport default loopy("queue-drain",{input:{},run:()=>null});\n`,
  );
  const compiled = await compile(source);

  if (!compiled.ok) {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }

  await service.putLoopy("queue-drain", {
    graph: compiled.graph,
    revision: compiled.revision,
    bundles: compiled.bundles.map((bundle) => ({
      ...bundle,
      bytes: Buffer.from(bundle.bytes).toString("base64"),
    })),
    source: { path: source, workspace: root },
    sourceArtifact: compiled.sourceArtifact,
    replace: false,
  });
  const started = performance.now();

  for (let index = 0; index < 10000; index++) {
    const at = new Date(
      Date.parse("2026-10-15T00:00:00.000Z") + Math.floor(index / 2) * 60000,
    ).toISOString();

    await store.createRun({
      id: `run-${String(index).padStart(5, "0")}`,
      slug: "queue-drain",
      workspace: root,
      revision: compiled.revision,
      input: {},
      status: index % 10 === 0 ? "failed" : "succeeded",
      ...(index % 10 === 0 ? { error: "Synthetic failure" } : { output: null }),
      createdAt: at,
      updatedAt: at,
    });
  }

  return { root, home, store, service, ingestMs: performance.now() - started };
}
