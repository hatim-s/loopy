import type {
  AttemptLog,
  ExecutionError,
  ExecutionKey,
  ExecutionResult,
  Json,
  NodeRun,
  RunOutcome,
} from "../core/index.js";

export type EngineState = {
  runId: string;
  input: Json;
  nodeRuns: NodeRun[];
  phase: { kind: "active" } | { kind: "finished"; outcome: RunOutcome };
};

export type EngineEvent = { at: string } & (
  | { kind: "run_started" }
  | {
      kind: "execution_completed";
      executionKey: ExecutionKey;
      attempt: number;
      result: Extract<ExecutionResult, { kind: "succeeded" }>;
    }
  | {
      kind: "execution_failed";
      executionKey: ExecutionKey;
      attempt: number;
      error: ExecutionError;
      exitCode: number | null;
      logs: AttemptLog[];
    }
  | { kind: "rate_limited"; executionKey: ExecutionKey; attempt: number; retryAt: string }
  | { kind: "retry_due" }
  | { kind: "cancel_requested" }
);

export function initialState(runId: string, input: Json, nodeRuns: NodeRun[] = []): EngineState {
  return { runId, input, nodeRuns, phase: { kind: "active" } };
}
