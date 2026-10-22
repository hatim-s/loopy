import type { NodeRun, RunOutcome } from "../core/index.js";
import type { Effect } from "./effects.js";
import { sameExecution } from "./resolve.js";
import type { EngineState } from "./state.js";

export type Transition = { state: EngineState; effects: Effect[] };

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
