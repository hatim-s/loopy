import type {
  ExecutionKey,
  ExecutionResult,
  ExecutionSpec,
  Json,
  NodeRun,
  RunOutcome,
  StoreEffect,
} from "../core/index.js";

export type EngineState = {
  runId: string;
  input: Json;
  nodeRuns: NodeRun[];
  phase: { kind: "active" } | { kind: "finished"; outcome: RunOutcome };
};

export type EngineEvent = { at: string } & (
  | { kind: "resume" }
  | {
      kind: "execution_finished";
      executionKey: ExecutionKey;
      attempt: number;
      result: ExecutionResult;
    }
  | { kind: "rate_limited"; executionKey: ExecutionKey; attempt: number; retryAt: string }
);

export type Transition = {
  state: EngineState;
  writes: StoreEffect[];
  next:
    | { kind: "dispatch"; executionKey: ExecutionKey; attempt: number; spec: ExecutionSpec }
    | { kind: "wait"; at: string }
    | { kind: "finished"; outcome: RunOutcome };
};

export type Changes = Pick<Transition, "state" | "writes">;

export function nodeRunFor(state: EngineState, nodeId: string) {
  return state.nodeRuns.find((run) => run.key.nodeId === nodeId && run.key.scope.length === 0);
}

export function initialState(runId: string, input: Json, nodeRuns: NodeRun[] = []): EngineState {
  return { runId, input, nodeRuns, phase: { kind: "active" } };
}
