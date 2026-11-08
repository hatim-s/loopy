import { scopeHasPrefix } from "../graph/key";
import type { Node } from "../graph/nodes";
import { isScalar, type Json } from "../json";
import { setOwnProperty } from "../validation";
import { predicate } from "./predicate";
import { type ResolutionContext, resolve } from "./resolve";
import { sequence, type Traversal, type TraversalResult } from "./traversal";

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

      return traversal.transition.state.nodeRuns.some((run) => scopeHasPrefix(run.key.scope, scope))
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

export type ControlNode = Extract<
  Node,
  { kind: "branch" | "switch" | "map" | "parallel" | "finally" | "rescue" }
>;

export function control(
  traversal: Traversal,
  node: ControlNode,
  context: ResolutionContext,
): TraversalResult {
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

      if (!isScalar(on)) {
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
  }
}
