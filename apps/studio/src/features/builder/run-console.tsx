import { useEffect, useState } from "react";
import type { ApiClient } from "../../app/api";

export type BuilderRun = {
  id: string;
  status: string;
  attempts: Array<{
    id: string;
    nodeId: string;
    attempt: number;
    status: string;
    output?: Record<string, unknown>;
    error?: string;
  }>;
  events: Array<{ sequence: number; type: string }>;
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
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.request<BuilderRun>(`/runs/${runId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRun(next);
        setError(undefined);
        onStatuses(
          Object.fromEntries(next.attempts.map((attempt) => [attempt.nodeId, attempt.status])),
        );
        if (!["succeeded", "failed", "cancelled"].includes(next.status))
          timer = setTimeout(() => void refresh(), 500);
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, runId, onStatuses]);
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
        <a href="/runs">Open debugger</a>
        {run && !["succeeded", "failed", "cancelled"].includes(run.status) ? (
          <button type="button" onClick={() => void cancel()}>
            Cancel run
          </button>
        ) : null}
      </header>
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
