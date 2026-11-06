import {
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxExecutionResult,
} from "../../../packages/loopy/src/contract";
import { limitLogs, MAX_OUTPUT_BYTES, outputBytes } from "../../../packages/loopy/src/core";

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

  const bounded = { ...result, logs: limitLogs(result.logs) };

  return Buffer.byteLength(JSON.stringify(bounded)) > SANDBOX_MAX_CAPTURE_BYTES
    ? failed("output_limit", "Attempt terminal result exceeds its serialized byte limit.")
    : bounded;
}
