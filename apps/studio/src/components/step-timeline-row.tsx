import type { LogRecord, StepRecord } from "loopy";
import { duration } from "../lib/format.ts";
import { Countdown } from "./countdown.tsx";
import { JsonPreview } from "./json-preview.tsx";
import { LogLines } from "./log-lines.tsx";
import { StatusBadge } from "./status-badge.tsx";

export function StepTimelineRow({
  step,
  logs,
  now,
}: {
  step: StepRecord;
  logs: LogRecord[];
  now: number;
}) {
  return (
    <article className="step-card">
      <header className="step-heading">
        <span className="step-seq">{step.seq}</span>
        <h4>{step.key}</h4>
        <span className="kind">{step.kind}</span>
        <StatusBadge status={step.status} />
      </header>
      <p className="step-meta">
        Attempt {step.attempt}/{step.maxAttempts} ·{" "}
        {duration(step.startedAt, "endedAt" in step ? Date.parse(step.endedAt) : now)}
      </p>
      {step.status === "retrying" && <Countdown label="Next retry" at={step.nextRetryAt} />}
      {step.status === "sleeping" && <Countdown label="Wakes" at={step.wakeAt} />}
      {"hook" in step && <p>Hook: {String(step.hook)}</p>}
      {"error" in step && <pre className="error-text">{step.error}</pre>}
      {step.status === "succeeded" && <JsonPreview label="Output" value={step.output} />}
      <LogLines logs={logs} />
    </article>
  );
}
