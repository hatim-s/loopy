import { errorMessage, type Graph, type Node, type NodeRun } from "../core/index.js";
import { failNode } from "./failure.js";
import { immediate } from "./immediate.js";
import { finish, type Transition, write } from "./node-run.js";
import { validateOutput } from "./output.js";
import { resolve, sameExecution } from "./resolve.js";
import { retryDelayMs, shouldRetry } from "./retry.js";
import { executionSpec } from "./spec.js";
import type { EngineEvent, EngineState } from "./state.js";

function dispatch(
  transition: Transition,
  node: Extract<Node, { kind: "code" | "command" }>,
  previous: NodeRun | undefined,
  at: string,
) {
  const spec = executionSpec(node, transition.state);

  const nodeRun: NodeRun =
    previous?.status === "running"
      ? previous
      : {
          key: { runId: transition.state.runId, nodeId: node.id, scope: [] },
          status: "running",
          attempt: (previous?.attempt ?? 0) + 1,
          maxAttempts: node.retry.attempts,
          startedAt: at,
          receipt: "none",
        };

  write(transition, nodeRun);
  transition.effects.push({
    kind: "dispatch",
    executionKey: nodeRun.key,
    attempt: nodeRun.attempt,
    spec,
  });
}

function invokeNode(transition: Transition, node: Node, previous: NodeRun | undefined, at: string) {
  if (node.kind === "code" || node.kind === "command") {
    dispatch(transition, node, previous, at);

    return true;
  }

  if (node.kind !== "log" && node.kind !== "join") {
    throw new Error(`Node kind '${node.kind}' is not_yet supported by the sequence engine.`);
  }

  const output =
    node.kind === "join" && node.result.kind === "value"
      ? resolve(node.result.value, transition.state)
      : null;

  immediate(transition, node, output, at);

  return transition.state.phase.kind === "finished";
}

function executeNode(
  transition: Transition,
  node: Node,
  previous: NodeRun | undefined,
  at: string,
) {
  try {
    return invokeNode(transition, node, previous, at);
  } catch (cause) {
    failNode(transition, node, { code: "validation", message: errorMessage(cause) }, at);

    return true;
  }
}

function advance(graph: Graph, transition: Transition, at: string) {
  let id: Node["id"] | undefined = graph.entry;

  while (id !== undefined && transition.state.phase.kind === "active") {
    const node = graph.nodes.find((node) => node.id === id);

    if (!node) {
      throw new Error(`Graph node '${id}' is missing.`);
    }

    const previous = transition.state.nodeRuns.find(
      (run) => run.key.nodeId === id && run.key.scope.length === 0,
    );

    if (previous?.status === "failed") {
      finish(transition, { status: "failed", error: previous.error.message }, at);

      return;
    }

    if (previous?.status === "retrying" && previous.nextRetryAt > at) {
      transition.effects.push({ kind: "schedule_retry", at: previous.nextRetryAt });

      return;
    }

    if (previous?.status !== "succeeded") {
      if (executeNode(transition, node, previous, at)) {
        return;
      }
    }

    id = graph.edges.find((edge) => edge.from === node.id && edge.kind === "next")?.to;
  }

  const output = graph.outputs === null ? null : resolve(graph.outputs, transition.state);
  finish(transition, { status: "succeeded", output }, at);
}

function completion(
  graph: Graph,
  transition: Transition,
  event: Extract<EngineEvent, { kind: "execution_completed" | "execution_failed" }>,
) {
  const previous = transition.state.nodeRuns.find((run) =>
    sameExecution(run.key, event.executionKey),
  );

  if (previous?.status !== "running" || previous.attempt !== event.attempt) {
    return false;
  }

  const node = graph.nodes.find((node) => node.id === previous.key.nodeId);

  if (node?.kind !== "code" && node?.kind !== "command") {
    return false;
  }

  const error =
    event.kind === "execution_failed" ? event.error : validateOutput(event.result.output, node.out);

  if (error) {
    if (previous.attempt < previous.maxAttempts && shouldRetry(error, node.retry)) {
      const at = new Date(Date.parse(event.at) + retryDelayMs(previous.attempt)).toISOString();
      write(transition, {
        ...previous,
        status: "retrying",
        error,
        endedAt: event.at,
        nextRetryAt: at,
        receipt: "finished",
      });
      transition.effects.push({ kind: "schedule_retry", at });
    } else {
      write(transition, {
        ...previous,
        status: "failed",
        error,
        endedAt: event.at,
        receipt: "finished",
      });
      finish(transition, { status: "failed", error: error.message }, event.at);
    }

    return false;
  }

  if (event.kind === "execution_completed") {
    write(transition, {
      ...previous,
      status: "succeeded",
      output: event.result.output,
      endedAt: event.at,
      receipt: "finished",
    });
  }

  return true;
}

export function step(graph: Graph, state: EngineState, event: EngineEvent): Transition {
  if (state.phase.kind === "finished") {
    return { state, effects: [] };
  }

  const transition: Transition = { state: structuredClone(state), effects: [] };

  try {
    if (event.kind === "cancel_requested") {
      throw new Error(
        "Cancellation is not_yet supported. PR 4c adds process cancellation and cleanup.",
      );
    }

    if (
      (event.kind === "execution_completed" || event.kind === "execution_failed") &&
      !completion(graph, transition, event)
    ) {
      return transition;
    }

    advance(graph, transition, event.at);
  } catch (cause) {
    finish(transition, { status: "failed", error: errorMessage(cause) }, event.at);
  }

  return transition;
}
