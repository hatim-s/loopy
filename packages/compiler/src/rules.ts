import { dirname, resolve } from "node:path";
import { isBoolean, isNumber, isReservedGraphName, isString } from "@loopy/core";
import type { CallSyntax } from "@loopy/sdk/graph-host";
import type { Expression, Statement } from "oxc-parser";
import {
  type Context,
  callable,
  callSyntax,
  literal,
  name,
  type Property,
  refuse,
  type Scope,
  unwrap,
} from "./ast";

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

  context.modules.push({
    start: property.value.start,
    end: property.value.end,
    path: resolve(dirname(context.file), path),
  });
}

function optionRole(syntax: CallSyntax | undefined, key: string) {
  if (key === "label") {
    return "literal";
  }

  return syntax?.keys && Object.hasOwn(syntax.keys, key) ? syntax.keys[key] : undefined;
}

function propertyValue(
  context: Context,
  property: Property,
  scope: Scope,
  syntax: CallSyntax | undefined,
) {
  const key = name(property.key);

  if (key !== null && isReservedGraphName(key)) {
    refuse(context, property, "reserved_name", "This property name is reserved by the graph.");

    return;
  }

  if (key === null) {
    refuse(context, property, "literal_key", "Object keys must be strings.");

    return;
  }

  const role = optionRole(syntax, key);

  if (role === "literal") {
    literal(context, property.value);
  }

  if (role === "module") {
    moduleProperty(context, property);

    return;
  }

  if (role === "parser") {
    parserProperty(context, property);

    return;
  }

  if (role === "callback" || syntax?.callbacks === "options") {
    callback(context, property.value, scope);

    return;
  }

  if (property.value.type === "ArrowFunctionExpression") {
    refuse(context, property, "invalid_callback", "Callbacks belong to control nodes and run.");

    return;
  }

  if (property.value.type === "ObjectExpression") {
    propertyRule(context, property.value, scope, undefined);
  } else {
    expressionRule(context, property.value, scope);
  }
}

function propertyRule(
  context: Context,
  expression: Extract<Expression, { type: "ObjectExpression" }>,
  scope: Scope,
  syntax: CallSyntax | undefined,
) {
  for (const property of expression.properties) {
    if (property.type !== "Property" || property.computed || property.method) {
      refuse(context, property, "literal_key", "Object keys must be literal property names.");
      continue;
    }

    propertyValue(context, property, scope, syntax);
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

  const { known, syntax } = callSyntax(call, scope);

  if (!known) {
    refuse(context, node, "unknown_sdk_call", "Call an exported SDK function or namespace member.");

    return;
  }

  const label = node.arguments[0];

  if (syntax?.source && label?.type === "Literal" && isString(label.value)) {
    context.sourceCalls.push({
      kind: syntax.source,
      label: label.value,
      start: node.start,
      end: node.end,
    });
  }

  if (syntax?.label) {
    literal(context, label);
  }

  callArguments(context, node, scope, syntax);
}

function callArguments(
  context: Context,
  node: Extract<Expression, { type: "CallExpression" }>,
  scope: Scope,
  syntax: CallSyntax | undefined,
) {
  for (const [index, original] of node.arguments.entries()) {
    const argument = original.type === "SpreadElement" ? original : unwrap(original);
    const options = syntax?.options === "all" || syntax?.options === index;

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
    } else if (argument.type === "ArrowFunctionExpression" && syntax?.callbacks === "arguments") {
      callback(context, argument, scope);
    } else if (argument.type === "ObjectExpression") {
      propertyRule(context, argument, scope, options ? syntax : undefined);
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
      propertyRule(context, node, scope, undefined);

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

function parserProperty(context: Context, property: Property) {
  const path = literal(context, property.value, "module_path");

  if (path !== null && !path.startsWith("./") && !path.startsWith("../")) {
    refuse(context, property, "module_path", "Parser modules must use a relative file path.");
  }
}
