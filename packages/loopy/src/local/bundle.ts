import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSync, Visitor } from "oxc-parser";
import type { RunRecord } from "../core/index.js";
import { isLoopy, type Loopy } from "../sdk/host.js";
import { defaultHome } from "./home.js";
import { Registry } from "./registry.js";

// A saved bundle runs from <home>/bundles, so each module's import.meta must keep
// naming the file it was written in. Loopies locate sibling scripts with it. Only
// the parsed `import.meta.<key>` expressions are spliced, so strings, comments,
// loaders and type elision stay exactly as Bun would otherwise see them.
// Destructuring and computed access such as import.meta["url"] are not rewritten.
function inlineImportMeta(path: string, source: string) {
  const values = new Map([
    ["url", pathToFileURL(path).href],
    ["path", path],
    ["filename", path],
    ["file", basename(path)],
    ["dir", dirname(path)],
    ["dirname", dirname(path)],
  ]);

  const { program, errors } = parseSync(path, source);

  if (errors.length > 0) {
    return source;
  }

  const edits: { start: number; end: number; text: string }[] = [];

  new Visitor({
    MemberExpression(node) {
      if (
        node.object.type !== "MetaProperty" ||
        node.computed ||
        node.property.type !== "Identifier"
      ) {
        return;
      }

      const value = values.get(node.property.name);

      if (value !== undefined) {
        edits.push({ start: node.start, end: node.end, text: JSON.stringify(value) });
      }
    },
  }).visit(program);

  return edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}

const sourcePaths: Bun.BunPlugin = {
  name: "loopy-source-paths",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path, loader }) => {
      const source = await Bun.file(path).text();

      if (!/\bimport\s*\.\s*meta\b/.test(source)) {
        return undefined;
      }

      return { contents: inlineImportMeta(path, source), loader };
    });
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
