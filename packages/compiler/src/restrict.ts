import { dirname, resolve } from "node:path";
import { MAX_SOURCE_BYTES, MAX_SOURCE_FILES } from "@loopy/contract";
import { builtinCommandKeys, commandKey } from "@loopy/sdk/graph-host";
import { Effect } from "effect";
import { type Expression, parseSync, type Statement } from "oxc-parser";
import {
  type Context,
  callable,
  declarationKind,
  literal,
  name,
  refuse,
  type Scope,
  unwrap,
} from "./ast";
import { diagnostic } from "./diagnostic";
import { AuthorDiagnostics, authorFailure, authorSource, type CompilationError } from "./errors";
import { checkCodeModule } from "./module";
import { modulePath } from "./module-imports";
import { expressionRule } from "./rules";
import type { AuthorModule, CompilerDiagnostic, ParserSource } from "./types";

/** The only module specifiers that bind trusted builder calls in author source. */
export const SDK_SPECIFIERS: readonly string[] = ["loopy", "loopy/graph"];

function parserSource(context: Context, init: Expression) {
  const node = unwrap(init);

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
  const property = (key: string) => properties.find((entry) => name(entry.key) === key);
  const parser = property("parse");

  if (!parser) {
    return;
  }

  const keyLiteral = (key: string) => literal(context, property(key)?.value, "command_key");
  const key = property("key") ? keyLiteral("key") : null;
  const namespace = key === null ? keyLiteral("namespace") : null;
  const command = key === null ? keyLiteral("name") : null;

  const id =
    key ??
    (namespace === null || command === null ? null : commandKey({ namespace, name: command }));

  if (id === null) {
    return;
  }

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
    context.parsers.set(id, { file: resolve(dirname(context.file), path), exportName: "default" });
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
    const binding = sdk ? "sdk" : (imported.get(original) ?? "function");

    // Aliases would hide literal positions and callback roles from this pass.
    if (binding === "sdk" && item.local.name !== original) {
      refuse(context, item, "sdk_alias", "Import SDK exports under their original names.");
    }

    context.scope.set(item.local.name, binding);
  }
}

const inspectImports = Effect.fn(function* (
  context: Context,
  statements: Statement[],
  state: Inspection,
) {
  const { file } = context;
  const { scopes, modules } = state;

  for (const statement of statements) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") {
      continue;
    }

    const specifier = statement.source.value;
    const sdk = SDK_SPECIFIERS.includes(specifier);
    let imported: Scope = new Map();

    if (!sdk) {
      if (!specifier.startsWith(".")) {
        refuse(
          context,
          statement,
          "module_import",
          "Builder imports must use loopy, loopy/graph or relative author modules.",
        );
        continue;
      }

      const dependency = yield* modulePath(specifier, file);

      if (scopes.has(dependency)) {
        imported = scopes.get(dependency) ?? new Map();
      } else if (modules.has(dependency)) {
        refuse(context, statement, "cyclic_import", "Builder imports cannot be cyclic.");
        continue;
      } else {
        imported = yield* inspectModule(dependency, state);
      }
    }

    importBindings(context, statement, sdk, imported);
  }
});

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

function inspectModule(
  file: string,
  state: Inspection,
): Effect.Effect<Scope, CompilationError | AuthorDiagnostics> {
  return Effect.gen(function* () {
    const { modules, parsers, diagnostics, scopes } = state;
    const input = Bun.file(file);

    if (modules.size >= MAX_SOURCE_FILES) {
      return yield* authorFailure(
        "source_error",
        file,
        `Builder source must fit within ${MAX_SOURCE_FILES} files.`,
      );
    }

    const source = yield* authorSource("read author source", file, () =>
      input.slice(0, MAX_SOURCE_BYTES - state.sourceBytes + 1).text(),
    );

    state.sourceBytes += Buffer.byteLength(source);

    if (state.sourceBytes > MAX_SOURCE_BYTES) {
      return yield* authorFailure(
        "source_error",
        file,
        `Builder source must fit within ${MAX_SOURCE_BYTES / 1024} KiB.`,
      );
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
      modules: [],
      parsers,
      sourceCalls: [],
    };

    yield* inspectImports(context, parsed.program.body, state);

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

    for (const module of context.modules) {
      yield* checkCodeModule(module.path, diagnostics);
    }

    const evaluated = context.modules
      .sort((a, b) => b.start - a.start)
      .reduce(
        (text, module) =>
          text.slice(0, module.start) + JSON.stringify(module.path) + text.slice(module.end),
        source,
      );

    modules.set(file, { file, source, evaluated, sourceCalls: context.sourceCalls });
    scopes.set(file, scope);

    return scope;
  });
}

export const restrict = Effect.fn(function* (file: string) {
  const modules = new Map<string, AuthorModule>();
  const parsers = new Map<string, ParserSource>();
  const diagnostics: CompilerDiagnostic[] = [];
  yield* inspectModule(file, {
    modules,
    parsers,
    diagnostics,
    scopes: new Map(),
    entry: file,
    sourceBytes: 0,
  });

  for (const parser of parsers.values()) {
    yield* checkCodeModule(parser.file, diagnostics);
  }

  if (diagnostics.length > 0) {
    return yield* new AuthorDiagnostics({ diagnostics });
  }

  return { modules: [...modules.values()], parsers };
});
