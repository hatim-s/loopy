import { type Json, limitLogs, MAX_OUTPUT_BYTES, type Node, outputBytes } from "../core/index.js";
import { failNode } from "./failure.js";
import { type Transition, write } from "./node-run.js";
import { type ResolutionContext, resolve, sameExecution } from "./resolve.js";

export function immediate(
  transition: Transition,
  node: Node,
  options: { output: Json; at: string; context: ResolutionContext },
) {
  const { output, at, context } = options;

  if (outputBytes(output) > MAX_OUTPUT_BYTES) {
    failNode(transition, node, {
      error: { code: "output_limit", message: "Node output exceeds the 1 MiB inline limit." },
      at,
      scope: context.scope,
    });

    return;
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
}
