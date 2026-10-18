import {
  type LogRecord,
  MAX_LOG_BYTES,
  MAX_OUTPUT_BYTES,
  type NodeRun,
  outputBytes,
} from "../core/index.js";

export function checkNodeWrite(runId: string, node: NodeRun) {
  if (node.key.runId !== runId) {
    throw new Error("Node run belongs to another run.");
  }

  if (node.status === "succeeded" && outputBytes(node.output) > MAX_OUTPUT_BYTES) {
    throw new Error("Node output exceeds the 1 MiB inline limit.");
  }
}

export function checkLogWrite(previous: LogRecord[], log: LogRecord) {
  const position = log.position;

  if (position.kind !== "node") {
    throw new Error("Attempt logs require a node execution key.");
  }

  const bytes = [...previous, log]
    .filter(
      (item) =>
        item.position.kind === "node" &&
        item.position.executionKey === position.executionKey &&
        item.position.attempt === position.attempt,
    )
    .reduce(
      (total, item) => total + outputBytes({ message: item.message, data: item.data ?? null }),
      0,
    );

  if (bytes > MAX_LOG_BYTES) {
    throw new Error("Attempt logs exceed the 64 KiB limit.");
  }
}
