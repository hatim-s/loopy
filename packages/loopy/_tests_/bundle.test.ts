import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleLoopy, loadLoopy } from "../src/local/bundle.js";
import { MemoryRunStore } from "../src/runtime/index.js";
import { FakeExecutor, startLoopy } from "./fixture.js";

const sdk = resolve(import.meta.dir, "../src/sdk/index.ts");

async function withProject(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-bundle-")));

  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function outputOf(root: string, entry: string) {
  const { path } = await bundleLoopy(entry, join(root, "home"));

  const result = await startLoopy({
    loopy: await loadLoopy(path),
    input: {},
    store: new MemoryRunStore(),
    executor: new FakeExecutor(),
    runId: "bundle",
    bundleHash: "",
    workspace: root,
  });

  if (result.status !== "succeeded") {
    throw new Error(`Run ${result.status}: ${JSON.stringify(result)}`);
  }

  return result.output;
}

test("import.meta inside a saved bundle names each module's source file", async () => {
  await withProject(async (root) => {
    const entry = join(root, "entry.ts");
    const helper = join(root, "lib", "helper.ts");
    const view = join(root, "lib", "view.tsx");
    await Bun.write(
      helper,
      `export const helper = {
        url: (import.meta).url,
        dir: import /* meta */ .meta.dir,
        file: import.meta.file,
      };`,
    );
    await Bun.write(view, `export const view = () => ({ href: import.meta.path });`);
    await Bun.write(
      entry,
      `import { loopy } from ${JSON.stringify(sdk)};
      import { helper } from "./lib/helper.ts";
      import { view } from "./lib/view.tsx";
      export default loopy({
        name: "paths",
        run: () => ({ entry: import.meta.path, view: view().href, ...helper }),
      });`,
    );

    expect(await outputOf(root, entry)).toEqual({
      entry,
      view,
      url: pathToFileURL(helper).href,
      dir: join(root, "lib"),
      file: "helper.ts",
    });
  });
});

test("the rewrite leaves everything that is not import.meta.<key> as Bun would see it", async () => {
  await withProject(async (root) => {
    const entry = join(root, "entry.ts");
    await Bun.write(join(root, "lib", "note.txt"), "plain text");
    await Bun.write(
      join(root, "lib", "types.ts"),
      `export interface Thing { n: number }
      export const thing: Thing = { n: 1 };`,
    );
    await Bun.write(
      join(root, "lib", "helper.ts"),
      `#!/usr/bin/env bun
      import { Thing } from "./types.ts";
      export const thing: Thing = require("./types.ts").thing;
      export const where = import.meta.url;
      export class Target {
        static path = "static";
        path: string;
        constructor() {
          this.path = new.target.path;
        }
      }`,
    );
    await Bun.write(
      entry,
      `import { loopy } from ${JSON.stringify(sdk)};
      import { Target, thing } from "./lib/helper.ts";
      import note from "./lib/note.txt" with { type: "text" };
      const literal = "import.meta.url"; // import.meta.url in a comment
      export default loopy({
        name: "untouched",
        run: () => ({ literal, note, thing, target: new Target().path }),
      });`,
    );

    expect(await outputOf(root, entry)).toEqual({
      literal: "import.meta.url",
      note: "plain text",
      thing: { n: 1 },
      target: "static",
    });
  });
});
