import type { AttemptRecord } from "./model.js";

/** The newest attempt per node. Attempt numbers are unique within a node, so no tie-break is needed. */
export function latestAttempts(attempts: readonly AttemptRecord[]): Map<string, AttemptRecord> {
  const latest = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const prior = latest.get(attempt.nodeId);
    if (!prior || attempt.number > prior.number) {
      latest.set(attempt.nodeId, attempt);
    }
  }
  return latest;
}
