import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const SOURCE = resolve(import.meta.dir, "../src");

const STUDIO = resolve(import.meta.dir, "../../../apps/studio/src");

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

    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function layerOf(file: string): Layer {
  const [layer] = relative(SOURCE, file).split("/");

  const matched = LAYERS.find((candidate) => candidate === layer);

  if (matched === undefined) {
    throw new Error(`${file} is outside the known layers.`);
  }

  return matched;
}

/** Static imports, re-exports, side-effect imports and literal dynamic imports, from the AST. */
function importsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return specifiers;
}

/** True for `./index`, `./index.js` and `./index.ts` alike. */
function isBarrel(specifier: string): boolean {
  return /\/index(\.[jt]s)?$/.test(specifier);
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
      if (specifier === "loopy" || specifier.startsWith("loopy/")) {
        violations.push(`${name} imports the package through its own alias (${specifier}).`);
        continue;
      }

      if (!specifier.startsWith(".")) {
        continue;
      }

      const target = layerOf(resolve(file, "..", specifier));

      if (target === layer) {
        if (isBarrel(specifier)) {
          violations.push(`${name} imports its own barrel (${specifier}).`);
        }

        continue;
      }

      if (!ALLOWED_IMPORTS[layer].includes(target)) {
        violations.push(`${name} (${layer}) may not import ${target} (${specifier}).`);
      } else if (!isBarrel(specifier)) {
        violations.push(`${name} must import ${target} through ${target}/index.js (${specifier}).`);
      }
    }
  }

  expect(violations).toEqual([]);
});

test("studio reaches the package only through the portable 'loopy' entry", () => {
  const violations: string[] = [];

  for (const file of sourceFiles(STUDIO)) {
    const name = relative(STUDIO, file);

    for (const specifier of importsOf(file)) {
      if (specifier.startsWith("loopy/")) {
        violations.push(`${name} imports a non-portable entry (${specifier}).`);
      } else if (
        specifier.startsWith(".") &&
        relative(STUDIO, resolve(file, "..", specifier)).startsWith("..")
      ) {
        violations.push(`${name} reaches outside the app (${specifier}).`);
      }
    }
  }

  expect(violations).toEqual([]);
});
