import { type ExecutionResult, isRecord, isString, type Json, limitLogs } from "../core/index.js";

export function redactResult(
  result: ExecutionResult,
  redact: (text: string) => string,
): ExecutionResult {
  const logs = limitLogs(
    result.logs.map((log) => ({
      message: redact(log.message),
      data: redactValue(log.data, redact),
    })),
  );

  return result.kind === "succeeded"
    ? { ...result, output: redactValue(result.output, redact), logs }
    : { ...result, error: { ...result.error, message: redact(result.error.message) }, logs };
}

export function redactValue(input: Json, redact: (text: string) => string): Json {
  if (isString(input)) {
    return redact(input);
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, redact));
  }

  if (isRecord(input)) {
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [redact(key), redactValue(item, redact)]),
    );
  }

  return input;
}
