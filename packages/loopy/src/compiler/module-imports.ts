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

const runtimeCode = {
  literalCalls: new Set(["require", "importSync", "import"]),
  generatedCalls: new Set([
    "eval",
    "Function",
    "AsyncFunction",
    "GeneratorFunction",
    "createRequire",
  ]),
  importMetaCalls: new Set(["require", "resolve"]),
  modules: new Set([
    "vm",
    "node:vm",
    "module",
    "node:module",
    "worker_threads",
    "node:worker_threads",
  ]),
  bunModule: "bun",
  bunMembers: new Set(["plugin", "Transpiler"]),
};

function finalName(node: Node): string | undefined {
  switch (node.type) {
    case "Identifier":
      return node.name;
    case "MemberExpression":
      if (!node.computed && node.property.type === "Identifier") {
        return node.property.name;
      }

      return node.property.type === "Literal" && isString(node.property.value)
        ? node.property.value
        : undefined;
    case "SequenceExpression": {
      const last = node.expressions.at(-1);

      return last && finalName(last);
    }

    case "ChainExpression":
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return finalName(node.expression);
    case "Literal":
      return isString(node.value) ? node.value : undefined;
    default:
      return undefined;
  }
}

function importMetaMember(node: Node): boolean {
  if (node.type === "SequenceExpression") {
    const last = node.expressions.at(-1);

    return last ? importMetaMember(last) : false;
  }

  if (node.type === "ChainExpression" || node.type === "ParenthesizedExpression") {
    return importMetaMember(node.expression);
  }

  return (
    node.type === "MemberExpression" &&
    node.object.type === "MetaProperty" &&
    node.object.meta.name === "import" &&
    runtimeCode.importMetaCalls.has(finalName(node) ?? "")
  );
}

export function checkImports(file: string, source: string, diagnostics: CompilerDiagnostic[]) {
  const parsed = parseSync(file, source, { sourceType: "module" });
  const dependencies: string[] = [];

  const reject = (node: Node) => {
    diagnostics.push(
      diagnostic(
        file,
        source,
        node.start,
        "dynamic_code",
        "Use bundled modules instead of runtime loading or code generation.",
      ),
    );
  };

  for (const error of parsed.errors) {
    diagnostics.push(
      diagnostic(file, source, error.labels[0]?.start ?? 0, "syntax_error", error.message),
    );
  }

  const dependency = (node: Node, value: string) => {
    if (runtimeCode.modules.has(value)) {
      reject(node);
    } else if (value.startsWith(".") || isAbsolute(value) || value.startsWith("file:")) {
      dependencies.push(value);
    }
  };

  const dynamic = (node: Node, specifier: Expression | undefined) => {
    if (specifier?.type === "Literal" && isString(specifier.value)) {
      dependency(node, specifier.value);
    } else {
      reject(node);
    }
  };

  // Bun rewrites require() to a binding initialized from import.meta.require.
  const requires = new Set<string>();
  const bunBindings = new Set(["Bun"]);
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init && importMetaMember(node.init)) {
        requires.add(node.id.name);
      }
    },
  }).visit(parsed.program);

  const call = (node: Extract<Node, { type: "CallExpression" | "NewExpression" }>) => {
    const name = finalName(node.callee) ?? "";

    if (importMetaMember(node.callee) || runtimeCode.generatedCalls.has(name)) {
      reject(node);
    } else if (runtimeCode.literalCalls.has(name) || requires.has(name)) {
      const argument = node.arguments[0];
      dynamic(node, argument?.type === "SpreadElement" ? undefined : argument);
    }
  };

  new Visitor({
    ImportDeclaration(node) {
      if (node.importKind !== "type") {
        dependency(node, node.source.value);

        if (node.source.value === runtimeCode.bunModule) {
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ImportSpecifier") {
              bunBindings.add(specifier.local.name);
            } else if (
              specifier.importKind !== "type" &&
              runtimeCode.bunMembers.has(finalName(specifier.imported) ?? "")
            ) {
              reject(specifier);
            }
          }
        }
      }
    },
    ExportNamedDeclaration(node) {
      if (node.source && node.exportKind !== "type") {
        dependency(node, node.source.value);
      }
    },
    ExportAllDeclaration(node) {
      if (node.exportKind !== "type") {
        dependency(node, node.source.value);
      }
    },
    ImportExpression(node) {
      dynamic(node, node.source);
    },
    MemberExpression(node) {
      if (
        bunBindings.has(finalName(node.object) ?? "") &&
        runtimeCode.bunMembers.has(finalName(node) ?? "")
      ) {
        reject(node);
      }
    },
    CallExpression: call,
    NewExpression: call,
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
