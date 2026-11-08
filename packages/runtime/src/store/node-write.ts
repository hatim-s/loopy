import {
  exceedsInlineLimit,
  executionKeyString,
  type LogRecord,
  MAX_LOG_BYTES,
  type NodeRun,
  outputBytes,
  outSchemaMessage,
  type StoreEffect,
} from "@loopy/core";
import { StoreRejectedError } from "./operation";
import { utc } from "./timestamps";

// The store is a public port, so it holds the inline cap even for writers other than the reducer.
export function checkNodeWrite(node: NodeRun) {
  if (node.status === "succeeded" && exceedsInlineLimit(node.output)) {
    throw new StoreRejectedError(outSchemaMessage("Node output", "output_limit"));
  }
}

export function logBytes(log: Pick<LogRecord, "message" | "data">): number {
  return outputBytes({ message: log.message, data: log.data ?? null });
}

export function checkLogBytes(previousBytes: number, log: LogRecord): number {
  const bytes = previousBytes + logBytes(log);

  if (bytes > MAX_LOG_BYTES) {
    throw new StoreRejectedError("Attempt logs exceed the 64 KiB limit.");
  }

  return bytes;
}

export function logRecord(
  position: { seq: number; index: number },
  effect: Extract<StoreEffect, { kind: "write_log" }>,
) {
  return {
    ...effect.log,
    runId: effect.executionKey.runId,
    seq: position.seq,
    position: {
      kind: "node" as const,
      executionKey: executionKeyString(effect.executionKey),
      attempt: effect.attempt,
      index: position.index,
    },
    level: "info" as const,
    at: utc(effect.at),
  };
}
