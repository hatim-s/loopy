import { type CompilerDiagnosticCode, isString } from "@loopy/core";
import { COMMAND_CALL, sdkCalls } from "@loopy/sdk/graph-host";
import type { Expression, Node } from "oxc-parser";
import { diagnostic } from "./diagnostic";
import type { CompilerDiagnostic, ParserSource, SourceCall } from "./types";

type Binding = "sdk" | "subgraph" | "command" | "value" | "ref" | "function" | "graph";

export type Property = Extract<
  Extract<Expression, { type: "ObjectExpression" }>["properties"][number],
  { type: "Property" }
>;

export type Scope = Map<string, Binding>;

export type Context = {
  file: string;
  source: string;
  scope: Scope;
  diagnostics: CompilerDiagnostic[];
  modules: { start: number; end: number; path: string }[];
  parsers: Map<string, ParserSource>;
  sourceCalls: SourceCall[];
};

export function refuse(
  context: Context,
  at: Pick<Node, "start">,
  code: CompilerDiagnosticCode,
  message: string,
) {
  context.diagnostics.push(diagnostic(context.file, context.source, at.start, code, message));
}

export function name(node: Node): string | null {
  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "Literal" && isString(node.value)) {
    return node.value;
  }

  return null;
}

export function callable(expression: Expression, scope: Scope): string | null {
  if (expression.type === "Identifier") {
    const binding = scope.get(expression.name);

    return binding === "sdk" || binding === "subgraph" || binding === "command"
      ? expression.name
      : null;
  }

  if (
    expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier"
  ) {
    if (
      ["constructor", "prototype", "__proto__", "call", "apply", "bind"].includes(
        expression.property.name,
      )
    ) {
      return null;
    }

    const root = callable(expression.object, scope);

    return root === null ? null : `${root}.${expression.property.name}`;
  }

  return null;
}

export function literal(
  context: Context,
  node: Node | undefined,
  code: CompilerDiagnosticCode = "literal_required",
) {
  if (!node || node.type !== "Literal" || !isString(node.value)) {
    refuse(context, node ?? { start: 0 }, code, "Use a string literal here.");

    return null;
  }

  return node.value;
}

export function callSyntax(call: string, scope: Scope) {
  const binding = scope.get(call.split(".")[0] ?? call);

  if (binding === "sdk") {
    return { known: sdkCalls.has(call), syntax: sdkCalls.get(call) };
  }

  return { known: true, syntax: binding === "command" ? COMMAND_CALL : undefined };
}

export function declarationKind(expression: Expression | null, scope: Scope): Binding {
  const node = expression && unwrap(expression);

  if (node?.type === "Identifier") {
    return scope.get(node.name) ?? "value";
  }

  const call = node?.type === "CallExpression" ? callable(node.callee, scope) : null;

  if (call === null) {
    return node?.type === "CallExpression" ? "ref" : "value";
  }

  return callSyntax(call, scope).syntax?.binding ?? "ref";
}

export function unwrap(node: Expression): Expression {
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return unwrap(node.expression);
    default:
      return node;
  }
}
