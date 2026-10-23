import type { ExecutionResult } from "../core/index.js";
import type { Effect, EngineEvent } from "../engine/index.js";

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
