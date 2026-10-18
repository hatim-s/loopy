import { parseSync } from "oxc-parser";
import { diagnostic } from "./diagnostic.js";
import { checkModuleImports } from "./module-imports.js";
import type { CompilerDiagnostic } from "./types.js";

export async function checkCodeModule(path: string) {
  const diagnostics: CompilerDiagnostic[] = [];
  await checkModuleImports(path, diagnostics);
  const source = await Bun.file(path).text();
  const { program, errors } = parseSync(path, source, { sourceType: "module" });

  if (errors.length > 0) {
    return { ok: false as const, diagnostics };
  }

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
