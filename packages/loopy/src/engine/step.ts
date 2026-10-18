import { type Graph, type Node, type NodeRun, sameExecution } from "../core/index.js";
import { failNode, finish, immediate, write } from "./node-run.js";
import { retryDelayMs, shouldRetry, validateOutput } from "./policy.js";
import { resolve } from "./resolve.js";
import { executionSpec, MISSING_INPUT } from "./spec.js";
import {
  type Changes,
  type EngineEvent,
  type EngineState,
  nodeRunFor,
  type Transition,
} from "./state.js";

function dispatch(
  changes: Changes,
  node: Extract<Node, { kind: "code" | "command" }>,
  previous: NodeRun | undefined,
  at: string,
): Transition["next"] {
  const spec = executionSpec(node, changes.state);

  if ("code" in spec) {
    return failNode(changes, node, spec, at);
  }

  const nodeRun: NodeRun =
    previous?.status === "running" || previous?.status === "rate_limited"
      ? {
          key: previous.key,
          attempt: previous.attempt,
          maxAttempts: previous.maxAttempts,
          startedAt: previous.startedAt,
          receipt: previous.receipt,
          status: "running",
        }
      : {
          key: { runId: changes.state.runId, nodeId: node.id, scope: [] },
          status: "running",
          attempt: (previous?.attempt ?? 0) + 1,
          maxAttempts: node.retry.attempts,
          startedAt: at,
          receipt: "none",
        };

  if (previous?.status !== "running") {
    write(changes, nodeRun);
  }

  return { kind: "dispatch", executionKey: nodeRun.key, attempt: nodeRun.attempt, spec };
}

function invokeNode(graphNode: Node, changes: Changes, previous: NodeRun | undefined, at: string) {
  if (graphNode.kind === "code" || graphNode.kind === "command") {
    return dispatch(changes, graphNode, previous, at);
  }

  if (graphNode.kind !== "log" && graphNode.kind !== "join") {
    throw new Error(`Node kind '${graphNode.kind}' is not_yet supported by the sequence engine.`);
  }

  const output =
    graphNode.kind === "join" && graphNode.result.kind === "value"
      ? resolve(graphNode.result.value, changes.state)
      : null;

  return output === undefined
    ? failNode(changes, graphNode, MISSING_INPUT, at)
    : immediate(changes, graphNode, output, at);
}

function advance(graph: Graph, changes: Changes, at: string): Transition["next"] {
  if (changes.state.phase.kind === "finished") {
    return { kind: "finished", outcome: changes.state.phase.outcome };
  }

  let id: Node["id"] | undefined = graph.entry;

  while (id !== undefined) {
    const node = graph.nodes.find((node) => node.id === id);

    if (!node) {
      throw new Error(`Graph node '${id}' is missing.`);
    }

    const previous = nodeRunFor(changes.state, id);

    if (previous?.status === "failed") {
      return finish(changes, { status: "failed", error: previous.error.message }, at);
    }

    if (
      (previous?.status === "retrying" || previous?.status === "rate_limited") &&
      previous.nextRetryAt > at
    ) {
      return { kind: "wait", at: previous.nextRetryAt };
    }

    if (previous?.status !== "succeeded") {
      const next = invokeNode(node, changes, previous, at);

      if (next) {
        return next;
      }
    }

    id = graph.edges.find((edge) => edge.from === node.id && edge.kind === "next")?.to;
  }

  const output = graph.outputs === null ? null : resolve(graph.outputs, changes.state);

  return finish(
    changes,
    output === undefined
      ? { status: "failed", error: MISSING_INPUT.message }
      : { status: "succeeded", output },
    at,
  );
}

function completion(
  graph: Graph,
  changes: Changes,
  event: Extract<EngineEvent, { kind: "execution_finished" }>,
) {
  const previous = changes.state.nodeRuns.find((run) => sameExecution(run.key, event.executionKey));

  if (previous?.status !== "running" || previous.attempt !== event.attempt) {
    return;
  }

  const node = graph.nodes.find((node) => node.id === previous.key.nodeId);

  if (node?.kind !== "code" && node?.kind !== "command") {
    throw new Error("Execution node is missing.");
  }

  changes.writes.push(
    ...event.result.logs.map((log) => ({
      kind: "write_log" as const,
      executionKey: previous.key,
      attempt: previous.attempt,
      log,
      at: event.at,
    })),
  );

  const output =
    event.result.kind === "succeeded" && !(node.kind === "command" && node.out === null)
      ? event.result.output
      : null;

  const error =
    event.result.kind === "failed" ? event.result.error : validateOutput(output, node.out);

  if (error) {
    if (previous.attempt < previous.maxAttempts && shouldRetry(error, node.retry)) {
      write(changes, {
        ...previous,
        status: "retrying",
        error,
        endedAt: event.at,
        nextRetryAt: new Date(Date.parse(event.at) + retryDelayMs(previous.attempt)).toISOString(),
        receipt: "finished",
      });
    } else {
      write(changes, {
        ...previous,
        status: "failed",
        error,
        endedAt: event.at,
        receipt: "finished",
      });
      finish(changes, { status: "failed", error: error.message }, event.at);
    }

    return;
  }

  if (event.result.kind === "succeeded") {
    write(changes, {
      ...previous,
      status: "succeeded",
      output,
      endedAt: event.at,
      receipt: "finished",
    });
  }
}

export function step(graph: Graph, state: EngineState, event: EngineEvent): Transition {
  if (state.phase.kind === "finished") {
    return { state, writes: [], next: { kind: "finished", outcome: state.phase.outcome } };
  }

  const changes: Changes = { state: structuredClone(state), writes: [] };

  if (event.kind === "rate_limited") {
    const previous = changes.state.nodeRuns.find((run) =>
      sameExecution(run.key, event.executionKey),
    );

    if (previous?.status === "running" && previous.attempt === event.attempt) {
      write(changes, { ...previous, status: "rate_limited", nextRetryAt: event.retryAt });
    }
  } else if (event.kind === "execution_finished") {
    completion(graph, changes, event);
  }

  return { ...changes, next: advance(graph, changes, event.at) };
}
