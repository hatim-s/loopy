import { dirname, resolve } from "node:path";
import type { Expression, Node, Statement } from "oxc-parser";
import {
  type CompilerDiagnosticCode,
  isBoolean,
  isNumber,
  isReservedGraphName,
  isString,
} from "../core/index.js";
import { sdkCalls } from "../sdk/graph-host.js";
import { diagnostic } from "./diagnostic.js";
import type { CompilerDiagnostic, ParserSource } from "./types.js";

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
  edits: { start: number; end: number; text: string }[];
  parsers: Map<string, ParserSource>;
};

export function refuse(
  context: Context,
  node: Node,
  code: CompilerDiagnosticCode,
  message: string,
) {
  context.diagnostics.push(diagnostic(context.file, context.source, node.start, code, message));
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
    refuse(
      context,
      node ?? { type: "Identifier", name: "missing", start: 0, end: 0 },
      code,
      "Use a string literal here.",
    );

    return null;
  }

  return node.value;
}

function callback(context: Context, node: Expression, scope: Scope) {
  if (node.type !== "ArrowFunctionExpression" || node.async) {
    refuse(
      context,
      node,
      "synchronous_run",
      "Use a synchronous arrow function for graph construction.",
    );

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
          refuse(context, property, "invalid_binding", "Use simple reference bindings.");
        }
      }
    } else {
      refuse(context, parameter, "invalid_binding", "Use simple reference bindings.");
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

function moduleProperty(context: Context, property: Property) {
  const path = literal(context, property.value, "module_path");

  if (path === null) {
    return;
  }

  if (!path.startsWith("./") && !path.startsWith("../")) {
    refuse(context, property, "module_path", "Code modules must use a relative file path.");

    return;
  }

  context.edits.push({
    start: property.value.start,
    end: property.value.end,
    text: JSON.stringify(resolve(dirname(context.file), path)),
  });
}

function propertyValue(context: Context, property: Property, scope: Scope, owner: string) {
  const key = name(property.key);

  if (key !== null && isReservedGraphName(key)) {
    refuse(context, property, "reserved_name", "This property name is reserved by the graph.");

    return;
  }

  if (key === null) {
    refuse(context, property, "literal_key", "Object keys must be strings.");

    return;
  }

  if (
    key === "label" ||
    (owner === "loopy" && key === "name") ||
    (owner === "defineCommand" && ["key", "namespace", "name"].includes(key))
  ) {
    literal(context, property.value);
  }

  if (key === "module" && owner === "code") {
    moduleProperty(context, property);

    return;
  }

  if (key === "parse" && owner === "defineCommand") {
    parserProperty(context, property);

    return;
  }

  if (
    property.value.type === "ArrowFunctionExpression" ||
    (owner === "loopy" && key === "run") ||
    ["branch", "switch_", "parallel"].includes(owner)
  ) {
    if ((owner === "loopy" && key === "run") || ["branch", "switch_", "parallel"].includes(owner)) {
      callback(context, property.value, scope);
    } else {
      refuse(
        context,
        property,
        "invalid_callback",
        "Callbacks belong to control nodes or command parsers.",
      );
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
      refuse(context, property, "literal_key", "Object keys must be literal property names.");
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

  const get =
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    name(node.callee.property) === "get";

  if (get && node.callee.type === "MemberExpression") {
    expressionRule(context, node.callee.object, scope);
    literal(context, node.arguments[0]);

    if (node.arguments.length !== 1) {
      refuse(context, node, "literal_required", "ref.get takes one literal key.");
    }

    return;
  }

  if (call === null || node.optional) {
    refuse(context, node, "forbidden_call", "Call an SDK export or a declared subgraph only.");

    return;
  }

  const root = call.split(".")[0] ?? call;

  if (scope.get(root) === "sdk" && !sdkCalls.includes(call)) {
    refuse(context, node, "unknown_sdk_call", "Call an exported SDK function or namespace member.");

    return;
  }

  if (["loopy", "code", "wait", "subgraph"].includes(root)) {
    literal(context, node.arguments[0]);
  }

  callArguments(context, node, scope, call);
}

function callArguments(
  context: Context,
  node: Extract<Expression, { type: "CallExpression" }>,
  scope: Scope,
  call: string,
) {
  const root = call.split(".")[0] ?? call;

  for (const [index, original] of node.arguments.entries()) {
    const argument = original.type === "SpreadElement" ? original : unwrap(original);
    const options = optionsArgument(call, index, scope);

    if (options && argument.type !== "ObjectExpression") {
      refuse(
        context,
        argument,
        "options_not_literal",
        "Use an inline object literal for SDK options.",
      );
      continue;
    }

    if (argument.type === "SpreadElement") {
      refuse(
        context,
        argument,
        "forbidden_expression",
        "Spread arguments are unavailable in graph builders.",
      );
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

export function expressionRule(context: Context, node: Expression, scope: Scope): void {
  switch (node.type) {
    case "Literal":
      if (
        node.value !== null &&
        !isString(node.value) &&
        !isNumber(node.value) &&
        !isBoolean(node.value)
      ) {
        refuse(context, node, "forbidden_expression", "Use JSON literals in graph construction.");
      }

      return;
    case "Identifier":
      if (
        !["value", "ref", "graph"].includes(scope.get(node.name) ?? "") &&
        node.name !== "undefined"
      ) {
        refuse(
          context,
          node,
          "invalid_reference",
          "Use a literal or an immutable graph reference.",
        );
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
          refuse(context, node, "forbidden_expression", "Use explicit array items.");
        } else {
          expressionRule(context, item, scope);
        }
      }

      return;
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      expressionRule(context, node.expression, scope);

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
      refuse(context, node, "await_forbidden", "Graph construction cannot await.");

      return;
    case "TemplateLiteral":
      if (node.expressions.length === 0) {
        return;
      }

      refuse(context, node, "template_reference", "Use format() to interpolate graph references.");

      return;
  }

  refuse(
    context,
    node,
    "forbidden_expression",
    "Graph construction accepts only SDK calls, references and literals.",
  );
}

function statementRule(context: Context, statement: Statement, scope: Scope) {
  if (statement.type === "VariableDeclaration" && statement.kind === "const") {
    for (const declaration of statement.declarations) {
      if (
        declaration.id.type !== "Identifier" ||
        !declaration.init ||
        scope.has(declaration.id.name)
      ) {
        refuse(
          context,
          declaration,
          "invalid_binding",
          "Use unique const bindings for graph values.",
        );
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
    refuse(
      context,
      statement,
      "forbidden_statement",
      "Graph construction allows const declarations, SDK calls and return only.",
    );
  }
}

export function declarationKind(expression: Expression | null, scope: Scope): Binding {
  if (
    expression?.type === "TSAsExpression" ||
    expression?.type === "TSSatisfiesExpression" ||
    expression?.type === "TSNonNullExpression"
  ) {
    return declarationKind(expression.expression, scope);
  }

  if (expression?.type === "Identifier") {
    return scope.get(expression.name) ?? "value";
  }

  if (expression?.type !== "CallExpression") {
    return "value";
  }

  const call = callable(expression.callee, scope);

  return call === "subgraph"
    ? "subgraph"
    : call === "defineCommand"
      ? "command"
      : call === "loopy"
        ? "graph"
        : "ref";
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

function optionsArgument(call: string, index: number, scope: Scope) {
  const root = call.split(".")[0] ?? call;

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

function parserProperty(context: Context, property: Property) {
  const path = literal(context, property.value, "module_path");

  if (path !== null && !path.startsWith("./") && !path.startsWith("../")) {
    refuse(context, property, "module_path", "Parser modules must use a relative file path.");
  }
}
