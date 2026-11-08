import { Effect } from "effect";
import { type ParseResult, parseSync } from "oxc-parser";
import { diagnostic } from "./diagnostic";
import { authorSource } from "./errors";
import { checkImports, checkModuleImports, modulePath } from "./module-imports";
import type { CompilerDiagnostic } from "./types";

const FUNCTIONS = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];

function exportsFunction({ program }: ParseResult) {
  const exported = program.body.find((node) => node.type === "ExportDefaultDeclaration");

  if (exported?.type !== "ExportDefaultDeclaration") {
    return false;
  }

  const declaration = exported.declaration;

  if (declaration.type !== "Identifier") {
    return FUNCTIONS.includes(declaration.type);
  }

  const fn = program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === declaration.name,
  );

  const named = program.body
    .flatMap((node) => (node.type === "VariableDeclaration" ? node.declarations : []))
    .find((node) => node.id.type === "Identifier" && node.id.name === declaration.name);

  return (
    fn !== undefined ||
    named?.init?.type === "ArrowFunctionExpression" ||
    named?.init?.type === "FunctionExpression"
  );
}

export const checkCodeModule = Effect.fn(function* (
  path: string,
  diagnostics: CompilerDiagnostic[],
) {
  const source = yield* authorSource("read code module", path, () => Bun.file(path).text());
  const parsed = parseSync(path, source, { sourceType: "module" });
  const seen = new Set([path]);

  for (const specifier of checkImports(path, source, diagnostics, parsed)) {
    yield* checkModuleImports(yield* modulePath(specifier, path), diagnostics, seen);
  }

  if (parsed.errors.length === 0 && !exportsFunction(parsed)) {
    diagnostics.push(
      diagnostic(
        path,
        source,
        0,
        "module_default",
        "Code modules must default-export one function.",
      ),
    );
  }
});
