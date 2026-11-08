import type { Statement } from "oxc-parser";
import { type Context, declarationKind, refuse } from "./ast";
import { expressionRule } from "./rules";

export const DEFAULT_LOOPY = "Default-export a loopy() builder result.";

export function declarations(statement: Statement) {
  return statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
}

function inspectConstants(
  context: Context,
  bindings: Extract<Statement, { type: "VariableDeclaration" }>["declarations"],
) {
  for (const declaration of bindings) {
    if (
      declaration.id.type !== "Identifier" ||
      !declaration.init ||
      context.scope.has(declaration.id.name)
    ) {
      refuse(context, declaration, "invalid_binding", "Use unique const declarations.");
      continue;
    }

    expressionRule(context, declaration.init, context.scope);
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

  const declared =
    expression.type === "FunctionDeclaration" ||
    expression.type === "ClassDeclaration" ||
    expression.type === "TSInterfaceDeclaration";

  if (declared || (requireLoopy && declarationKind(expression, context.scope) !== "graph")) {
    refuse(context, statement, "default_loopy", DEFAULT_LOOPY);
  }

  if (!declared) {
    expressionRule(context, expression, context.scope);
  }
}

export function inspectStatements(
  context: Context,
  statements: Statement[],
  requireLoopy: boolean,
) {
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
