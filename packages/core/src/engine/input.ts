import { MAX_PREVIEW_BYTES, outputBytes } from "../effects";
import type { ExecutionSpec } from "../executor";
import type { NodeRun } from "../graph/node-run";

export function captureInput(spec: ExecutionSpec): NodeRun["inputView"] {
  // Command descriptors can contain credentials in several fields, including env.
  if (spec.kind !== "code") {
    return undefined;
  }

  const bytes = outputBytes(spec.input);

  return bytes > MAX_PREVIEW_BYTES
    ? { state: "truncated", bytes }
    : { state: "available", value: structuredClone(spec.input) };
}
