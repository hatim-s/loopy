import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunRecord } from "../core/index.js";
import { isLoopy, type Loopy } from "../sdk/host.js";
import { defaultHome } from "./home.js";
import { Registry } from "./registry.js";

const IMPORT_META = /\bimport\.meta\.(?:url|path|filename|file|dir|dirname)\b/g;

// A saved bundle runs from <home>/bundles, so each module's import.meta must keep
// pointing at the file it was written in. Loopies locate sibling scripts with it.
function inlineImportMeta(path: string, source: string) {
  const values = new Map([
    ["import.meta.url", pathToFileURL(path).href],
    ["import.meta.path", path],
    ["import.meta.filename", path],
    ["import.meta.file", basename(path)],
    ["import.meta.dir", dirname(path)],
    ["import.meta.dirname", dirname(path)],
  ]);

  return source.replaceAll(IMPORT_META, (match) => JSON.stringify(values.get(match) ?? match));
}

const sourcePaths: Bun.BunPlugin = {
  name: "loopy-source-paths",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path, loader }) => ({
      contents: inlineImportMeta(path, await Bun.file(path).text()),
      loader,
    }));
  },
};

export async function bundleLoopy(file: string, home = defaultHome()) {
  const result = await Bun.build({
    entrypoints: [file],
    target: "bun",
    format: "esm",
    plugins: [sourcePaths],
  });

  const output = result.outputs[0];

  if (!result.success || !output) {
    throw new Error(
      `Could not bundle '${file}'. Fix the build errors and save again: ${result.logs.join("; ")}.`,
    );
  }

  const bytes = await output.arrayBuffer();
  const hash = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  const path = join(home, "bundles", `${hash}.js`);
  await mkdir(join(home, "bundles"), { recursive: true, mode: 0o700 });
  await writeFile(path, new Uint8Array(bytes), { mode: 0o600 });

  return { hash, path };
}

// BOUNDARY: Only the save or load caller can decide whether an imported default is an SDK definition.
async function importLoopy(path: string) {
  const module: { default?: unknown } = await import(pathToFileURL(path).href);

  return module.default;
}

export async function loadLoopy(path: string): Promise<Loopy> {
  if (!(await Bun.file(path).exists())) {
    throw new Error(`Missing bundle '${path}'. Save the loopy again and start a new run.`);
  }

  const value = await importLoopy(path);

  if (!isLoopy(value)) {
    throw new Error(
      `'${path}' does not default-export a loopy() definition. Save a file with a default loopy() export.`,
    );
  }

  return value;
}

export async function loadRunLoopy(home: string, run: RunRecord): Promise<Loopy> {
  const registry = new Registry(home, run.workspace);

  return loadLoopy(registry.bundlePath(run.bundleHash));
}
