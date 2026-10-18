import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Json } from "../src/core/index.js";
import { revision } from "../src/core/index.js";
import { activate, SYSTEM_CLOCK } from "../src/host/index.js";
import { LoopyService, Registry } from "../src/local/index.js";
import { loopy } from "../src/sdk/index.js";
import { SqliteRunStore } from "../src/store/index.js";
import { FakeExecutor } from "./fixture.js";
import { fixture } from "./fixtures/executor.js";

async function setup() {
  const f = await fixture();
  const source = join(f.workspace, "input.ts");
  await writeFile(source, "export default null;");

  const { graph } = loopy("input", {
    input: { name: "string", count: "number", enabled: "boolean", "limit?": "number" },
    run: ({ input }) => input,
  });

  const registry = new Registry(f.home, f.workspace);
  await registry.save({
    graph,
    revision: await revision(graph),
    bundles: [],
    replace: false,
    source: { path: source, workspace: f.workspace },
  });
  const store = new SqliteRunStore(":memory:");

  const service = new LoopyService({
    home: f.home,
    store,
    registry: () => registry,
    clock: SYSTEM_CLOCK,
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
    await expect(f.service.startRun("input", input, f.workspace)).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(await f.store.listRuns()).toEqual([]);
  });
}

const validInputs: Json[] = [
  { name: "Hatim", count: 2, enabled: true },
  { name: "Hatim", count: 2, enabled: true, limit: 3 },
];

for (const input of validInputs) {
  test("required and optional primitive inputs persist and resolve through the graph", async () => {
    const f = await setup();
    const run = await f.service.startRun("input", input, f.workspace);
    expect((await f.store.getRun(run.id))?.input).toEqual(input);
    expect(
      await activate({
        runId: run.id,
        store: f.store,
        graph: f.graph,
        executor: new FakeExecutor(),
      }),
    ).toEqual({ status: "succeeded", output: input });
  });
}
