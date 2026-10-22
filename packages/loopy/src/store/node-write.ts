import {
  executionKeyString,
  type LogRecord,
  MAX_LOG_BYTES,
  MAX_OUTPUT_BYTES,
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
    throw new Error("Node output exceeds the 1 MiB inline limit.");
  }
}

export function logBytes(log: Pick<LogRecord, "message" | "data">): number {
  return outputBytes({ message: log.message, data: log.data ?? null });
}

export function checkLogBytes(previousBytes: number, log: LogRecord): number {
  const bytes = previousBytes + logBytes(log);

  if (bytes > MAX_LOG_BYTES) {
    throw new Error("Attempt logs exceed the 64 KiB limit.");
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
