import {
  executionKeyString,
  type LogRecord,
  MAX_LOG_BYTES,
  MAX_OUTPUT_BYTES,
  OUTPUT_LIMIT_MESSAGE,
  type NodeRun,
  outputBytes,
  type StoreEffect,
} from "../core/index.js";
import { utc } from "./timestamps.js";

export function checkNodeWrite(runId: string, node: NodeRun) {
  if (node.key.runId !== runId) {
    throw new Error("Node run belongs to another run.");
  }

  if (node.status === "succeeded" && outputBytes(node.output) > MAX_OUTPUT_BYTES) {
    throw new Error(OUTPUT_LIMIT_MESSAGE);
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

export function logRecord(
  previous: LogRecord[],
  effect: Extract<StoreEffect, { kind: "write_log" }>,
) {
  const executionKey = executionKeyString(effect.executionKey);

  const indices = previous.flatMap((log) =>
    log.position.kind === "node" &&
    log.position.executionKey === executionKey &&
    log.position.attempt === effect.attempt
      ? [log.position.index]
      : [],
  );

  return {
    ...effect.log,
    runId: effect.executionKey.runId,
    seq: Math.max(0, ...previous.map((log) => log.seq)) + 1,
    position: {
      kind: "node" as const,
      executionKey,
      attempt: effect.attempt,
      index: Math.max(-1, ...indices) + 1,
    },
    level: "info" as const,
    at: utc(effect.at),
  };
}
