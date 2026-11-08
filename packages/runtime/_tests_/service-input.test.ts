import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Json } from "@loopy/core";
import { revision } from "@loopy/core";
import { loopy } from "@loopy/sdk/graph";
import { Effect } from "effect";
import { FakeExecutor } from "../../core/_tests_/fixtures/run";
import { activate } from "../src/host";
import { Registry } from "../src/local/registry";
import { makeLocalService } from "../src/local/service";
import { fixture } from "./fixtures/executor";
import { MemorySqlStore } from "./fixtures/stores";

async function setup() {
  const f = await fixture();
  const source = join(f.workspace, "input.ts");
  await writeFile(source, "export default null;");

  const graph = loopy("input", {
    input: { name: "string", count: "number", enabled: "boolean", "limit?": "number" },
    run: ({ input }) => input,
  });

  const registry = await Effect.runPromise(Registry.make(f.home, f.workspace));
  await Effect.runPromise(
    registry.save({
      graph,
      revision: await revision(graph),
      bundles: [],
      replace: false,
      source: { path: source, workspace: f.workspace },
    }),
  );
  const store = new MemorySqlStore();

  const service = makeLocalService({
    store,
    home: f.home,
    clock: { now: Date.now },
  });

  return { ...f, graph, store, service };
}

const invalidInputs: Json[] = [
  {},
  { name: "Hatim", count: "2", enabled: true },
  { name: "Hatim", count: 2, enabled: true, limit: "3" },
  { name: "Hatim", count: 2, enabled: true, extra: 1 },
];

for (const input of invalidInputs) {
  test("invalid graph input leaves no queued run", async () => {
    const f = await setup();
    await expect(
      Effect.runPromise(f.service.startRun("input", input, f.workspace)),
    ).rejects.toThrow("Input does not match the saved graph schema.");
    expect(
      await Effect.runPromise(f.store.queryRuns({ limit: 200, now: new Date().toISOString() })),
    ).toEqual([]);
  });
}

const validInputs: Json[] = [
  { name: "Hatim", count: 2, enabled: true },
  { name: "Hatim", count: 2, enabled: true, limit: 3 },
];

for (const input of validInputs) {
  test("required and optional primitive inputs persist and resolve through the graph", async () => {
    const f = await setup();
    const run = await Effect.runPromise(f.service.startRun("input", input, f.workspace));
    expect((await Effect.runPromise(f.store.getRun(run.id)))?.input).toEqual(input);
    expect(
      await Effect.runPromise(
        activate({
          runId: run.id,
          store: f.store,
          graph: f.graph,
          executor: new FakeExecutor(),
        }),
      ),
    ).toEqual({ status: "succeeded", output: input });
  });
}
