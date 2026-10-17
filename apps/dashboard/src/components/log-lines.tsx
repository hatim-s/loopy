import type { LogRecord } from "loopy/contract";
import { clockTime } from "../lib/format.ts";
import { JsonPreview } from "./json-preview.tsx";

const LEVEL_TONE = {
  info: "text-muted",
  warn: "text-attention",
  error: "text-danger",
} satisfies Record<LogRecord["level"], string>;

export function LogLines({ logs }: { logs: LogRecord[] }) {
  if (logs.length === 0) {
    return null;
  }

  return (
    <ol aria-label="Logs" className="font-mono text-xs">
      {logs.map((log) => (
        <li key={log.seq} className="grid grid-cols-[auto_3rem_minmax(0,1fr)] gap-x-3 py-0.5">
          <time dateTime={log.at} className="text-muted tabular-nums">
            {clockTime(log.at)}
          </time>
          <span className={LEVEL_TONE[log.level]}>{log.level}</span>
          <div className="min-w-0">
            <p className="whitespace-pre-wrap break-words">{log.message}</p>
            {log.data !== undefined && <JsonPreview label="data" value={log.data} />}
          </div>
        </li>
      ))}
    </ol>
  );
}
