import { type ExecutionResult, isRecord, isString, type Json, limitLogs } from "../core/index.js";

export function redactResult(
  result: ExecutionResult,
  redact: (text: string) => string,
): ExecutionResult {
  function value(input: Json): Json {
    if (isString(input)) {
      return redact(input);
    }

    if (Array.isArray(input)) {
      return input.map(value);
    }

    if (isRecord(input)) {
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [redact(key), value(item)]),
      );
    }

    return input;
  }

  const logs = limitLogs(
    result.logs.map((log) => ({ message: redact(log.message), data: value(log.data) })),
  );

  return result.kind === "succeeded"
    ? { ...result, output: value(result.output), logs }
    : { ...result, error: { ...result.error, message: redact(result.error.message) }, logs };
}
