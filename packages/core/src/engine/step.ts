import { errorMessage } from "../errors";
import type { Graph } from "../graph";
import { sameExecution } from "../graph/key";
import type { NodeRun } from "../graph/node-run";
import { isExecutable } from "../graph/nodes";
import { checkOutSchema } from "../record-spec";
import { outputError } from "./failure";
import { addMs, finish, type Transition, write } from "./node-run";
import { resolve } from "./resolve";
import { retryDelayMs, shouldRetry } from "./retry";
import type { EngineEvent, EngineState, Sample } from "./state";
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

  if (!node || !isExecutable(node)) {
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
      write(transition, {
        ...previous,
        status: "retrying",
        error,
        endedAt: event.at,
        nextRetryAt: addMs(event.at, retryDelayMs(previous.attempt)),
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

  // Hosts supply samples through the public reducer, so a value outside its kind's range fails.
  if (validSample(event.sample)) {
    write(transition, {
      ...previous,
      status: "succeeded",
      output: event.sample.value,
      endedAt: event.at,
    });
  } else {
    write(transition, {
      ...previous,
      status: "failed",
      endedAt: event.at,
      error: { code: "validation", message: `Invalid ${node.kind} sample.` },
    });
  }

  return true;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validSample(sample: Sample): boolean {
  return sample.valueKind === "uuid"
    ? UUID_V4.test(sample.value)
    : Number.isFinite(sample.value) && sample.value >= 0 && sample.value < 1;
}

function isPaused(run: NodeRun): run is Extract<NodeRun, { status: "waiting" | "sleeping" }> {
  return run.status === "waiting" || run.status === "sleeping";
}

// A retrying or rate-limited node keeps the run leased until its retry is due.
function suspend(transition: Transition, at: string) {
  if (transition.effects.some((effect) => effect.kind === "dispatch" || effect.kind === "sample")) {
    return;
  }

  if (
    transition.state.nodeRuns.some(
      (run) =>
        run.status === "running" || run.status === "retrying" || run.status === "rate_limited",
    )
  ) {
    return;
  }

  const pending = transition.state.nodeRuns.filter(isPaused);

  if (pending.length === 0) {
    return;
  }

  const wakeAt =
    pending.flatMap((run) => (run.wakeAt === null ? [] : [run.wakeAt])).sort()[0] ?? null;

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
        transition.effects.push({ kind: "schedule_activation", at: event.retryAt });
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
