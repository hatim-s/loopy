import type { Json, StepRecord } from "../core/index.js";
import { StepFailedError } from "./step-runner.js";

export function replayStep(stored: Extract<StepRecord, { status: "succeeded" | "failed" }>): Json {
  if (stored.status === "failed") {
    throw new StepFailedError(stored.key, stored.error);
  }

  return structuredClone(stored.output);
}
