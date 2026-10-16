import type { EngineRunDetail } from "loopy";

export function RunDetail({ detail }: { detail: EngineRunDetail }) {
  const { run, steps, logs } = detail;

  return (
    <section className="trace" aria-label="Run detail">
      <h2>{run.id}</h2>
      <p>
        {run.status} · {run.workspace}
      </p>
      {run.error && <p role="alert">{run.error}</p>}
      <h3>Steps</h3>
      <ol>
        {steps.map((step) => (
          <li key={step.seq}>
            <strong>{step.key}</strong> · {step.kind} · {step.status} · attempt {step.attempt}
            {step.status === "succeeded" && <pre>{JSON.stringify(step.output, null, 2)}</pre>}
            {"error" in step && <p>{step.error}</p>}
            {"wakeAt" in step && <p>Wakes at {step.wakeAt}</p>}
          </li>
        ))}
      </ol>
      <h3>Logs</h3>
      <ol>
        {logs.map((log) => (
          <li key={log.seq}>
            <time>{log.at}</time> [{log.level}] {log.message}
            {log.data !== undefined && <pre>{JSON.stringify(log.data, null, 2)}</pre>}
          </li>
        ))}
      </ol>
    </section>
  );
}
