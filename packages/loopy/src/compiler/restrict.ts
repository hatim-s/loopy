import type { Statement } from "oxc-parser";
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
import type { AuthorModule, CompilerDiagnostic, ParserSource, Restricted } from "./types.js";

type Inspection = {
  modules: Map<string, AuthorModule>;
  parsers: Map<string, ParserSource>;
  diagnostics: CompilerDiagnostic[];
  scopes: Map<string, Scope>;
  entry: string;
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
      refuse(context, item, "module_import", "Use named SDK and author imports.");
      continue;
    }

    const original = name(item.imported) ?? "";

    const binding = imported === "sdk" ? "sdk" : (imported.get(original) ?? "function");

    if (binding === "sdk" && item.local.name !== original) {
      refuse(context, item, "sdk_alias", "Keep SDK names unchanged across author modules.");
    }

    context.scope.set(item.local.name, binding);
  }
}

async function isSdkSpecifier(specifier: string, file: string) {
  if (specifier === "loopy" || specifier === "loopy/graph") {
    return true;
  }

  const path = await modulePath(specifier, file);

  return path === sdkEntry || path === sdkEntry.replace("/graph/index.", "/index.");
}

async function inspectImports(context: Context, statements: Statement[], state: Inspection) {
  const { file } = context;
  const { scopes, modules } = state;

  for (const statement of statements) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") {
      continue;
    }

    const specifier = statement.source.value;

    const sdk = await isSdkSpecifier(specifier, file);

    let imported: Scope = new Map();

    if (!sdk) {
      if (!specifier.startsWith(".")) {
        refuse(
          context,
          statement,
          "module_import",
          "Builder imports must be loopy, loopy/graph or relative author modules.",
        );
        continue;
      }

      const dependency = await modulePath(specifier, file);

      if (scopes.has(dependency)) {
        imported = scopes.get(dependency) ?? new Map();
      } else if (modules.has(dependency)) {
        refuse(context, statement, "cyclic_import", "Builder imports cannot be cyclic.");
        continue;
      } else {
        imported = await inspectModule(dependency, state);
      }
    }

    importBindings(context, statement, sdk ? "sdk" : imported);
  }
}

async function inspectModule(file: string, state: Inspection): Promise<Scope> {
  const { modules, parsers, diagnostics, scopes } = state;
  const source = await Bun.file(file).text();
  const program = parseModule(file, source, diagnostics);

  const scope: Scope = new Map();
  modules.set(file, { file, source, evaluated: source });

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

    diagnostics.push(
      diagnostic(
        file,
        source,
        exported?.start ?? 0,
        "default_loopy",
        "Default-export a loopy() builder result.",
      ),
    );
  }

  for (const edit of context.edits) {
    // BOUNDARY: The edit text was produced by JSON.stringify from a resolved module path.
    const modulePath: string = JSON.parse(edit.text);

    const checked = await checkCodeModule(modulePath);
    diagnostics.push(...checked.diagnostics);
  }

  const evaluated = applyEdits(source, context.edits);

  modules.set(file, { file, source, evaluated });
  scopes.set(file, scope);

  return scope;
}

export async function restrict(
  file: string,
): Promise<Restricted | { ok: false; diagnostics: CompilerDiagnostic[] }> {
  const modules = new Map<string, AuthorModule>();
  const parsers = new Map<string, ParserSource>();
  const diagnostics: CompilerDiagnostic[] = [];
  await inspectModule(file, { modules, parsers, diagnostics, scopes: new Map(), entry: file });

  for (const parser of parsers.values()) {
    const checked = await checkCodeModule(parser.file);
    diagnostics.push(...checked.diagnostics);
  }

  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, modules: [...modules.values()], parsers };
}
