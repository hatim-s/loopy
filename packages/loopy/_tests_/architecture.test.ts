import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const SOURCE = resolve(import.meta.dir, "../src");

const DASHBOARD = resolve(import.meta.dir, "../../../apps/dashboard/src");

const LAYERS = [
  "core",
  "engine",
  "host",
  "store",
  "executor",
  "contract",
  "sdk",
  "local",
  "service",
  "compiler",
  "cli",
] as const;

type Layer = (typeof LAYERS)[number];

/** Each layer may import only the layers listed, and only through their index.ts. */
const ALLOWED_IMPORTS: Record<Layer, readonly Layer[]> = {
  core: [],
  engine: ["core"],
  host: ["core", "engine"],
  store: ["core", "contract"],
  executor: ["core", "contract", "local"],
  contract: ["core"],
  service: ["core", "contract"],
  local: ["core", "engine", "host", "store", "executor", "sdk", "contract", "service"],
  sdk: ["core"],
  cli: ["core", "engine", "host", "store", "executor", "local", "sdk", "contract", "compiler"],
  compiler: ["core", "contract", "local", "sdk"],
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

function resolveImport(file: string, specifier: string): string {
  const path = resolve(file, "..", specifier);

  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    join(path, "index.ts"),
    join(path, "index.tsx"),
  ];

  const target = candidates.find((candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate));

  if (target === undefined) {
    throw new Error(`${file} has an unresolved internal import (${specifier}).`);
  }

  return target;
}

function isBarrel(file: string): boolean {
  return LAYERS.some((layer) => file === join(SOURCE, layer, "index.ts"));
}

test("core, engine and contract exports bundle without host dependencies", async () => {
  const result = await Bun.build({
    entrypoints: ["core", "engine", "contract", "service"].map((name) =>
      resolve(SOURCE, `${name}/index.ts`),
    ),
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
        if (
          (layer === "core" || layer === "engine" || layer === "contract") &&
          specifier !== "effect"
        ) {
          violations.push(`${name} may only import relative specifiers (${specifier}).`);
        }

        if (layer === "sdk") {
          violations.push(`${name} may only import core (${specifier}).`);
        }

        continue;
      }

      const resolved = resolveImport(file, specifier);
      const target = layerOf(resolved);

      if (target === layer) {
        if (
          isBarrel(resolved) &&
          !(
            (name === "sdk/graph-host.ts" || name === "sdk/index.ts") &&
            resolved === join(SOURCE, "sdk/graph/index.ts")
          )
        ) {
          violations.push(`${name} imports its own barrel (${specifier}).`);
        }

        continue;
      }

      if (!ALLOWED_IMPORTS[layer].includes(target)) {
        violations.push(`${name} (${layer}) may not import ${target} (${specifier}).`);
      } else if (
        target === "sdk"
          ? !["sdk/host.ts", "sdk/graph-host.ts"].includes(relative(SOURCE, resolved))
          : !isBarrel(resolved) &&
            !(layer === "executor" && resolved === join(SOURCE, "local/execution-host.ts"))
      ) {
        violations.push(
          `${name} must import ${target} through ${target === "sdk" ? "sdk/host" : target} (${specifier}).`,
        );
      }
    }
  }

  expect(violations).toEqual([]);
});

test("the dashboard reaches the package only through the contract entry", () => {
  const violations: string[] = [];

  for (const file of sourceFiles(DASHBOARD)) {
    const name = relative(DASHBOARD, file);

    for (const specifier of importsOf(file)) {
      if (specifier === "loopy" || specifier.startsWith("loopy/")) {
        violations.push(`${name} imports the package through its alias (${specifier}).`);
      } else if (specifier.startsWith(".") && !/\.(?:css|svg|png)$/.test(specifier)) {
        const target = resolveImport(file, specifier);
        const outsideApp = relative(DASHBOARD, target).startsWith("..");

        if (outsideApp && target !== join(SOURCE, "contract/index.ts")) {
          violations.push(`${name} reaches outside the contract entry (${specifier}).`);
        }
      }
    }
  }

  expect(violations).toEqual([]);
});
