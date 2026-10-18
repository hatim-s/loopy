import type { NodeRun, RunRecord } from "../core/index.js";

export function utc(value: string): string {
  return new Date(value).toISOString();
}

export function normalizeNode(node: NodeRun): NodeRun {
  const record = { ...node, startedAt: utc(node.startedAt) };

  if ("endedAt" in record) {
    record.endedAt = utc(record.endedAt);
  }

  if ("nextRetryAt" in record) {
    record.nextRetryAt = utc(record.nextRetryAt);
  }

  if ("wakeAt" in record && record.wakeAt !== null) {
    record.wakeAt = utc(record.wakeAt);
  }

  return record;
}

export function normalizeRun(run: RunRecord): RunRecord {
  const record = { ...run, createdAt: utc(run.createdAt), updatedAt: utc(run.updatedAt) };

  if (record.wakeAt !== undefined) {
    record.wakeAt = utc(record.wakeAt);
  }

  if (record.nextRetryAt !== undefined) {
    record.nextRetryAt = utc(record.nextRetryAt);
  }

  if (record.owner !== undefined) {
    record.owner = { ...record.owner, heartbeatAt: utc(record.owner.heartbeatAt) };
  }

  return record;
}
