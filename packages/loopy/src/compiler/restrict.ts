import { dirname, resolve } from "node:path";
import { type Expression, parseSync, type Statement } from "oxc-parser";
import { MAX_SOURCE_BYTES, MAX_SOURCE_FILES } from "../contract/index.js";
import { builtinCommandKeys } from "../sdk/graph-host.js";
import {
  type Context,
  callable,
  declarationKind,
  expressionRule,
  literal,
  name,
  refuse,
  type Scope,
  unwrap,
} from "./ast.js";
import { diagnostic } from "./diagnostic.js";
import { checkCodeModule } from "./module.js";
import { modulePath } from "./module-imports.js";
import type { AuthorModule, CompilerDiagnostic, ParserSource, Restricted } from "./types.js";

function parserSource(context: Context, node: Expression) {
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    parserSource(context, node.expression);

    return;
  }

  if (node.type !== "CallExpression" || callable(node.callee, context.scope) !== "defineCommand") {
    return;
  }

  const argument = node.arguments[0];
  const descriptor = argument && argument.type !== "SpreadElement" ? unwrap(argument) : argument;

  if (descriptor?.type !== "ObjectExpression") {
    refuse(context, node, "command_descriptor", "defineCommand requires a literal descriptor.");

    return;
  }

  const properties = descriptor.properties.filter((property) => property.type === "Property");
  const parser = properties.find((property) => name(property.key) === "parse");

  if (!parser) {
    return;
  }

  const key = properties.find((property) => name(property.key) === "key");
  const namespace = properties.find((property) => name(property.key) === "namespace");
  const command = properties.find((property) => name(property.key) === "name");

  const id = key
    ? literal(context, key.value, "command_key")
    : `${literal(context, namespace?.value, "command_key")}.${literal(context, command?.value, "command_key")}`;

  if (id !== null) {
    if (context.parsers.has(id) || builtinCommandKeys.includes(id)) {
      refuse(
        context,
        node,
        "command_key",
        "Custom parser keys must be unique and cannot replace built-in commands.",
      );
    }

    const path = literal(context, parser.value, "module_path");

    if (path !== null) {
      context.parsers.set(id, { file: resolve(dirname(context.file), path) });
    }
  }
}

function declarations(statement: Statement) {
  return statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
}

type Inspection = {
  modules: Map<string, AuthorModule>;
  parsers: Map<string, ParserSource>;
  diagnostics: CompilerDiagnostic[];
  scopes: Map<string, Scope>;
  entry: string;
  sourceBytes: number;
};

function importBindings(
  context: Context,
  statement: Extract<Statement, { type: "ImportDeclaration" }>,
  sdk: boolean,
  imported: Scope,
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

    // SDK aliases would hide literal positions and callback roles from this pass.
    if (sdk && item.local.name !== original) {
      refuse(context, item, "sdk_alias", "Import SDK exports under their original names.");
    }

    const binding = sdk ? "sdk" : (imported.get(original) ?? "function");

    if (binding === "sdk" && item.local.name !== original) {
      refuse(context, item, "sdk_alias", "Keep SDK names unchanged across author modules.");
    }

    context.scope.set(item.local.name, binding);
  }
}

async function inspectImports(context: Context, statements: Statement[], state: Inspection) {
  const { file } = context;
  const { scopes, modules } = state;

  for (const statement of statements) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") {
      continue;
    }

    const specifier = statement.source.value;

    const sdk =
      specifier === "loopy" ||
      specifier === "loopy/graph" ||
      resolve(dirname(file), specifier) === resolve(import.meta.dir, "../sdk/index.ts") ||
      resolve(dirname(file), specifier) === resolve(import.meta.dir, "../sdk/index.js") ||
      resolve(dirname(file), specifier) === resolve(import.meta.dir, "../sdk/graph/index.ts") ||
      resolve(dirname(file), specifier) === resolve(import.meta.dir, "../sdk/graph/index.js");

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

    importBindings(context, statement, sdk, imported);
  }
}

function inspectConstants(
  context: Context,
  declarations: Extract<Statement, { type: "VariableDeclaration" }>["declarations"],
) {
  for (const declaration of declarations) {
    if (
      declaration.id.type !== "Identifier" ||
      !declaration.init ||
      context.scope.has(declaration.id.name)
    ) {
      refuse(context, declaration, "invalid_binding", "Use unique const declarations.");
      continue;
    }

    expressionRule(context, declaration.init, context.scope);
    parserSource(context, declaration.init);
    const kind = declarationKind(declaration.init, context.scope);
    context.scope.set(declaration.id.name, kind);
  }
}

function defaultExport(
  context: Context,
  statement: Extract<Statement, { type: "ExportDefaultDeclaration" }>,
  requireLoopy: boolean,
) {
  const expression = statement.declaration;

  if (
    expression.type === "FunctionDeclaration" ||
    expression.type === "ClassDeclaration" ||
    expression.type === "TSInterfaceDeclaration"
  ) {
    refuse(context, statement, "default_loopy", "Default-export a loopy() builder result.");

    return;
  }

  if (requireLoopy && declarationKind(expression, context.scope) !== "graph") {
    refuse(context, statement, "default_loopy", "Default-export a loopy() builder result.");
  }

  expressionRule(context, expression, context.scope);
}

function inspectStatements(context: Context, statements: Statement[], requireLoopy: boolean) {
  for (const statement of statements) {
    const node = declarations(statement);

    if (
      statement.type === "ExportAllDeclaration" ||
      (statement.type === "ExportNamedDeclaration" && statement.source)
    ) {
      refuse(
        context,
        statement,
        "module_import",
        "Import and export author bindings explicitly without re-exports.",
      );
      continue;
    }

    if (
      !node ||
      statement.type === "ImportDeclaration" ||
      ["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSDeclareFunction"].includes(node.type)
    ) {
      continue;
    }

    if (node.type === "FunctionDeclaration") {
      if (node.id) {
        context.scope.set(node.id.name, "function");
      }

      continue;
    }

    if (node.type === "VariableDeclaration" && node.kind === "const") {
      inspectConstants(context, node.declarations);
    } else if (statement.type === "ExportDefaultDeclaration") {
      defaultExport(context, statement, requireLoopy);
    } else {
      refuse(
        context,
        statement,
        "module_effect",
        "Builder modules allow imports, immutable data, descriptors and subgraphs only.",
      );
    }
  }
}

async function inspectModule(file: string, state: Inspection): Promise<Scope> {
  const { modules, parsers, diagnostics, scopes } = state;
  const input = Bun.file(file);

  if (modules.size >= MAX_SOURCE_FILES) {
    throw new Error("Builder source must fit within 32 files.");
  }

  const source = await input.slice(0, MAX_SOURCE_BYTES - state.sourceBytes + 1).text();
  state.sourceBytes += Buffer.byteLength(source);

  if (state.sourceBytes > MAX_SOURCE_BYTES) {
    throw new Error("Builder source must fit within 256 KiB.");
  }

  const parsed = parseSync(file, source, { sourceType: "module", preserveParens: false });

  for (const error of parsed.errors) {
    diagnostics.push(
      diagnostic(file, source, error.labels[0]?.start ?? 0, "syntax_error", error.message),
    );
  }

  const scope: Scope = new Map();
  modules.set(file, { file, source, evaluated: source });

  const context: Context = {
    file,
    source,
    scope,
    diagnostics,
    edits: [],
    parsers,
    sourceCalls: [],
  };

  await inspectImports(context, parsed.program.body, state);

  for (const statement of parsed.program.body) {
    const node = declarations(statement);

    if (node?.type === "FunctionDeclaration" && node.id) {
      scope.set(node.id.name, "function");
    }
  }

  inspectStatements(context, parsed.program.body, file === state.entry);

  if (
    file === state.entry &&
    !parsed.program.body.some((statement) => statement.type === "ExportDefaultDeclaration")
  ) {
    diagnostics.push(
      diagnostic(file, source, 0, "default_loopy", "Default-export a loopy() builder result."),
    );
  }

  for (const edit of context.edits) {
    // BOUNDARY: The edit text was produced by JSON.stringify from a resolved module path.
    const modulePath: string = JSON.parse(edit.text);

    const checked = await checkCodeModule(modulePath);
    diagnostics.push(...checked.diagnostics);
  }

  const evaluated = context.edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);

  modules.set(file, { file, source, evaluated, sourceCalls: context.sourceCalls });
  scopes.set(file, scope);

  return scope;
}

export async function restrict(
  file: string,
): Promise<Restricted | { ok: false; diagnostics: CompilerDiagnostic[] }> {
  const modules = new Map<string, AuthorModule>();
  const parsers = new Map<string, ParserSource>();
  const diagnostics: CompilerDiagnostic[] = [];
  await inspectModule(file, {
    modules,
    parsers,
    diagnostics,
    scopes: new Map(),
    entry: file,
    sourceBytes: 0,
  });

  for (const parser of parsers.values()) {
    const checked = await checkCodeModule(parser.file);
    diagnostics.push(...checked.diagnostics);
  }

  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, modules: [...modules.values()], parsers };
}
