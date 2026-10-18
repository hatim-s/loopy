import { dirname, resolve } from "node:path";
import { type Expression, type Node, parseSync, type Statement } from "oxc-parser";
import {
  COMPILER_MESSAGES,
  type CompilerDiagnosticCode,
  isBoolean,
  isNumber,
  isReservedGraphName,
  isString,
} from "../core/index.js";
import { builtinCommandKeys, sdkCalls } from "../sdk/commands.js";
import type { CompilerDiagnostic } from "./types.js";

export function diagnostic(
  { file, source }: Pick<Context, "file" | "source">,
  start: number,
  code: CompilerDiagnosticCode,
  message: keyof typeof COMPILER_MESSAGES = code,
): CompilerDiagnostic {
  const lines = source.slice(0, start).split("\n");

  return {
    code,
    message: COMPILER_MESSAGES[message],
    source: { module: file, line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 },
  };
}

export function formatDiagnostics(diagnostics: readonly CompilerDiagnostic[]) {
  return diagnostics
    .map(
      ({ source, code, message }) =>
        `${source.module}:${source.line}:${source.column} [${code}] ${message}`,
    )
    .join("\n");
}

export function parseModule(file: string, source: string, diagnostics: CompilerDiagnostic[]) {
  const parsed = parseSync(file, source, { sourceType: "module", preserveParens: false });

  for (const error of parsed.errors) {
    diagnostics.push(diagnostic({ file, source }, error.labels[0]?.start ?? 0, "syntax_error"));
  }

  return parsed.program;
}

type Binding = "sdk" | "subgraph" | "command" | "value" | "ref" | "function" | "graph";

type Property = Extract<
  Extract<Expression, { type: "ObjectExpression" }>["properties"][number],
  { type: "Property" }
>;

export type Scope = Map<string, Binding>;

export type Context = {
  file: string;
  source: string;
  scope: Scope;
  diagnostics: CompilerDiagnostic[];
  edits: { start: number; end: number; text: string; path: string }[];
  parsers: Map<string, string>;
};

export function refuse(context: Context, node: Node, code: CompilerDiagnosticCode) {
  context.diagnostics.push(diagnostic(context, node.start, code));
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

export function literal(context: Context, parent: Node, node: Node | undefined) {
  if (!node || node.type !== "Literal" || !isString(node.value)) {
    refuse(context, node ?? parent, "literal_required");

    return null;
  }

  return node.value;
}

function callback(context: Context, node: Expression, scope: Scope) {
  if (node.type !== "ArrowFunctionExpression" || node.async) {
    refuse(context, node, "synchronous_run");

    return;
  }

  const local = new Map(scope);

  for (const parameter of node.params) {
    if (parameter.type === "Identifier") {
      local.set(parameter.name, "ref");
    } else if (parameter.type === "ObjectPattern") {
      for (const property of parameter.properties) {
        if (
          property.type === "Property" &&
          !property.computed &&
          name(property.key) !== null &&
          property.value.type === "Identifier"
        ) {
          local.set(property.value.name, "ref");
        } else {
          refuse(context, property, "invalid_binding");
        }
      }
    } else {
      refuse(context, parameter, "invalid_binding");
    }
  }

  if (node.body.type === "BlockStatement") {
    for (const statement of node.body.body) {
      statementRule(context, statement, local);
    }
  } else {
    expressionRule(context, node.body, local);
  }
}

function moduleProperty(context: Context, property: Property, owner: "code" | "defineCommand") {
  const value = unwrap(property.value);

  if (
    value.type !== "Literal" ||
    !isString(value.value) ||
    (!value.value.startsWith("./") && !value.value.startsWith("../"))
  ) {
    refuse(context, property, "module_path");

    return;
  }

  const path = value.value;

  if (owner === "defineCommand") {
    return;
  }

  context.edits.push({
    start: property.value.start,
    end: property.value.end,
    text: JSON.stringify(resolve(dirname(context.file), path)),
    path: resolve(dirname(context.file), path),
  });
}

function propertyValue(context: Context, property: Property, scope: Scope, owner: string) {
  const key = name(property.key);

  if (key !== null && isReservedGraphName(key)) {
    refuse(context, property, "reserved_name");

    return;
  }

  if (key === null) {
    refuse(context, property, "literal_key");

    return;
  }

  if (
    key === "label" ||
    (owner === "loopy" && key === "name") ||
    (owner === "defineCommand" && ["key", "namespace", "name"].includes(key))
  ) {
    literal(context, property, property.value);

    return;
  }

  if ((key === "module" && owner === "code") || (key === "parse" && owner === "defineCommand")) {
    moduleProperty(context, property, owner);

    return;
  }

  const isCallbackSlot =
    (owner === "loopy" && key === "run") || ["branch", "switch_", "parallel"].includes(owner);

  if (property.value.type === "ArrowFunctionExpression" || isCallbackSlot) {
    if (isCallbackSlot) {
      callback(context, property.value, scope);
    } else {
      refuse(context, property, "invalid_callback");
    }

    return;
  }

  if (property.value.type === "ObjectExpression") {
    propertyRule(context, property.value, scope, "");
  } else {
    expressionRule(context, property.value, scope);
  }
}

function propertyRule(
  context: Context,
  expression: Extract<Expression, { type: "ObjectExpression" }>,
  scope: Scope,
  owner: string,
) {
  for (const property of expression.properties) {
    if (property.type !== "Property" || property.computed || property.method) {
      refuse(context, property, "literal_key");
      continue;
    }

    propertyValue(context, property, scope, owner);
  }
}

function callRule(
  context: Context,
  node: Extract<Expression, { type: "CallExpression" }>,
  scope: Scope,
) {
  const call = callable(node.callee, scope);

  if (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    name(node.callee.property) === "get"
  ) {
    expressionRule(context, node.callee.object, scope);
    literal(context, node, node.arguments[0]);

    if (node.arguments.length !== 1) {
      refuse(context, node, "literal_required");
    }

    return;
  }

  if (call === null || node.optional) {
    refuse(context, node, "forbidden_call");

    return;
  }

  const root = call.split(".")[0] ?? call;

  if (scope.get(root) === "sdk" && !sdkCalls.includes(call)) {
    refuse(context, node, "unknown_sdk_call");

    return;
  }

  if (["loopy", "code", "wait", "subgraph"].includes(root)) {
    literal(context, node, node.arguments[0]);
  }

  const before = context.diagnostics.length;
  callArguments(context, node, scope, call, root);

  if (call === "defineCommand" && context.diagnostics.length === before) {
    const argument = node.arguments[0];
    const descriptor = argument && argument.type !== "SpreadElement" ? unwrap(argument) : argument;

    if (descriptor?.type !== "ObjectExpression") {
      return;
    }

    recordParser(context, node, descriptor);
  }
}

function recordParser(
  context: Context,
  node: Node,
  descriptor: Extract<Expression, { type: "ObjectExpression" }>,
) {
  const fields = new Map<string, string>();

  for (const property of descriptor.properties) {
    if (property.type !== "Property") {
      continue;
    }

    const value = unwrap(property.value);

    if (value.type === "Literal" && isString(value.value)) {
      fields.set(name(property.key) ?? "", value.value);
    }
  }

  const path = fields.get("parse");

  if (path === undefined) {
    return;
  }

  const id = fields.get("key");

  if (id === undefined) {
    refuse(context, node, "command_key");

    return;
  }

  if (context.parsers.has(id) || builtinCommandKeys.includes(id)) {
    refuse(context, node, "command_key");

    return;
  }

  context.parsers.set(id, resolve(dirname(context.file), path));
}

function callArguments(
  context: Context,
  node: Extract<Expression, { type: "CallExpression" }>,
  scope: Scope,
  call: string,
  root: string,
) {
  for (const [index, original] of node.arguments.entries()) {
    const argument = original.type === "SpreadElement" ? original : unwrap(original);
    const options = optionsArgument(call, root, index, scope);

    if (options && argument.type !== "ObjectExpression") {
      refuse(
        context,
        argument,
        root === "defineCommand" && index === 0 ? "descriptor_not_literal" : "options_not_literal",
      );
      continue;
    }

    if (argument.type === "SpreadElement") {
      refuse(context, argument, "forbidden_expression");
    } else if (
      argument.type === "ArrowFunctionExpression" &&
      ["map", "finally_", "rescue", "subgraph"].includes(root)
    ) {
      callback(context, argument, scope);
    } else if (argument.type === "ObjectExpression") {
      propertyRule(context, argument, scope, root);
    } else {
      expressionRule(context, argument, scope);
    }
  }
}

export function expressionRule(context: Context, original: Expression, scope: Scope): void {
  const node = unwrap(original);

  switch (node.type) {
    case "Literal":
      if (
        node.value !== null &&
        !isString(node.value) &&
        !isNumber(node.value) &&
        !isBoolean(node.value)
      ) {
        refuse(context, node, "forbidden_expression");
      }

      return;
    case "Identifier":
      if (
        !["value", "ref", "graph"].includes(scope.get(node.name) ?? "") &&
        node.name !== "undefined"
      ) {
        refuse(context, node, "invalid_reference");
      }

      return;
    case "CallExpression":
      callRule(context, node, scope);

      return;
    case "ObjectExpression":
      propertyRule(context, node, scope, "");

      return;
    case "ArrayExpression":
      for (const item of node.elements) {
        if (item === null || item.type === "SpreadElement") {
          refuse(context, node, "forbidden_expression");
        } else {
          expressionRule(context, item, scope);
        }
      }

      return;
    case "UnaryExpression":
      if (
        node.operator === "-" &&
        node.argument.type === "Literal" &&
        isNumber(node.argument.value)
      ) {
        return;
      }

      break;
    case "AwaitExpression":
      refuse(context, node, "await_forbidden");

      return;
    case "TemplateLiteral":
      if (node.expressions.length === 0) {
        return;
      }

      refuse(context, node, "template_reference");

      return;
  }

  refuse(context, node, "forbidden_expression");
}

function statementRule(context: Context, statement: Statement, scope: Scope) {
  if (statement.type === "VariableDeclaration" && statement.kind === "const") {
    for (const declaration of statement.declarations) {
      if (
        declaration.id.type !== "Identifier" ||
        !declaration.init ||
        scope.has(declaration.id.name)
      ) {
        refuse(context, declaration, "invalid_binding");
        continue;
      }

      expressionRule(context, declaration.init, scope);
      scope.set(declaration.id.name, "ref");
    }
  } else if (statement.type === "ReturnStatement") {
    if (statement.argument) {
      expressionRule(context, statement.argument, scope);
    }
  } else if (statement.type === "ExpressionStatement") {
    expressionRule(context, statement.expression, scope);
  } else {
    refuse(context, statement, "forbidden_statement");
  }
}

export function declarationKind(original: Expression | null, scope: Scope): Binding {
  const expression = original && unwrap(original);

  if (expression?.type === "Identifier") {
    return scope.get(expression.name) ?? "value";
  }

  if (expression?.type !== "CallExpression") {
    return "value";
  }

  const call = callable(expression.callee, scope);

  const kinds = { subgraph: "subgraph", defineCommand: "command", loopy: "graph" } as const;

  return call === "subgraph" || call === "defineCommand" || call === "loopy" ? kinds[call] : "ref";
}

export function unwrap(node: Expression): Expression;
export function unwrap(node: Node): Node;
export function unwrap(node: Node): Node {
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
    case "ChainExpression":
      return unwrap(node.expression);
    case "SequenceExpression": {
      const last = node.expressions.at(-1);

      return last ? unwrap(last) : node;
    }

    default:
      return node;
  }
}

function optionsArgument(call: string, root: string, index: number, scope: Scope) {
  if (["loopy", "code", "wait", "branch", "switch_"].includes(root)) {
    return index === 1;
  }

  if (["defineCommand", "parallel"].includes(root)) {
    return true;
  }

  if (root === "map") {
    return index === 2;
  }

  return index === 1 && (root === "sh" || call.includes(".") || scope.get(root) === "command");
}

export function declarations(statement: Statement) {
  return statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
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
      refuse(context, declaration, "invalid_binding");
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
) {
  const expression = statement.declaration;

  if (
    expression.type === "FunctionDeclaration" ||
    expression.type === "ClassDeclaration" ||
    expression.type === "TSInterfaceDeclaration"
  ) {
    return null;
  }

  expressionRule(context, expression, context.scope);

  return declarationKind(expression, context.scope);
}

export function inspectStatements(context: Context, statements: Statement[]) {
  let defaultKind: Binding | null = null;

  for (const statement of statements) {
    const node = declarations(statement);

    if (
      statement.type === "ExportAllDeclaration" ||
      (statement.type === "ExportNamedDeclaration" && statement.source)
    ) {
      refuse(context, statement, "module_import");
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
      defaultKind = defaultExport(context, statement);
    } else {
      refuse(context, statement, "module_effect");
    }
  }

  return defaultKind;
}
