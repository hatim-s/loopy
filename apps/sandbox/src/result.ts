import type { SandboxExecutionResult } from "../../../packages/loopy/src/contract/index.js";
import {
  limitLogs,
  MAX_OUTPUT_BYTES,
  outputBytes,
} from "../../../packages/loopy/src/core/index.js";

export function failed(
  code: Extract<SandboxExecutionResult, { kind: "failed" }>["error"]["code"],
  message: string,
): SandboxExecutionResult {
  return { kind: "failed", error: { code, message }, exitCode: null, logs: [] };
}

export function boundedResult(result: SandboxExecutionResult): SandboxExecutionResult {
  if (result.kind === "succeeded" && outputBytes(result.output) > MAX_OUTPUT_BYTES) {
    return failed("output_limit", `Attempt output exceeds ${MAX_OUTPUT_BYTES} bytes.`);
  }

  return { ...result, logs: limitLogs(result.logs) };
}
