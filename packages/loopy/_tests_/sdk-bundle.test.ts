import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryRunStore } from "../src/runtime/index.js";
import type { Loopy } from "../src/sdk/index.js";
import { startLoopy } from "../src/sdk/run.js";
import { FakeExecutor } from "./engine-fixture.js";

async function bundledLoopy(root: string): Promise<Loopy> {
  const entry = join(root, "entry.ts");
  const sdk = resolve(import.meta.dir, "../src/sdk/index.ts");
  await Bun.write(
    entry,
    `
    import { loopy, step } from ${JSON.stringify(sdk)};
    export default loopy({ name: "bundled", run: () => step("answer", () => 42) });
  `,
  );

  const result = await Bun.build({
    entrypoints: [entry],
    outdir: join(root, "out"),
    target: "bun",
    format: "esm",
    external: [],
  });

  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
  const { default: definition }: { default: Loopy } = await import(join(root, "out/entry.js"));
  expect(Object.getOwnPropertySymbols(definition)).toContain(Symbol.for("loopy"));

  return definition;
}

test("a self-contained Bun bundle shares the host's active scope and brand", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-sdk-bundle-"));

  try {
    const definition = await bundledLoopy(root);
    const store = new MemoryRunStore();
    expect(
      await startLoopy({
        loopy: definition,
        input: {},
        store,
        executor: new FakeExecutor(),
        runId: "bundled",
        bundleHash: "",
        workspace: root,
      }),
    ).toEqual({ status: "succeeded", output: 42 });
    expect(await store.getSteps("bundled")).toMatchObject([
      { key: "answer", status: "succeeded", output: 42 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
