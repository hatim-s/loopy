import type { RunDetail as Detail } from "loopy";
import { useClock } from "../hooks/use-clock.ts";
import { timestamp } from "../lib/format.ts";
import { groupTimeline } from "../lib/timeline.ts";
import { Countdown } from "./countdown.tsx";
import { JsonPreview } from "./json-preview.tsx";
import { LogLines } from "./log-lines.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { StepTimelineRow } from "./step-timeline-row.tsx";

export function RunDetail({ detail }: { detail: Detail }) {
  const { run, steps, logs } = detail;
  const timeline = groupTimeline(steps, logs);
  const now = useClock();

  return (
    <section className="trace" aria-label="Run detail">
      <header className="detail-header">
        <div className="section-heading">
          <h2>Run detail</h2>
          <StatusBadge status={run.status} />
        </div>
        <code className="run-id">{run.id}</code>
        <dl>
          <dt>Created</dt>
          <dd>
            <time dateTime={run.createdAt}>{timestamp(run.createdAt)}</time>
          </dd>
          <dt>Workspace</dt>
          <dd>{run.workspace}</dd>
          {run.status === "running" && run.owner && (
            <>
              <dt>Owner</dt>
              <dd>
                {run.owner.host} · PID {run.owner.pid}
                <br />
                Heartbeat {timestamp(run.owner.heartbeatAt)}
              </dd>
            </>
          )}
        </dl>
        {run.status === "suspended" && run.wakeAt && <Countdown label="Wakes" at={run.wakeAt} />}
        <JsonPreview label="Input" value={run.input} />
        {run.output !== undefined && <JsonPreview label="Output" value={run.output} />}
        {run.error && (
          <pre className="error-text" role="alert">
            {run.error}
          </pre>
        )}
      </header>
      <div className="section-heading">
        <h3>Step trace</h3>
        <span>
          {steps.length} steps · {logs.length} logs
        </span>
      </div>
      <LogLines logs={timeline.before} />
      {steps.length === 0 && <p className="empty-state">No recorded steps yet.</p>}
      <ol className="timeline">
        {timeline.steps.map(({ step, logs: stepLogs, after }) => (
          <li key={step.seq}>
            <StepTimelineRow step={step} logs={stepLogs} now={now} />
            <LogLines logs={after} />
          </li>
        ))}
      </ol>
    </section>
  );
}
