import { type ExecutionKey, sameExecution } from "../graph/key";
import type { NodeRun } from "../graph/node-run";
import type { Node } from "../graph/nodes";
import type { RunOutcome } from "../model";
import type { EngineEffect } from "./effects";
import type { ResolutionContext } from "./resolve";
import type { EngineState } from "./state";

export type Transition = { state: EngineState; effects: EngineEffect[] };

/** One node evaluated in one scope, with the run it left behind on an earlier step. */
export type Execution<N extends Node = Node> = {
  node: N;
  key: ExecutionKey;
  previous: NodeRun | undefined;
  context: ResolutionContext;
};

// A later write for the same execution keeps its attempt, start and receipt.
export function runBase(execution: Execution, at: string, maxAttempts = 1) {
  const { key, previous } = execution;

  return {
    key,
    attempt: previous?.attempt ?? 1,
    maxAttempts: previous?.maxAttempts ?? maxAttempts,
    startedAt: previous?.startedAt ?? at,
    receipt: previous?.receipt ?? "none",
  };
}

export function addMs(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

export function write(transition: Transition, nodeRun: NodeRun) {
  const index = transition.state.nodeRuns.findIndex((run) => sameExecution(run.key, nodeRun.key));
  const previous = transition.state.nodeRuns[index];

  if (
    nodeRun.inputView === undefined &&
    previous?.attempt === nodeRun.attempt &&
    previous.inputView !== undefined
  ) {
    nodeRun.inputView = previous.inputView;
  }

  if (index < 0) {
    transition.state.nodeRuns.push(nodeRun);
  } else {
    transition.state.nodeRuns[index] = nodeRun;
  }

  transition.effects.push({ kind: "write_node_run", nodeRun });
}

export function finish(transition: Transition, outcome: RunOutcome, at: string) {
  transition.state.phase = { kind: "finished", outcome };
  transition.effects.push({ kind: "finish_run", outcome, at });
}
