import type { RunRecord } from "loopy";

export function shouldPoll(run: RunRecord, visible: boolean, now: number): boolean {
  return (
    visible &&
    (run.status === "queued" ||
      run.status === "running" ||
      (run.status === "suspended" && run.wakeAt !== undefined && Date.parse(run.wakeAt) <= now))
  );
}
