import type { RunRecord } from "loopy";

export function nextPollDelay(
  run: Pick<RunRecord, "status" | "wakeAt">,
  visible: boolean,
  now: number,
): number | undefined {
  if (!visible) {
    return undefined;
  }

  if (run.status === "queued" || run.status === "running") {
    return 2000;
  }

  if (run.status === "suspended") {
    const untilWake = run.wakeAt ? Date.parse(run.wakeAt) - now : 10_000;

    return untilWake <= 0 ? 2000 : Math.min(10_000, untilWake);
  }

  return undefined;
}
