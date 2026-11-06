import type { ExecutionResult } from "@loopy/core";
import type { Effect, EngineEvent } from "@loopy/core/engine";

export function completionEvent(
  dispatch: Extract<Effect, { kind: "dispatch" }>,
  result: ExecutionResult,
  at: string,
): EngineEvent {
  const base = { executionKey: dispatch.executionKey, attempt: dispatch.attempt, at };

  return result.kind === "failed"
    ? {
        ...base,
        kind: "execution_failed",
        error: result.error,
        exitCode: result.exitCode,
        logs: result.logs,
      }
    : { ...base, kind: "execution_completed", result };
}
