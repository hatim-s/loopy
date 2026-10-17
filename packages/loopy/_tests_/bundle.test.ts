import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleLoopy, loadLoopy } from "../src/local/bundle.js";
import { MemoryRunStore } from "../src/runtime/index.js";
import { FakeExecutor, startLoopy } from "./fixture.js";

test("a saved bundle keeps each module's import.meta on its source file", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-bundle-")));
  const home = join(root, "home");
  const entry = join(root, "entry.ts");
  const helper = join(root, "lib", "helper.ts");
  const sdk = resolve(import.meta.dir, "../src/sdk/index.ts");

  try {
    await Bun.write(join(root, "lib", "note.txt"), "plain text");
    await Bun.write(
      helper,
      `export const helper = { url: import.meta.url, dir: import.meta.dir, file: import.meta["file"] };`,
    );
    await Bun.write(
      entry,
      `
      import { loopy } from ${JSON.stringify(sdk)};
      import { helper } from "./lib/helper.ts";
      import note from "./lib/note.txt" with { type: "text" };
      const literal: string = "import.meta.url";
      export default loopy({
        name: "paths",
        run: () => ({ entry: import.meta.path, literal, note, main: import.meta.main, ...helper }),
      });
      `,
    );

    const { path } = await bundleLoopy(entry, home);
    expect(path.startsWith(join(home, "bundles"))).toBe(true);

    const result = await startLoopy({
      loopy: await loadLoopy(path),
      input: {},
      store: new MemoryRunStore(),
      executor: new FakeExecutor(),
      runId: "paths",
      bundleHash: "",
      workspace: root,
    });

    expect(result).toEqual({
      status: "succeeded",
      output: {
        entry,
        literal: "import.meta.url",
        note: "plain text",
        main: false,
        url: pathToFileURL(helper).href,
        dir: join(root, "lib"),
        file: "helper.ts",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
