import type { AttemptLog } from "../executor";
import type { Json } from "../json";
import { exceedsInlineLimit } from "../record-spec";
import { failNode, outputError } from "./failure";
import { type Execution, runBase, type Transition, write } from "./node-run";
import type { TraversalResult } from "./traversal";

export function immediate(
  transition: Transition,
  execution: Execution,
  options: { output: Json; log: AttemptLog | null; at: string },
): Extract<TraversalResult, { kind: "succeeded" | "failed" }> {
  const { output, log, at } = options;

  if (exceedsInlineLimit(output)) {
    const error = outputError("output_limit");
    failNode(transition, execution, { error, at });

    return { kind: "failed", error };
  }

  const base = runBase(execution, at);
  write(transition, { ...base, status: "succeeded", endedAt: at, output });

  if (log) {
    transition.effects.push({
      kind: "write_log",
      executionKey: execution.key,
      attempt: base.attempt,
      log,
      at,
    });
  }

  return { kind: "succeeded", output };
}
