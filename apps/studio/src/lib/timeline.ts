import type { LogRecord, StepRecord } from "loopy";

export function groupTimeline(steps: StepRecord[], logs: LogRecord[]) {
  const ordered = [...logs].sort((a, b) => a.seq - b.seq);

  return {
    before: ordered.filter(
      (log) => log.position.kind === "workflow" && log.position.afterStep === 0,
    ),
    steps: [...steps]
      .sort((a, b) => a.seq - b.seq)
      .map((step) => ({
        step,
        logs: ordered.filter(
          (log) => log.position.kind === "step" && log.position.seq === step.seq,
        ),
        after: ordered.filter(
          (log) => log.position.kind === "workflow" && log.position.afterStep === step.seq,
        ),
      })),
  };
}
