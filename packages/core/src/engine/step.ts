import { errorMessage } from "../errors";
import type { Graph } from "../graph";
import { checkOutSchema } from "../record-spec";
import { outputError } from "./failure";
import { finish, type Transition, write } from "./node-run";
import { resolve, sameExecution } from "./resolve";
import { retryDelayMs, shouldRetry } from "./retry";
import type { EngineEvent, EngineState } from "./state";
import { sequence } from "./traversal";

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

  const logs = event.kind === "execution_completed" ? event.result.logs : event.logs;
  transition.effects.push(
    ...logs.map((log) => ({
      kind: "write_log" as const,
      executionKey: previous.key,
      attempt: previous.attempt,
      log,
      at: event.at,
    })),
  );

  const issue =
    event.kind === "execution_completed" ? checkOutSchema(event.result.output, node.out) : null;

  const error = event.kind === "execution_failed" ? event.error : issue && outputError(issue);

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
    } else {
      write(transition, {
        ...previous,
        status: "failed",
        error,
        endedAt: event.at,
        receipt: "finished",
      });
    }
  } else if (event.kind === "execution_completed") {
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

function sampled(
  graph: Graph,
  transition: Transition,
  event: Extract<EngineEvent, { kind: "value_sampled" }>,
) {
  const previous = transition.state.nodeRuns.find((run) =>
    sameExecution(run.key, event.executionKey),
  );

  const node = graph.nodes.find((node) => node.id === previous?.key.nodeId);

  if (previous?.status !== "running" || node?.kind !== event.sample.valueKind) {
    return false;
  }

  write(transition, {
    ...previous,
    status: "succeeded",
    output: event.sample.value,
    endedAt: event.at,
  });

  return true;
}

function suspend(transition: Transition, at: string) {
  if (transition.effects.some((effect) => effect.kind === "dispatch" || effect.kind === "sample")) {
    return;
  }

  const pending = transition.state.nodeRuns.filter(
    (run) => run.status === "waiting" || run.status === "sleeping",
  );

  const executing = transition.state.nodeRuns.some((run) => run.status === "running");

  if (pending.length === 0 || executing) {
    return;
  }

  const deadlines = pending.flatMap((run) =>
    (run.status === "waiting" || run.status === "sleeping") && run.wakeAt !== null
      ? [run.wakeAt]
      : [],
  );

  const retry = transition.effects
    .filter((effect) => effect.kind === "schedule_retry")
    .map((effect) => effect.at);

  const wakeAt = [...deadlines, ...retry].sort()[0] ?? null;
  transition.effects.push({ kind: "suspend_run", wakeAt, at });
}

export function step(graph: Graph, state: EngineState, event: EngineEvent): Transition {
  if (state.phase.kind === "finished") {
    return { state, effects: [] };
  }

  const transition: Transition = { state: structuredClone(state), effects: [] };

  try {
    if (event.kind === "rate_limited") {
      const previous = transition.state.nodeRuns.find((run) =>
        sameExecution(run.key, event.executionKey),
      );

      if (previous?.status === "running" && previous.attempt === event.attempt) {
        write(transition, { ...previous, status: "rate_limited", nextRetryAt: event.retryAt });
        transition.effects.push({ kind: "schedule_retry", at: event.retryAt });
      }

      return transition;
    }

    if (
      (event.kind === "execution_completed" || event.kind === "execution_failed") &&
      !completion(graph, transition, event)
    ) {
      return transition;
    }

    if (event.kind === "value_sampled" && !sampled(graph, transition, event)) {
      return transition;
    }

    const result = sequence(
      {
        graph: { graph, nodes: new Map(graph.nodes.map((node) => [node.id, node])) },
        transition,
        at: event.at,
        rehydrate: event.kind === "run_started",
        cancelling: event.kind === "cancel_requested",
      },
      graph.entry,
    );

    switch (result.kind) {
      case "succeeded":
        finish(
          transition,
          {
            status: "succeeded",
            output: graph.outputs === null ? null : resolve(graph.outputs, transition.state),
          },
          event.at,
        );
        break;
      case "failed":
        finish(transition, { status: "failed", error: result.error.message }, event.at);
        break;
      case "cancelled":
        finish(transition, { status: "cancelled" }, event.at);
        break;
      case "pending":
        suspend(transition, event.at);
        break;
    }
  } catch (cause) {
    finish(transition, { status: "failed", error: errorMessage(cause) }, event.at);
  }

  return transition;
}
