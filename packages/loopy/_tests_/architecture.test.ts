import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SOURCE = resolve(import.meta.dir, "../src");
const LAYERS = ["core", "runtime", "cloud", "local", "cli"] as const;
type Layer = (typeof LAYERS)[number];

/** Each layer may import only the layers listed, and only through their index.ts. */
const ALLOWED_IMPORTS: Record<Layer, readonly Layer[]> = {
  core: [],
  runtime: ["core"],
  cloud: ["core", "runtime"],
  local: ["core", "runtime"],
  cli: ["core", "runtime", "local"],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function layerOf(file: string): Layer {
  const [layer] = relative(SOURCE, file).split("/");
  if (!LAYERS.includes(layer as Layer)) {
    throw new Error(`${file} is outside the known layers.`);
  }
  return layer as Layer;
}

/** Static imports, re-exports, side-effect imports and literal dynamic imports. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/\b(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}

test("authoring, runtime and cloud exports bundle without host dependencies", async () => {
  const result = await Bun.build({
    entrypoints: ["core", "runtime", "cloud"].map((name) => resolve(SOURCE, `${name}/index.ts`)),
    target: "browser",
  });
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
});

test("layers import downward, and only through the target layer's index", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(SOURCE)) {
    const layer = layerOf(file);
    const name = relative(SOURCE, file);
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = layerOf(resolve(file, "..", specifier));
      if (target === layer) {
        if (specifier.endsWith("/index.js")) {
          violations.push(`${name} imports its own barrel (${specifier}).`);
        }
        continue;
      }
      if (!ALLOWED_IMPORTS[layer].includes(target)) {
        violations.push(`${name} (${layer}) may not import ${target} (${specifier}).`);
      } else if (!specifier.endsWith(`/${target}/index.js`)) {
        violations.push(`${name} must import ${target} through ${target}/index.js (${specifier}).`);
      }
    }
  }
  expect(violations).toEqual([]);
});
