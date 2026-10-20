import {
  isBoolean,
  isNumber,
  isString,
  type Json,
  type Node,
  setOwnProperty,
} from "../core/index.js";
import { predicate } from "./predicate.js";
import { type ResolutionContext, resolve } from "./resolve.js";
import { sequence, type Traversal, type TraversalResult } from "./traversal.js";

function mapped(
  traversal: Traversal,
  node: Extract<Node, { kind: "map" }>,
  context: ResolutionContext,
): TraversalResult {
  const items = resolve(node.over, traversal.transition.state, context);

  if (!Array.isArray(items)) {
    throw new Error("map requires an array.");
  }

  const outputs = new Map<number, Json>();
  const indices = Array.from(items.keys());

  const started = new Set(
    indices.flatMap((index) => {
      const scope = [...context.scope, { nodeId: node.id, index }];

      return traversal.transition.state.nodeRuns.some((run) =>
        scope.every(
          (part, depth) =>
            run.key.scope[depth]?.nodeId === part.nodeId &&
            run.key.scope[depth]?.index === part.index,
        ),
      )
        ? [index]
        : [];
    }),
  );

  let pending = 0;
  let failure: Extract<TraversalResult, { kind: "failed" | "cancelled" }> | undefined;
  const order = [...started, ...indices.filter((index) => !started.has(index))];

  for (const index of order) {
    if (!started.has(index) && (failure || pending >= node.concurrency || traversal.cancelling)) {
      continue;
    }

    const item = items[index] ?? null;

    const child = {
      scope: [...context.scope, { nodeId: node.id, index }],
      bindings: new Map([...context.bindings, [node.item, item], [node.index, index]]),
    };

    const result = sequence(traversal, node.body, child);

    switch (result.kind) {
      case "pending":
        pending++;
        break;
      case "cancelled":
        failure ??= result;
        break;
      case "failed":
        if (node.onError === "fail") {
          failure ??= result;
        } else {
          outputs.set(index, { ok: false, error: result.error });
        }

        break;
      case "succeeded":
        outputs.set(
          index,
          node.onError === "collect" ? { ok: true, value: result.output } : result.output,
        );
        break;
    }
  }

  if (pending > 0) {
    return { kind: "pending" };
  }

  if (failure) {
    return failure;
  }

  if (traversal.cancelling) {
    return { kind: "cancelled" };
  }

  if (outputs.size < items.length) {
    return { kind: "pending" };
  }

  return { kind: "succeeded", output: indices.map((index) => outputs.get(index) ?? null) };
}

function parallel(
  traversal: Traversal,
  node: Extract<Node, { kind: "parallel" }>,
  context: ResolutionContext,
): TraversalResult {
  const output: Record<string, Json> = {};
  let failure: Extract<TraversalResult, { kind: "failed" | "cancelled" }> | undefined;
  let pending = false;

  for (const [name, entry] of Object.entries(node.branches)) {
    const result = sequence(traversal, entry, context);

    if (result.kind === "pending") {
      pending = true;
    } else if (result.kind === "succeeded") {
      setOwnProperty(output, name, result.output);
    } else {
      failure ??= result;
    }
  }

  // Finish every started branch before unwinding outer cleanup or reporting failure.
  if (pending) {
    return { kind: "pending" };
  }

  return failure ?? { kind: "succeeded", output };
}

export function controls(
  traversal: Traversal,
  node: Node,
  context: ResolutionContext,
): TraversalResult | null {
  const { state } = traversal.transition;

  switch (node.kind) {
    case "branch":
      return sequence(
        traversal,
        predicate(node.predicate, state, context) ? node.arms.yes : node.arms.no,
        context,
      );
    case "switch": {
      const on = resolve(node.on, state, context);

      if (!isString(on) && !isNumber(on) && !isBoolean(on)) {
        throw new Error("switch requires a scalar value.");
      }

      const entry = Object.hasOwn(node.cases, String(on)) ? node.cases[String(on)] : node.default;

      if (!entry) {
        throw new Error(`switch has no case for '${String(on)}'.`);
      }

      return sequence(traversal, entry, context);
    }

    case "map":
      return mapped(traversal, node, context);
    case "parallel":
      return parallel(traversal, node, context);
    case "finally": {
      const body = sequence(traversal, node.body, context);

      if (body.kind === "pending") {
        return body;
      }

      const cleanup = sequence({ ...traversal, cancelling: false }, node.cleanup, context);

      if (cleanup.kind !== "succeeded") {
        return cleanup;
      }

      return body;
    }

    case "rescue": {
      const body = sequence(traversal, node.body, context);

      if (body.kind !== "failed" || traversal.cancelling) {
        return body;
      }

      return sequence(traversal, node.handler, {
        ...context,
        bindings: new Map([...context.bindings, [node.error, { ...body.error, data: null }]]),
      });
    }

    default:
      return null;
  }
}
