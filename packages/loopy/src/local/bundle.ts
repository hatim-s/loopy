import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunRecord } from "../core/index.js";
import { isLoopy, type Loopy } from "../sdk/host.js";
import { defaultHome } from "./home.js";
import { Registry } from "./registry.js";

const LOADERS = new Map<string, Bun.JavaScriptLoader>([
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
]);

// A saved bundle runs from <home>/bundles, so each module's import.meta must keep
// naming the file it was written in. Loopies locate sibling scripts with it. Bun's
// transpiler applies the substitutions to parsed expressions only, so strings and
// regexes that mention import.meta stay intact. Destructuring import.meta is not
// rewritten; JSX modules are left alone because transpiling them here would drop
// the runtime import the bundler adds later.
function inlineImportMeta(path: string, loader: Bun.JavaScriptLoader, source: string) {
  const define = {
    "import.meta.url": JSON.stringify(pathToFileURL(path).href),
    "import.meta.path": JSON.stringify(path),
    "import.meta.filename": JSON.stringify(path),
    "import.meta.file": JSON.stringify(basename(path)),
    "import.meta.dir": JSON.stringify(dirname(path)),
    "import.meta.dirname": JSON.stringify(dirname(path)),
  };

  return new Bun.Transpiler({ loader, define, target: "bun" }).transformSync(source);
}

const sourcePaths: Bun.BunPlugin = {
  name: "loopy-source-paths",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async ({ path }) => {
      const loader = LOADERS.get(extname(path));
      const source = await Bun.file(path).text();

      if (loader === undefined || !source.includes("import.meta")) {
        return undefined;
      }

      return { contents: inlineImportMeta(path, loader, source), loader: "js" };
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
