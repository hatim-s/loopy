import type { LogRecord, StepRecord } from "loopy/contract";

type StepEntry = { step: StepRecord; logs: LogRecord[]; after: LogRecord[] };

export type Timeline = { before: LogRecord[]; steps: StepEntry[] };

/**
 * Places each log under the step that wrote it, or after the step the workflow had just
 * finished. One pass over the logs; neither input is reordered.
 */
export function groupTimeline(steps: StepRecord[], logs: LogRecord[]): Timeline {
  const entries = new Map(
    [...steps]
      .sort((a, b) => a.seq - b.seq)
      .map((step): [number, StepEntry] => [step.seq, { step, logs: [], after: [] }]),
  );

  const before: LogRecord[] = [];

  for (const log of [...logs].sort((a, b) => a.seq - b.seq)) {
    const { position } = log;

    if (position.kind === "step") {
      entries.get(position.seq)?.logs.push(log);
    } else if (position.afterStep === 0) {
      before.push(log);
    } else {
      entries.get(position.afterStep)?.after.push(log);
    }
  }

  return { before, steps: [...entries.values()] };
}
