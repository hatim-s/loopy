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
      join(root, "lib", "types.ts"),
      `export interface Thing { n: number }\nexport const thing: Thing = { n: 1 };`,
    );
    await Bun.write(
      helper,
      `#!/usr/bin/env bun
      import { Thing } from "./types.ts";
      export const thing: Thing = require("./types.ts").thing;
      export const helper = { url: import.meta.url, dir: import.meta . dir, file: import.meta.file };`,
    );
    await Bun.write(
      join(root, "lib", "view.tsx"),
      `export const view = () => ({ href: import.meta.path });`,
    );
    await Bun.write(
      entry,
      `
      import { loopy } from ${JSON.stringify(sdk)};
      import { helper, thing } from "./lib/helper.ts";
      import { view } from "./lib/view.tsx";
      import note from "./lib/note.txt" with { type: "text" };
      const literal = "import.meta.url"; // import.meta.url in a comment
      export default loopy({
        name: "paths",
        run: () => ({
          entry: import.meta.path,
          literal,
          note,
          thing,
          main: import.meta.main,
          view: view().href,
          ...helper,
        }),
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
        thing: { n: 1 },
        main: false,
        view: join(root, "lib", "view.tsx"),
        url: pathToFileURL(helper).href,
        dir: join(root, "lib"),
        file: "helper.ts",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
