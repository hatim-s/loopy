import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Expression, type Node, parseSync, Visitor } from "oxc-parser";
import { isString } from "../core/index.js";
import { diagnostic } from "./diagnostic.js";
import type { CompilerDiagnostic } from "./types.js";

export async function modulePath(specifier: string, file: string) {
  const path = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : resolve(dirname(file), specifier);

  for (const candidate of [
    path,
    path.replace(/\.js$/, ".ts"),
    ...[".ts", ".tsx", ".js", "/index.ts", "/index.js"].map((suffix) => path + suffix),
  ]) {
    if (await Bun.file(candidate).exists()) {
      return realpath(candidate);
    }
  }

  return path;
}

export function checkImports(file: string, source: string, diagnostics: CompilerDiagnostic[]) {
  const parsed = parseSync(file, source, { sourceType: "module" });
  const dependencies: string[] = [];

  for (const error of parsed.errors) {
    diagnostics.push(
      diagnostic(file, source, error.labels[0]?.start ?? 0, "syntax_error", error.message),
    );
  }

  const dependency = (value: string) => {
    if (value.startsWith(".") || isAbsolute(value) || value.startsWith("file:")) {
      dependencies.push(value);
    }
  };

  const dynamic = (node: Node, specifier: Expression | undefined) => {
    if (specifier?.type === "Literal" && isString(specifier.value)) {
      dependency(specifier.value);

      return;
    }

    diagnostics.push(
      diagnostic(
        file,
        source,
        node.start,
        "dynamic_import",
        "Use a literal module specifier for import() and require().",
      ),
    );
  };

  // Bun rewrites require() to a binding initialized from import.meta.require.
  const requires = new Set(["require"]);
  new Visitor({
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier" &&
        node.init?.type === "MemberExpression" &&
        node.init.object.type === "MetaProperty" &&
        node.init.object.meta.name === "import" &&
        node.init.property.type === "Identifier" &&
        node.init.property.name === "require"
      ) {
        requires.add(node.id.name);
      }
    },
  }).visit(parsed.program);

  const generatedCode = (node: Node) => {
    diagnostics.push(
      diagnostic(
        file,
        source,
        node.start,
        "dynamic_import",
        "Use bundled modules instead of eval() or Function().",
      ),
    );
  };

  new Visitor({
    ImportDeclaration(node) {
      if (node.importKind !== "type") {
        dependency(node.source.value);
      }
    },
    ExportNamedDeclaration(node) {
      if (node.source && node.exportKind !== "type") {
        dependency(node.source.value);
      }
    },
    ExportAllDeclaration(node) {
      if (node.exportKind !== "type") {
        dependency(node.source.value);
      }
    },
    ImportExpression(node) {
      dynamic(node, node.source);
    },
    CallExpression(node) {
      if (node.callee.type === "Identifier" && requires.has(node.callee.name)) {
        const argument = node.arguments[0];
        dynamic(node, argument?.type === "SpreadElement" ? undefined : argument);
      }

      if (node.callee.type === "Identifier" && ["eval", "Function"].includes(node.callee.name)) {
        generatedCode(node);
      }
    },
    NewExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "Function") {
        generatedCode(node);
      }
    },
  }).visit(parsed.program);

  return dependencies;
}

export async function checkModuleImports(
  file: string,
  diagnostics: CompilerDiagnostic[],
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(file) || file.endsWith(".json")) {
    return;
  }

  seen.add(file);
  const source = await Bun.file(file).text();

  for (const specifier of checkImports(file, source, diagnostics)) {
    await checkModuleImports(await modulePath(specifier, file), diagnostics, seen);
  }
}
