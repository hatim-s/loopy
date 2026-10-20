import {
  durationMs,
  isBoolean,
  isNumber,
  isString,
  type Node,
  type NodeRun,
} from "../core/index.js";
import { write } from "./node-run.js";
import { type ResolutionContext, resolve } from "./resolve.js";
import { executionSpec } from "./spec.js";
import type { Traversal, TraversalResult } from "./traversal.js";

function dispatch(
  traversal: Traversal,
  node: Extract<Node, { kind: "code" | "command" }>,
  options: { previous: NodeRun | undefined; context: ResolutionContext },
): TraversalResult {
  const { previous, context } = options;

  if (previous?.status === "running" && !traversal.rehydrate) {
    return { kind: "pending" };
  }

  const { transition, at } = traversal;
  const spec = executionSpec(node, transition.state, context);
  const key = { runId: transition.state.runId, nodeId: node.id, scope: context.scope };

  const run: NodeRun =
    previous?.status === "running" || previous?.status === "rate_limited"
      ? {
          key,
          status: "running",
          attempt: previous.attempt,
          maxAttempts: previous.maxAttempts,
          startedAt: previous.startedAt,
          receipt: previous.receipt,
        }
      : {
          key,
          startedAt: at,
          receipt: "none",
          status: "running",
          attempt: (previous?.attempt ?? 0) + 1,
          maxAttempts: node.retry.attempts,
        };

  write(transition, run);
  transition.effects.push({ kind: "dispatch", executionKey: key, attempt: run.attempt, spec });

  return { kind: "pending" };
}

function pause(
  traversal: Traversal,
  node: Extract<Node, { kind: "wait" | "sleep" }>,
  options: { previous: NodeRun | undefined; context: ResolutionContext },
): TraversalResult {
  const { previous, context } = options;
  const { transition, at } = traversal;

  const wakeAt =
    previous?.status === "waiting" || previous?.status === "sleeping"
      ? previous.wakeAt
      : node.kind === "sleep"
        ? new Date(Date.parse(at) + durationMs(node.duration)).toISOString()
        : node.timeout === null
          ? null
          : new Date(Date.parse(at) + durationMs(node.timeout)).toISOString();

  if (wakeAt !== null && wakeAt <= at) {
    return node.kind === "sleep"
      ? { kind: "succeeded", output: null }
      : { kind: "failed", error: { code: "execution", message: "Wait timed out." } };
  }

  if (wakeAt !== null) {
    transition.effects.push({ kind: "schedule_retry", at: wakeAt });
  }

  if (!previous) {
    const key = { runId: transition.state.runId, nodeId: node.id, scope: context.scope };
    const base = { key, attempt: 1, maxAttempts: 1, startedAt: at, receipt: "none" as const };

    if (node.kind === "wait") {
      write(transition, { ...base, status: "waiting", wakeAt });
      transition.effects.push({
        kind: "register_wait",
        executionKey: key,
        name: node.label ?? node.id,
        payload: node.payload,
        at,
      });
    } else if (wakeAt !== null) {
      write(transition, { ...base, status: "sleeping", wakeAt });
    }
  }

  return { kind: "pending" };
}

function formatted(
  traversal: Traversal,
  node: Extract<Node, { kind: "format" }>,
  context: ResolutionContext,
): string {
  const values = new Map(
    Object.entries(node.values).map(([name, value]) => [
      name,
      resolve(value, traversal.transition.state, context),
    ]),
  );

  return node.template.replace(/\{([^{}]+)\}/g, (match: string, name: string) => {
    if (!values.has(name)) {
      throw new Error(`Format value '${name}' is missing in '${match}'.`);
    }

    const value = values.get(name);

    if (!isString(value) && !isNumber(value) && !isBoolean(value)) {
      throw new Error(`Format value '${name}' must be a scalar.`);
    }

    return String(value);
  });
}

export function invoke(
  traversal: Traversal,
  node: Node,
  options: { previous: NodeRun | undefined; context: ResolutionContext },
): TraversalResult {
  const { previous, context } = options;
  const { transition, at } = traversal;
  const key = { runId: transition.state.runId, nodeId: node.id, scope: context.scope };
  const base = { key, attempt: 1, maxAttempts: 1, startedAt: at, receipt: "none" as const };

  if (traversal.cancelling) {
    return { kind: "cancelled" };
  }

  if (
    (previous?.status === "retrying" || previous?.status === "rate_limited") &&
    previous.nextRetryAt > at
  ) {
    transition.effects.push({ kind: "schedule_retry", at: previous.nextRetryAt });

    return { kind: "pending" };
  }

  switch (node.kind) {
    case "code":
    case "command":
      return dispatch(traversal, node, { previous, context });
    case "wait":
    case "sleep":
      return pause(traversal, node, { previous, context });
    case "now":
      return { kind: "succeeded", output: at };
    case "uuid":
    case "random": {
      if (previous?.status !== "running" || traversal.rehydrate) {
        write(transition, { ...base, status: "running" });
        transition.effects.push({ kind: "sample", executionKey: key, valueKind: node.kind });
      }

      return { kind: "pending" };
    }

    case "format":
      return { kind: "succeeded", output: formatted(traversal, node, context) };
    case "fail":
      return {
        kind: "failed",
        error: {
          code: "execution",
          message: String(resolve(node.message, transition.state, context)),
        },
      };
    case "log":
      return { kind: "succeeded", output: null };
    case "join":
      return {
        kind: "succeeded",
        output:
          node.result.kind === "none"
            ? null
            : resolve(node.result.value, transition.state, context),
      };
    default:
      throw new Error(`Control '${node.kind}' reached the value executor.`);
  }
}
