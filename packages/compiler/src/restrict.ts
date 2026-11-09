import { MAX_SOURCE_BYTES, MAX_SOURCE_FILES } from "@loopy/contract";
import { Effect } from "effect";
import { parseSync, type Statement } from "oxc-parser";
import { type Context, name, refuse, type Scope } from "./ast";
import { diagnostic, syntaxErrors } from "./diagnostic";
import { AuthorDiagnostics, authorFailure, authorSource, type CompilationError } from "./errors";
import { checkCodeModule } from "./module";
import { modulePath } from "./module-imports";
import { DEFAULT_LOOPY, declarations, inspectStatements } from "./statements";
import type { AuthorModule, CompilerDiagnostic } from "./types";

/** The only module specifiers that bind trusted builder calls in author source. */
export const SDK_SPECIFIERS: readonly string[] = ["loopy", "loopy/graph"];

type Inspection = {
  modules: Map<string, AuthorModule>;
  /** Modules whose imports are still being inspected, which an import back to them would cycle. */
  visiting: Set<string>;
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
  const { scopes, visiting } = state;

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
      } else if (visiting.has(dependency)) {
        refuse(context, statement, "cyclic_import", "Builder imports cannot be cyclic.");
        continue;
      } else {
        imported = yield* inspectModule(dependency, state);
      }
    }

    importBindings(context, statement, sdk, imported);
  }
});

function inspectModule(
  file: string,
  state: Inspection,
): Effect.Effect<Scope, CompilationError | AuthorDiagnostics> {
  return Effect.gen(function* () {
    const { modules, visiting, diagnostics, scopes } = state;
    const input = Bun.file(file);

    if (modules.size + visiting.size >= MAX_SOURCE_FILES) {
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
    syntaxErrors(file, source, parsed, diagnostics);
    const scope: Scope = new Map();
    const context: Context = { file, source, scope, diagnostics, modules: [], sourceCalls: [] };
    visiting.add(file);
    yield* inspectImports(context, parsed.program.body, state);
    visiting.delete(file);

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
      diagnostics.push(diagnostic(file, source, 0, "default_loopy", DEFAULT_LOOPY));
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
  const diagnostics: CompilerDiagnostic[] = [];
  yield* inspectModule(file, {
    modules,
    visiting: new Set(),
    diagnostics,
    scopes: new Map(),
    entry: file,
    sourceBytes: 0,
  });

  if (diagnostics.length > 0) {
    return yield* new AuthorDiagnostics({ diagnostics });
  }

  return [...modules.values()];
});
