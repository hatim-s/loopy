import type { LogRecord } from "loopy";
import { timestamp } from "../lib/format.ts";
import { JsonPreview } from "./json-preview.tsx";

export function LogLines({ logs }: { logs: LogRecord[] }) {
  if (logs.length === 0) {
    return null;
  }

  return (
    <ul className="log-lines" aria-label="Logs">
      {logs.map((log) => (
        <li key={log.seq} className={`log-${log.level}`}>
          <div className="log-meta">
            <time dateTime={log.at}>{timestamp(log.at)}</time>
            <span>{log.level}</span>
            <span>
              {log.position.kind === "step"
                ? `attempt ${log.position.attempt}`
                : `after step ${log.position.afterStep}`}
            </span>
          </div>
          <div className="log-message">{log.message}</div>
          {log.data !== undefined && <JsonPreview label="Data" value={log.data} />}
        </li>
      ))}
    </ul>
  );
}
