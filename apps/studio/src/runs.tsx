import { useState } from "react";
import type { RunDetail, RunRecord } from "./api.ts";
import { formatted, latestAttempts, shortDate, shortId, workspaceName } from "./format.ts";
import { Attempt } from "./inspector.tsx";

function ResumeControls({
  uncertainCount,
  busy,
  onResume,
}: {
  uncertainCount: number;
  busy: boolean;
  onResume: (retryUncertain: boolean) => Promise<void>;
}) {
  const [retryUncertain, setRetryUncertain] = useState(false);
  return (
    <div className="resume-controls">
      {uncertainCount > 0 && (
        <>
          <label>
            <input
              type="checkbox"
              checked={retryUncertain}
              onChange={(event) => setRetryUncertain(event.target.checked)}
            />
            Retry {uncertainCount} uncertain {uncertainCount === 1 ? "step" : "steps"}
          </label>
          <p>
            These steps may have finished before Loopy stopped. Retrying can repeat their side
            effects.
          </p>
        </>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => void onResume(retryUncertain)}
      >
        {busy
          ? "Resuming..."
          : retryUncertain
            ? "Resume and retry uncertain steps"
            : "Resume without retrying uncertain steps"}
      </button>
    </div>
  );
}

function RunDetailView({
  detail,
  busy,
  onResume,
}: {
  detail: RunDetail;
  busy: boolean;
  onResume: (retryUncertain: boolean) => Promise<void>;
}) {
  const { run, attempts, events } = detail;
  const uncertainCount = [...latestAttempts(attempts).values()].filter(
    (attempt) => attempt.status === "uncertain",
  ).length;
  const resumable = run.status === "failed" || run.status === "interrupted";
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
          <dd title={workspaceName(run.options.workspace)}>
            {workspaceName(run.options.workspace)}
          </dd>
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

export function RunPanel({
  runs,
  selectedRunId,
  onSelect,
  detail,
  onResume,
  busy,
}: {
  runs: RunRecord[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  detail: RunDetail | null;
  onResume: (retryUncertain: boolean) => Promise<void>;
  busy: boolean;
}) {
  return (
    <section className="runs-section">
      <div className="section-heading">
        <h3>Runs</h3>
        <span>{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="empty-note">No runs yet. Enter JSON and run this workflow.</p>
      ) : (
        <div className="run-list">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={`run-item${selectedRunId === run.id ? " active" : ""}`}
              onClick={() => onSelect(run.id)}
              aria-pressed={selectedRunId === run.id}
            >
              <span className={`status ${run.status}`}>{run.status}</span>
              <span className="run-id">{shortId(run.id)}</span>
              <time>{shortDate(run.createdAt)}</time>
            </button>
          ))}
        </div>
      )}
      {selectedRunId && !detail && <p className="empty-note">Loading run...</p>}
      {detail && <RunDetailView detail={detail} busy={busy} onResume={onResume} />}
    </section>
  );
}
