import { errorMessage, type Graph, isNumber, isString } from "../core/index.js";
import { finish, type Transition, write } from "./node-run.js";
import { validateOutput } from "./output.js";
import { resolve, sameExecution } from "./resolve.js";
import { retryDelayMs, shouldRetry } from "./retry.js";
import type { EngineEvent, EngineState } from "./state.js";
import { sequence } from "./traversal.js";

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

  if (previous?.status !== "running" || (node?.kind !== "uuid" && node?.kind !== "random")) {
    return false;
  }

  if (
    (node.kind === "uuid" &&
      (!isString(event.value) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          event.value,
        ))) ||
    (node.kind === "random" &&
      (!isNumber(event.value) ||
        !Number.isFinite(event.value) ||
        event.value < 0 ||
        event.value >= 1))
  ) {
    write(transition, {
      ...previous,
      status: "failed",
      endedAt: event.at,
      error: { code: "validation", message: `Invalid ${node.kind} sample.` },
    });
  } else {
    write(transition, { ...previous, status: "succeeded", output: event.value, endedAt: event.at });
  }

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
        graph,
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
