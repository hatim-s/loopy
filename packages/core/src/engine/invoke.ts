import { durationMs } from "../duration";
import type { AttemptLog } from "../executor";
import type { NodeRun } from "../graph/node-run";
import type { ExecutableNode, Node } from "../graph/nodes";
import { isScalar } from "../json";
import { limitLogs } from "../logs";
import type { ControlNode } from "./control";
import { captureInput } from "./input";
import { addMs, type Execution, runBase, write } from "./node-run";
import { resolve } from "./resolve";
import { executionSpec } from "./spec";
import type { Traversal, TraversalResult } from "./traversal";

/** A log node succeeds with null and hands its bounded line to the inline write. */
export type InvokeResult = TraversalResult | { kind: "logged"; log: AttemptLog | null };

// A started effect is emitted again only when the run rehydrates after losing its worker.
function awaitingEffect(traversal: Traversal, previous: NodeRun | undefined): boolean {
  return previous?.status === "running" && !traversal.rehydrate;
}

function dispatch(traversal: Traversal, execution: Execution<ExecutableNode>): TraversalResult {
  const { node, key, previous, context } = execution;

  if (awaitingEffect(traversal, previous)) {
    return { kind: "pending" };
  }

  const { transition, at } = traversal;
  const spec = executionSpec(node, transition.state, context);
  const sameAttempt = previous?.status === "running" || previous?.status === "rate_limited";

  const run: NodeRun = sameAttempt
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

  if (!sameAttempt) {
    const inputView = captureInput(spec);

    if (inputView !== undefined) {
      run.inputView = inputView;
    }
  }

  write(transition, run);
  transition.effects.push({ kind: "dispatch", executionKey: key, attempt: run.attempt, spec });

  return { kind: "pending" };
}

function pause(
  traversal: Traversal,
  execution: Execution<Extract<Node, { kind: "wait" | "sleep" }>>,
): TraversalResult {
  const { node, key, previous } = execution;
  const { transition, at } = traversal;

  const wakeAt =
    previous?.status === "waiting" || previous?.status === "sleeping"
      ? previous.wakeAt
      : node.kind === "sleep"
        ? addMs(at, durationMs(node.duration))
        : node.timeout === null
          ? null
          : addMs(at, durationMs(node.timeout));

  if (wakeAt !== null && wakeAt <= at) {
    return node.kind === "sleep"
      ? { kind: "succeeded", output: null }
      : { kind: "failed", error: { code: "execution", message: "Wait timed out." } };
  }

  if (!previous) {
    const base = runBase(execution, at);

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
  execution: Execution<Extract<Node, { kind: "format" }>>,
): string {
  const { node, context } = execution;

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

    if (!isScalar(value)) {
      throw new Error(`Format value '${name}' must be a scalar.`);
    }

    return String(value);
  });
}

export function invoke(
  traversal: Traversal,
  execution: Execution<Exclude<Node, ControlNode>>,
): InvokeResult {
  const { node, key, previous, context } = execution;
  const { transition, at } = traversal;

  if (traversal.cancelling) {
    return { kind: "cancelled" };
  }

  if (
    (previous?.status === "retrying" || previous?.status === "rate_limited") &&
    previous.nextRetryAt > at
  ) {
    return { kind: "pending" };
  }

  switch (node.kind) {
    case "code":
    case "command":
      return dispatch(traversal, { ...execution, node });
    case "wait":
    case "sleep":
      return pause(traversal, { ...execution, node });
    case "now":
      return { kind: "succeeded", output: at };
    case "uuid":
    case "random": {
      if (!awaitingEffect(traversal, previous)) {
        write(transition, { ...runBase(execution, at), status: "running" });
        transition.effects.push({ kind: "sample", executionKey: key, valueKind: node.kind });
      }

      return { kind: "pending" };
    }

    case "format":
      return { kind: "succeeded", output: formatted(traversal, { ...execution, node }) };
    case "fail":
      return {
        kind: "failed",
        error: {
          code: "execution",
          message: String(resolve(node.message, transition.state, context)),
        },
      };
    case "log": {
      const [log] = limitLogs([
        {
          message: String(resolve(node.message, transition.state, context)),
          data: node.data === null ? null : resolve(node.data, transition.state, context),
        },
      ]);

      return { kind: "logged", log: log ?? null };
    }

    case "join":
      return {
        kind: "succeeded",
        output:
          node.result.kind === "none"
            ? null
            : resolve(node.result.value, transition.state, context),
      };
  }
}
