import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Schema } from "effect";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../../..");

const PACKAGES = ["core", "contract", "sdk", "runtime", "compiler", "cli", "loopy"] as const;

type Package = (typeof PACKAGES)[number];

const ALLOWED: Record<Package, readonly Package[]> = {
  core: [],
  contract: ["core"],
  sdk: ["core"],
  runtime: ["core", "contract", "sdk"],
  compiler: ["core", "contract", "sdk", "runtime"],
  cli: ["core", "contract", "sdk", "runtime", "compiler"],
  loopy: ["core", "contract", "sdk", "runtime", "compiler", "cli"],
};

const RUNTIME_LAYERS = ["host", "store", "executor", "service", "local"] as const;

type RuntimeLayer = (typeof RUNTIME_LAYERS)[number];

const RUNTIME_IMPORTS: Record<RuntimeLayer, readonly RuntimeLayer[]> = {
  host: [],
  store: [],
  executor: ["local"],
  service: [],
  local: ["host", "store", "executor", "service"],
};

interface Manifest {
  name: string;
  private?: boolean;
  exports: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function packageRoot(owner: Package): string {
  return join(ROOT, "packages", owner);
}

function sourceRoot(owner: Package): string {
  return join(packageRoot(owner), "src");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function ownerOf(file: string): Package | undefined {
  return PACKAGES.find((owner) => {
    const path = relative(sourceRoot(owner), file);

    return path !== ".." && !path.startsWith("../") && !path.startsWith("/");
  });
}

function importsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const imports: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      imports.push(node.argument.literal.text);
    } else if (
      ts.isExternalModuleReference(node) &&
      node.expression &&
      ts.isStringLiteralLike(node.expression)
    ) {
      imports.push(node.expression.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return imports;
}

function resolveImport(file: string, specifier: string): string {
  const path = resolve(dirname(file), specifier);

  const target = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    join(path, "index.ts"),
    join(path, "index.tsx"),
  ].find((candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate));

  if (!target) {
    throw new Error(`${relative(ROOT, file)} has an unresolved import (${specifier}).`);
  }

  return target;
}

function workspaceImport(specifier: string) {
  const owner = PACKAGES.find((candidate) => {
    const name = candidate === "loopy" ? "loopy" : `@loopy/${candidate}`;

    return specifier === name || specifier.startsWith(`${name}/`);
  });

  if (!owner) {
    return undefined;
  }

  const name = owner === "loopy" ? "loopy" : `@loopy/${owner}`;

  return { owner, key: specifier === name ? "." : `.${specifier.slice(name.length)}` };
}

function runtimeViolations(file: string, target: string): string[] {
  const root = sourceRoot("runtime");

  const layer = RUNTIME_LAYERS.find((candidate) =>
    relative(root, file).startsWith(`${candidate}/`),
  );

  const targetLayer = RUNTIME_LAYERS.find((candidate) =>
    relative(root, target).startsWith(`${candidate}/`),
  );

  if (!layer || !targetLayer || layer === targetLayer) {
    return [];
  }

  if (!RUNTIME_IMPORTS[layer].includes(targetLayer)) {
    return [`${relative(ROOT, file)} may not import runtime ${targetLayer}.`];
  }

  if (
    target !== join(root, targetLayer, "index.ts") &&
    !(layer === "executor" && target === join(root, "local/execution-host.ts"))
  ) {
    return [`${relative(ROOT, file)} must import runtime ${targetLayer} through its barrel.`];
  }

  return [];
}

test("workspace source imports follow package ownership and explicit exports", () => {
  const violations: string[] = [];

  for (const owner of PACKAGES) {
    const config = manifest(packageRoot(owner));

    for (const file of sourceFiles(sourceRoot(owner))) {
      for (const specifier of importsOf(file)) {
        const name = relative(ROOT, file);

        if (specifier.startsWith(".")) {
          const target = resolveImport(file, specifier);

          if (ownerOf(target) !== owner) {
            violations.push(`${name} crosses a package through ${specifier}.`);
          }

          if (/\.[jt]sx?$|(?:^|\/)index$/.test(specifier)) {
            violations.push(`${name} must omit extensions and index filenames (${specifier}).`);
          }

          if (
            owner === "core" &&
            !relative(sourceRoot(owner), file).startsWith("engine/") &&
            relative(sourceRoot(owner), target).startsWith("engine/")
          ) {
            violations.push(`${name} may not import the engine layer.`);
          }

          if (owner === "runtime") {
            violations.push(...runtimeViolations(file, target));
          }

          continue;
        }

        const imported = workspaceImport(specifier);

        if (!imported) {
          if (specifier.startsWith("@loopy/") || specifier.startsWith("@/")) {
            violations.push(`${name} imports an unknown workspace alias (${specifier}).`);
          }

          continue;
        }

        if (!ALLOWED[owner].includes(imported.owner)) {
          violations.push(`${name} may not import ${imported.owner} (${specifier}).`);
        }

        if (!Object.hasOwn(manifest(packageRoot(imported.owner)).exports, imported.key)) {
          violations.push(`${name} imports an undeclared export (${specifier}).`);
        }

        if (
          (owner === "loopy" ? config.devDependencies : config.dependencies)?.[
            `@loopy/${imported.owner}`
          ] !== "workspace:*"
        ) {
          violations.push(`${name} needs a declared workspace dependency for ${specifier}.`);
        }
      }
    }
  }

  expect(violations).toEqual([]);
});

test("private manifests expose explicit existing source entries and declare the package DAG", () => {
  const violations: string[] = [];
  const root = manifest(ROOT);

  for (const owner of PACKAGES.filter((candidate) => candidate !== "loopy")) {
    const config = manifest(packageRoot(owner));

    if (config.name !== `@loopy/${owner}` || config.private !== true) {
      violations.push(`${owner} must be a private @loopy package.`);
    }

    if (root.devDependencies?.[config.name] !== "workspace:*") {
      violations.push(`Root tests need ${config.name} as a workspace dependency.`);
    }

    const exports = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
      config.exports,
    );

    for (const [key, entry] of Object.entries(exports)) {
      const targets = [entry];

      if (
        key.includes("*") ||
        targets.some(
          (target) =>
            target.includes("*") ||
            !target.startsWith("./src/") ||
            !existsSync(resolve(packageRoot(owner), target)),
        )
      ) {
        violations.push(`${owner} has an invalid explicit source export (${key}).`);
      }
    }

    for (const [name, version] of Object.entries(config.dependencies ?? {})) {
      if (!name.startsWith("@loopy/")) {
        continue;
      }

      const target = workspaceImport(name);

      if (!target || !ALLOWED[owner].includes(target.owner) || version !== "workspace:*") {
        violations.push(`${owner} declares an invalid workspace dependency (${name}).`);
      }
    }
  }

  expect(
    Object.keys(manifest(packageRoot("loopy")).dependencies ?? {}).filter((name) =>
      name.startsWith("@loopy/"),
    ),
  ).toEqual([]);
  expect(violations).toEqual([]);
});

test("apps use public workspace exports and dashboard uses only contract", () => {
  const violations: string[] = [];

  for (const app of ["dashboard", "cloud", "sandbox"]) {
    const root = join(ROOT, "apps", app, "src");
    const config = manifest(join(ROOT, "apps", app));

    for (const file of sourceFiles(root)) {
      for (const specifier of importsOf(file)) {
        const imported = workspaceImport(specifier);

        if (imported) {
          const target = manifest(packageRoot(imported.owner));

          if (
            !Object.hasOwn(target.exports, imported.key) ||
            (app === "dashboard" && imported.owner !== "contract")
          ) {
            violations.push(
              `${relative(ROOT, file)} imports a forbidden package entry (${specifier}).`,
            );
          }

          if (config.dependencies?.[target.name] !== "workspace:*") {
            violations.push(`${app} must declare ${target.name} as a workspace dependency.`);
          }
        } else if (
          specifier.startsWith(".") &&
          /packages\//.test(relative(ROOT, resolve(dirname(file), specifier)))
        ) {
          violations.push(`${relative(ROOT, file)} reaches package source (${specifier}).`);
        }
      }
    }
  }

  expect(violations).toEqual([]);
});

test("portable entries bundle without host dependencies", async () => {
  const result = await Bun.build({
    entrypoints: [
      join(sourceRoot("core"), "index.ts"),
      join(sourceRoot("core"), "engine/index.ts"),
      join(sourceRoot("contract"), "index.ts"),
      join(sourceRoot("runtime"), "service/index.ts"),
    ],
    target: "browser",
  });

  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
});
