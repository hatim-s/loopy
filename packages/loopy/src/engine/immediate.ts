import { type Json, limitLogs, MAX_OUTPUT_BYTES, type Node, outputBytes } from "../core/index.js";
import { failNode } from "./failure.js";
import { type Transition, write } from "./node-run.js";
import { resolve } from "./resolve.js";

export function immediate(transition: Transition, node: Node, output: Json, at: string) {
  if (outputBytes(output) > MAX_OUTPUT_BYTES) {
    failNode(
      transition,
      node,
      { code: "output_limit", message: "Node output exceeds the 1 MiB inline limit." },
      at,
    );

    return;
  }

  const [log] =
    node.kind === "log"
      ? limitLogs([
          {
            message: String(resolve(node.message, transition.state)),
            data: node.data === null ? null : resolve(node.data, transition.state),
          },
        ])
      : [];

  const key = { runId: transition.state.runId, nodeId: node.id, scope: [] };
  write(transition, {
    key,
    attempt: 1,
    maxAttempts: 1,
    status: "succeeded",
    startedAt: at,
    endedAt: at,
    output,
    receipt: "none",
  });

  if (log) {
    transition.effects.push({ kind: "write_log", executionKey: key, attempt: 1, log, at });
  }
}
