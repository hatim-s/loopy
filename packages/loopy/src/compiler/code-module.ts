import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Expression, type Node, Visitor } from "oxc-parser";
import { isString } from "../core/index.js";
import { diagnostic, parseModule, unwrap } from "./ast.js";
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

function finalName(original: Node): string | undefined {
  const node = unwrap(original);

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
    case "Literal":
      return isString(node.value) ? node.value : undefined;
    default:
      return undefined;
  }
}

function importMetaMember(original: Node): boolean {
  const node = unwrap(original);

  return (
    node.type === "MemberExpression" &&
    node.object.type === "MetaProperty" &&
    node.object.meta.name === "import" &&
    runtimeCode.importMetaCalls.has(finalName(node) ?? "")
  );
}

export function checkImports(file: string, source: string, diagnostics: CompilerDiagnostic[]) {
  const program = parseModule(file, source, diagnostics);
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
  }).visit(program);

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
  }).visit(program);

  return { program, dependencies };
}

export async function checkModuleImports(file: string, diagnostics: CompilerDiagnostic[]) {
  const seen = new Set<string>();

  async function visit(path: string) {
    if (seen.has(path) || path.endsWith(".json")) {
      return;
    }

    seen.add(path);
    const source = await Bun.file(path).text();
    const { program, dependencies } = checkImports(path, source, diagnostics);

    for (const specifier of dependencies) {
      await visit(await modulePath(specifier, path));
    }

    return { source, program };
  }

  return visit(file);
}

export async function checkCodeModule(path: string) {
  const diagnostics: CompilerDiagnostic[] = [];
  const entry = await checkModuleImports(path, diagnostics);

  if (!entry || diagnostics.some((value) => value.code === "syntax_error")) {
    return { ok: false as const, diagnostics };
  }

  const { source, program } = entry;

  const exported = program.body.find((node) => node.type === "ExportDefaultDeclaration");

  if (exported?.type !== "ExportDefaultDeclaration") {
    diagnostics.push(
      diagnostic(
        path,
        source,
        0,
        "module_default",
        "Code modules must default-export one function.",
      ),
    );

    return { ok: false as const, diagnostics };
  }

  let declaration = exported.declaration;

  if (declaration.type === "Identifier") {
    const identifier = declaration.name;

    const named = program.body
      .flatMap((node) => (node.type === "VariableDeclaration" ? node.declarations : []))
      .find((node) => node.id.type === "Identifier" && node.id.name === identifier);

    const fn = program.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === identifier,
    );

    if (fn?.type === "FunctionDeclaration") {
      declaration = fn;
    } else if (
      named?.init?.type === "ArrowFunctionExpression" ||
      named?.init?.type === "FunctionExpression"
    ) {
      declaration = named.init;
    }
  }

  if (
    !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
      declaration.type,
    )
  ) {
    diagnostics.push(
      diagnostic(
        path,
        source,
        0,
        "module_default",
        "Code modules must default-export one function.",
      ),
    );

    return { ok: false as const, diagnostics };
  }

  return diagnostics.length > 0
    ? { ok: false as const, diagnostics }
    : { ok: true as const, diagnostics };
}
