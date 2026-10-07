import { latestAttempts } from "loopy";
import type { RunDetail } from "../api.ts";
import { formatted, shortDate, workspaceName } from "../lib/format.ts";
import { Attempt } from "./attempt.tsx";
import { ResumeControls } from "./resume-controls.tsx";

type RunDetailViewProps = {
  detail: RunDetail;
  busy: boolean;
  onResume: (retryUncertain: boolean) => Promise<void>;
};

export function RunDetailView({ detail, busy, onResume }: RunDetailViewProps) {
  const { run, attempts, events } = detail;
  const uncertainCount = [...latestAttempts(attempts).values()].filter(
    (attempt) => attempt.status === "uncertain",
  ).length;
  const resumable = run.status === "failed" || run.status === "interrupted";
  const directory = workspaceName(run.options.workspace);
  return (
    <div className="run-detail">
      <div className="run-detail-head">
        <div>
          <strong>{run.status}</strong>
          <code title={run.id}>{run.id}</code>
        </div>
        <span>{run.options.mode}</span>
      </div>
      {run.error && <pre className="error-output">{run.error}</pre>}
      <dl className="run-meta">
        <div>
          <dt>Started</dt>
          <dd>{shortDate(run.createdAt)}</dd>
        </div>
        <div>
          <dt>Directory</dt>
          <dd title={directory}>{directory}</dd>
        </div>
      </dl>
      {resumable && (
        <ResumeControls uncertainCount={uncertainCount} busy={busy} onResume={onResume} />
      )}
      <details className="run-input">
        <summary>Run input</summary>
        <pre>{formatted(run.input)}</pre>
      </details>
      <div className="detail-list">
        <h4>Attempts</h4>
        {attempts.length === 0 ? (
          <p className="empty-note">Waiting for the first step.</p>
        ) : (
          attempts.map((attempt) => (
            <details key={attempt.id} className="attempt-fold">
              <summary>
                <span>
                  {attempt.nodeId} <small>#{attempt.number}</small>
                </span>
                <span className={`status ${attempt.status}`}>{attempt.status}</span>
              </summary>
              <Attempt attempt={attempt} />
            </details>
          ))
        )}
      </div>
      <div className="detail-list">
        <h4>Events</h4>
        {events.length === 0 ? (
          <p className="empty-note">No events yet.</p>
        ) : (
          <ol className="event-list">
            {events.map((event) => (
              <li key={event.sequence}>
                <span className="event-time">{shortDate(event.createdAt)}</span>
                <strong>{event.type}</strong>
                {event.nodeId && <code>{event.nodeId}</code>}
                <details>
                  <summary>Data</summary>
                  <pre>{formatted(event.data)}</pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
