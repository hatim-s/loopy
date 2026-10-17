import type { LogRecord, StepRecord } from "loopy/contract";
import { duration } from "../lib/format.ts";
import { Countdown } from "./countdown.tsx";
import { JsonPreview } from "./json-preview.tsx";
import { LogLines } from "./log-lines.tsx";
import { StatusBadge } from "./status-badge.tsx";

const RAIL = {
  running: "border-active",
  succeeded: "border-success/50",
  failed: "border-danger",
  retrying: "border-attention",
  sleeping: "border-attention/60",
  waiting: "border-attention",
} satisfies Record<StepRecord["status"], string>;

function StepTiming({ step, now }: { step: StepRecord; now: number }) {
  switch (step.status) {
    case "retrying": {
      return (
        <p className="text-attention">
          Attempt {step.attempt} of {step.maxAttempts} failed. Next retry{" "}
          <Countdown at={step.nextRetryAt} now={now} />
        </p>
      );
    }

    case "sleeping": {
      return (
        <p className="text-attention">
          Wakes <Countdown at={step.wakeAt} now={now} />
        </p>
      );
    }

    case "waiting": {
      return (
        <p className="text-attention">
          Waiting for a person
          {step.wakeAt !== undefined && (
            <>
              , expires <Countdown at={step.wakeAt} now={now} />
            </>
          )}
        </p>
      );
    }

    default: {
      return step.maxAttempts > 1 && step.attempt > 1 ? (
        <p className="text-muted">
          Attempt {step.attempt} of {step.maxAttempts}
        </p>
      ) : null;
    }
  }
}

export function StepRow({ step, logs, now }: { step: StepRecord; logs: LogRecord[]; now: number }) {
  const end = "endedAt" in step ? Date.parse(step.endedAt) : now;

  return (
    <article className={`space-y-1.5 border-l-2 py-1.5 pl-4 ${RAIL[step.status]}`}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium break-all">{step.key}</h3>
        <span className="text-xs text-muted">{step.kind}</span>
        <span className="ml-auto flex items-baseline gap-3">
          <StatusBadge status={step.status} />
          <span className="w-14 text-right font-mono text-xs text-muted tabular-nums">
            {duration(step.startedAt, end)}
          </span>
        </span>
      </header>
      <StepTiming step={step} now={now} />
      {"error" in step && (
        <pre className="font-mono text-xs whitespace-pre-wrap text-danger">{step.error}</pre>
      )}
      {step.status === "succeeded" && <JsonPreview label="Output" value={step.output} />}
      <LogLines logs={logs} />
    </article>
  );
}
