import { useEffect, useState } from "react";
import type { ApiClient } from "../../app/api";
import type { DebuggerEvent } from "../types";
import { ApprovalControls } from "./approval-controls";

export type BuilderRun = {
  id: string;
  status: string;
  attempts: Array<{
    id: string;
    nodeId: string;
    attemptId?: string;
    attempt: number;
    status: string;
    output?: Record<string, unknown>;
    error?: string;
  }>;
  events: DebuggerEvent[];
};
export function RunConsole({
  api,
  runId,
  onStatuses,
}: {
  api: ApiClient;
  runId: string;
  onStatuses: (statuses: Record<string, string>) => void;
}) {
  const [run, setRun] = useState<BuilderRun>();
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Controls restart polling after a terminal run is retried.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let retryDelay = 500;
    const refresh = async () => {
      try {
        const next = await api.request<BuilderRun>(`/runs/${runId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        retryDelay = 500;
        setRun(next);
        setError(undefined);
        onStatuses(
          Object.fromEntries(next.attempts.map((attempt) => [attempt.nodeId, attempt.status])),
        );
        if (!["succeeded", "failed", "cancelled"].includes(next.status))
          timer = setTimeout(() => void refresh(), 500);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
          timer = setTimeout(() => void refresh(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, runId, onStatuses, refreshKey]);
  const control = async (action: string, body: Record<string, unknown> = {}) => {
    try {
      await api.request(`/runs/${runId}/${action}`, { method: "POST", body: JSON.stringify(body) });
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const cancel = async () => {
    try {
      await api.request(`/runs/${runId}/cancel`, { method: "POST", body: "{}" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <section className="builder-run-console" aria-label="Run console">
      <header>
        <strong>Run output</strong>
        <span className={`run-state run-state-${run?.status}`}>{run?.status ?? "Loading"}</span>
        <a href={`/runs?runId=${encodeURIComponent(runId)}`}>Open debugger</a>
        {run?.status === "running" ? (
          <button type="button" onClick={() => void control("pause")}>
            Pause run
          </button>
        ) : null}
        {run?.status === "paused" ? (
          <button type="button" onClick={() => void control("resume")}>
            Resume run
          </button>
        ) : null}
        {run && !["succeeded", "failed", "cancelled"].includes(run.status) ? (
          <button type="button" onClick={() => void cancel()}>
            Cancel run
          </button>
        ) : null}
      </header>
      <ApprovalControls
        attempts={(run?.attempts ?? []).map((attempt) => ({
          ...attempt,
          attemptId: attempt.attemptId ?? attempt.id,
        }))}
        events={run?.events ?? []}
        onDecision={(nodeId, attemptId, decision) =>
          control("approve", { nodeId, attemptId, decision })
        }
      />
      {run?.status === "failed"
        ? run.attempts
            .filter((attempt) => attempt.status === "failed")
            .map((attempt) => (
              <button
                type="button"
                key={attempt.id}
                onClick={() => void control("retry", { nodeId: attempt.nodeId })}
              >
                Retry {attempt.nodeId}
              </button>
            ))
        : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="run-attempts">
        {run?.attempts.map((attempt) => (
          <details key={attempt.id} open>
            <summary>
              {attempt.status} · attempt {attempt.attempt} · {attempt.nodeId.slice(0, 8)}
            </summary>
            <pre>
              {attempt.error ??
                (typeof attempt.output?.stdout === "string"
                  ? attempt.output.stdout
                  : JSON.stringify(attempt.output ?? {}, null, 2))}
            </pre>
            {attempt.output?.stderr ? <pre>{String(attempt.output.stderr)}</pre> : null}
          </details>
        ))}
      </div>
    </section>
  );
}
