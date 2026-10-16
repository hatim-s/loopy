import type { RunRecord, StepRecord } from "../core/index.js";

export function canResolveHook(run: RunRecord, step: StepRecord, now: number): boolean {
  return (
    (run.status === "running" || run.status === "suspended") &&
    step.kind === "hook" &&
    step.status === "waiting" &&
    (step.wakeAt === undefined || Date.parse(step.wakeAt) > now)
  );
}

export function earliestWake(left?: string, right?: string): string | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return Date.parse(left) <= Date.parse(right) ? left : right;
}
