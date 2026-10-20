import type { StepRecord } from "loopy/contract";
import { duration, timestamp } from "../lib/format.ts";
import { Countdown } from "./countdown.tsx";
import { JsonPreview } from "./json-preview.tsx";
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
          Next retry <Countdown at={step.nextRetryAt} now={now} />
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
      return null;
    }
  }
}

export function StepRow({ step, now }: { step: StepRecord; now: number }) {
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
      <p className="text-xs text-muted">
        Attempt {step.attempt} of {step.maxAttempts}. Started{" "}
        <time dateTime={step.startedAt}>{timestamp(step.startedAt)}</time>
        {"endedAt" in step && (
          <>
            {". Ended "}
            <time dateTime={step.endedAt}>{timestamp(step.endedAt)}</time>
          </>
        )}
      </p>
      <StepTiming step={step} now={now} />
      <JsonPreview label="Input" value={step.input} />
      {"error" in step && (
        <pre className="font-mono text-xs whitespace-pre-wrap break-words text-danger">
          {step.error}
        </pre>
      )}
      {step.status === "succeeded" && <JsonPreview label="Output" value={step.output} />}
    </article>
  );
}
