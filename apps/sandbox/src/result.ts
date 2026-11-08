import { type ExecutionResult } from "@loopy/contract";
import { SANDBOX_MAX_CAPTURE_BYTES } from "@loopy/contract/sandbox";
import { limitLogs, MAX_OUTPUT_BYTES, outputBytes } from "@loopy/core";

export function failed(
  code: Extract<ExecutionResult, { kind: "failed" }>["error"]["code"],
  message: string,
): ExecutionResult {
  return { kind: "failed", error: { code, message }, exitCode: null, logs: [] };
}

export function boundedResult(result: ExecutionResult): ExecutionResult {
  if (result.kind === "succeeded" && outputBytes(result.output) > MAX_OUTPUT_BYTES) {
    return failed("output_limit", `Attempt output exceeds ${MAX_OUTPUT_BYTES} bytes.`);
  }

  const bounded = { ...result, logs: limitLogs(result.logs) };

  return Buffer.byteLength(JSON.stringify(bounded)) > SANDBOX_MAX_CAPTURE_BYTES
    ? failed("output_limit", "Attempt terminal result exceeds its serialized byte limit.")
    : bounded;
}
