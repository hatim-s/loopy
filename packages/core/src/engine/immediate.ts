import type { Node } from "../graph/nodes";
import type { Json } from "../json";
import { limitLogs } from "../logs";
import { exceedsInlineLimit } from "../record-spec";
import { failNode, outputError } from "./failure";
import { type Transition, write } from "./node-run";
import { type ResolutionContext, resolve, sameExecution } from "./resolve";
import type { TraversalResult } from "./traversal";

/** Records an inline node's output; the result reports a node that failed the inline cap. */
export function immediate(
  transition: Transition,
  node: Node,
  options: { output: Json; at: string; context: ResolutionContext },
): Extract<TraversalResult, { kind: "succeeded" | "failed" }> {
  const { output, at, context } = options;

  if (exceedsInlineLimit(output)) {
    const error = outputError("output_limit");
    failNode(transition, node, { error, at, scope: context.scope });

    return { kind: "failed", error };
  }

  const [log] =
    node.kind === "log"
      ? limitLogs([
          {
            message: String(resolve(node.message, transition.state, context)),
            data: node.data === null ? null : resolve(node.data, transition.state, context),
          },
        ])
      : [];

  const key = { runId: transition.state.runId, nodeId: node.id, scope: context.scope };
  const previous = transition.state.nodeRuns.find((run) => sameExecution(run.key, key));

  write(transition, {
    key,
    attempt: 1,
    maxAttempts: 1,
    status: "succeeded",
    startedAt: previous?.startedAt ?? at,
    endedAt: at,
    output,
    receipt: "none",
  });

  if (log) {
    transition.effects.push({ kind: "write_log", executionKey: key, attempt: 1, log, at });
  }

  return { kind: "succeeded", output };
}
