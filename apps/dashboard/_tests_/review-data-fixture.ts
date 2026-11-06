import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { compile } from "../../../packages/loopy/src/compiler";
import type { NodeRun, StoreEffect } from "../../../packages/loopy/src/core";
import { makeLocalService, openRunStore } from "../../../packages/loopy/src/local";

/** Persisted synthetic records let HTTP and browser checks inspect the same bounded pages. */
export const reviewDataFixture = Effect.fn(function* () {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-review-data-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(root, { recursive: true, force: true })),
  );
  const home = join(root, "home");
  const workspaceA = join(root, "project-a");
  const workspaceB = join(root, "project-b");

  for (const directory of [home, workspaceA, workspaceB]) {
    mkdirSync(directory, { recursive: true });
  }

  for (const workspace of [workspaceA, workspaceB]) {
    mkdirSync(join(workspace, ".loopy", "loopies"), { recursive: true });
  }

  const source = join(workspaceA, "review-data.loopy.ts");
  writeFileSync(
    source,
    `import {loopy,log,map} from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/loopy/src/sdk/graph/index.ts"))};
export default loopy("review-data", {input: {items: "string[]"}, run: ({input}) => {
${Array.from(Array(198).keys(), (index) => `log("root-${index}");`).join("\n")}
return map(input.get("items"), () => {
${Array.from(Array(50).keys(), (index) => `log("item-${index}");`).join("\n")}
return "done";
}, {onError: "fail"});
}});`,
  );
  const compiled = yield* compile(source);

  if (!compiled.ok) {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }

  const store = yield* openRunStore(home);

  const service = makeLocalService({
    store,
    home,
    cwd: workspaceA,
    clock: { now: Date.now },
  });

  const definition = {
    graph: compiled.graph,
    revision: compiled.revision,
    bundles: compiled.bundles.map((bundle) => ({
      ...bundle,
      bytes: Buffer.from(bundle.bytes).toString("base64"),
    })),
    sourceArtifact: compiled.sourceArtifact,
    replace: false,
  };

  for (const workspace of [workspaceA, workspaceB]) {
    yield* service.putLoopy("review-data", {
      ...definition,
      source: { path: source, workspace },
    });
  }

  const runId = "review-data-201-51";
  const at = new Date().toISOString();
  yield* store.createRun({
    id: runId,
    slug: "review-data",
    workspace: workspaceA,
    revision: compiled.revision,
    input: { items: ["item"] },
    status: "queued",
    createdAt: at,
    updatedAt: at,
  });
  yield* store.claim(runId, "synthetic-owner");
  const map = compiled.graph.nodes.find((node) => node.kind === "map");

  if (!map) {
    throw new Error("Review fixture requires a map.");
  }

  const itemScope = [{ nodeId: map.id, index: 0 }];

  const records: NodeRun[] = compiled.graph.nodes.map((node) => ({
    key: { runId, nodeId: node.id, scope: node.scope === null ? [] : itemScope },
    attempt: 1,
    maxAttempts: 1,
    startedAt: at,
    endedAt: at,
    receipt: "none",
    status: "succeeded",
    output: null,
  }));

  const logged = records[0];

  if (!logged) {
    throw new Error("Review fixture requires an execution for logs.");
  }

  const effects: StoreEffect[] = records.map((nodeRun) => ({ kind: "write_node_run", nodeRun }));

  for (let index = 0; index < 75; index++) {
    effects.push({
      kind: "write_log",
      executionKey: logged.key,
      attempt: 1,
      log: {
        data: null,
        message: index === 0 ? `${"x".repeat(1100)}DIAGNOSTIC_END` : `diagnostic-${index}`,
      },
      at,
    });
  }

  effects.push({ kind: "finish_run", outcome: { status: "succeeded", output: null }, at });
  yield* store.apply({ runId, token: "synthetic-owner", effects });
  yield* store.release(runId, "synthetic-owner");

  // Historical message-only logs omit data, while executor write effects require a JSON value.
  const db = new Database(join(home, "runs.sqlite"));
  db.query(
    "UPDATE logs SET record=json_remove(record,'$.data'),data_bytes=0 WHERE run_id=? AND seq=1",
  ).run(runId);
  db.close();

  return { root, home, workspaceA, workspaceB, source, runId, store, service, itemScope, records };
});
