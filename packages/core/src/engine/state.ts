import type { AttemptLog, ExecutionError, ExecutionResult } from "../executor";
import type { ExecutionKey } from "../graph/key";
import type { NodeRun } from "../graph/node-run";
import type { Json } from "../json";
import type { RunOutcome } from "../model";

export type EngineState = {
  runId: string;
  input: Json;
  nodeRuns: NodeRun[];
  phase: { kind: "active" } | { kind: "finished"; outcome: RunOutcome };
};

export type Sample = { valueKind: "uuid"; value: string } | { valueKind: "random"; value: number };

export type EngineEvent = { at: string } & (
  | { kind: "run_started" }
  | { kind: "value_sampled"; executionKey: ExecutionKey; sample: Sample }
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

// The run must step again by this time: a retry, a rate-limit window, a wait timeout or a sleep.
export function nextDeadline(nodeRuns: readonly NodeRun[]): string | null {
  const deadlines = nodeRuns.flatMap((run) => {
    switch (run.status) {
      case "retrying":
      case "rate_limited":
        return [run.nextRetryAt];
      case "waiting":
      case "sleeping":
        return run.wakeAt === null ? [] : [run.wakeAt];
      default:
        return [];
    }
  });

  return deadlines.sort()[0] ?? null;
}
