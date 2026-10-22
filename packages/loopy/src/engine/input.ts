import { type ExecutionSpec, type NodeRun, outputBytes } from "../core/index.js";

const MAX_INPUT_BYTES = 16 * 1024;

export function captureInput(spec: ExecutionSpec): NodeRun["inputView"] {
  // Command descriptors can contain credentials in several fields, including env.
  if (spec.kind !== "code") {
    return undefined;
  }

  const bytes = outputBytes(spec.input);

  return bytes > MAX_INPUT_BYTES
    ? { state: "truncated", bytes }
    : { state: "available", value: structuredClone(spec.input) };
}
