import { realpath } from "node:fs/promises";
import type { Statement } from "oxc-parser";
import { errorMessage } from "../core/index.js";
import {
  type Context,
  declarations,
  diagnostic,
  inspectStatements,
  name,
  parseModule,
  refuse,
  type Scope,
} from "./ast.js";
import { checkCodeModule, modulePath } from "./code-module.js";
import { sdkEntry } from "./evaluate.js";
import { applyEdits } from "./source.js";
import type { AuthorModule, CompilerDiagnostic, Restricted } from "./types.js";

type Inspection = {
  modules: Map<string, AuthorModule>;
  parsers: Map<string, string>;
  diagnostics: CompilerDiagnostic[];
  scopes: Map<string, Scope>;
  entry: string;
  visiting: Set<string>;
};

function importBindings(
  context: Context,
  statement: Extract<Statement, { type: "ImportDeclaration" }>,
  imported: Scope | "sdk",
) {
  for (const item of statement.specifiers) {
    if (item.type === "ImportSpecifier" && item.importKind === "type") {
      continue;
    }

    if (item.type !== "ImportSpecifier") {
      refuse(context, item, "module_import");
      continue;
    }

    const original = name(item.imported) ?? "";

    const binding = imported === "sdk" ? "sdk" : (imported.get(original) ?? "function");

    if (binding === "sdk" && item.local.name !== original) {
      refuse(context, item, "sdk_alias");
    }

    context.scope.set(item.local.name, binding);
  }
}

async function isSdkSpecifier(specifier: string, file: string) {
  if (specifier === "loopy") {
    return true;
  }

  const path = await modulePath(specifier, file);

  return path === sdkEntry;
}

async function inspectImports(context: Context, statements: Statement[], state: Inspection) {
  const { file } = context;
  const { scopes, visiting } = state;

  for (const statement of statements) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") {
      continue;
    }

    const specifier = statement.source.value;

    const sdk = await isSdkSpecifier(specifier, file);

    let imported: Scope = new Map();

    if (!sdk) {
      if (!specifier.startsWith(".")) {
        refuse(context, statement, "module_import");
        continue;
      }

      const dependency = await modulePath(specifier, file);

      if (scopes.has(dependency)) {
        imported = scopes.get(dependency) ?? new Map();
      } else if (visiting.has(dependency)) {
        refuse(context, statement, "cyclic_import");
        continue;
      } else {
        imported = await inspectModule(dependency, state);
      }
    }

    importBindings(context, statement, sdk ? "sdk" : imported);
  }
}

async function inspectModule(file: string, state: Inspection): Promise<Scope> {
  const { modules, parsers, diagnostics, scopes, visiting } = state;
  const source = await Bun.file(file).text();
  const program = parseModule(file, source, diagnostics);

  const scope: Scope = new Map();
  visiting.add(file);

  const context: Context = {
    file,
    source,
    scope,
    diagnostics,
    edits: [],
    parsers,
  };

  await inspectImports(context, program.body, state);

  for (const statement of program.body) {
    const node = declarations(statement);

    if (node?.type === "FunctionDeclaration" && node.id) {
      scope.set(node.id.name, "function");
    }
  }

  const defaultKind = inspectStatements(context, program.body);

  if (file === state.entry && defaultKind !== "graph") {
    const exported = program.body.find(
      (statement) => statement.type === "ExportDefaultDeclaration",
    );

    diagnostics.push(diagnostic({ file, source }, exported?.start ?? 0, "default_loopy"));
  }

  for (const edit of context.edits) {
    diagnostics.push(...(await checkCodeModule(edit.path)));
  }

  const evaluated = applyEdits(source, context.edits);

  visiting.delete(file);
  modules.set(file, { file, evaluated });
  scopes.set(file, scope);

  return scope;
}

export async function restrict(
  file: string,
): Promise<Restricted | { ok: false; diagnostics: CompilerDiagnostic[] }> {
  try {
    const modules = new Map<string, AuthorModule>();
    const parsers = new Map<string, string>();
    const diagnostics: CompilerDiagnostic[] = [];
    const entry = await realpath(file);
    await inspectModule(entry, {
      modules,
      parsers,
      diagnostics,
      scopes: new Map(),
      entry,
      visiting: new Set(),
    });

    for (const parser of parsers.values()) {
      diagnostics.push(...(await checkCodeModule(parser)));
    }

    return diagnostics.length > 0
      ? { ok: false, diagnostics }
      : { ok: true, modules: [...modules.values()], parsers };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "source_error",
          message: errorMessage(error),
          source: { module: file, line: 1, column: 1 },
        },
      ],
    };
  }
}
