import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import { preciseTime, shortId } from "../../lib/format";
import { nodeIdParts } from "../../lib/node-id";
import { useLog } from "../../lib/ui-data";
import type { LogRow } from "../../lib/view-models";
import { JsonBlock } from "../json-preview";
import { Load } from "../ui/load";
import { LevelPill } from "../ui/status";

/**
 * The full line, fetched when it opens. Pages carry only the first 1,024 characters of each
 * message, so the drawer shows the stored record, its whole message and any data.
 */
export function LogDetail({ id, preview }: { id: number; preview: string }) {
  const log = useLog(id);

  return (
    <Load
      value={log}
      pending={
        <>
          <p className="font-mono text-xs break-words whitespace-pre-wrap">{preview}</p>
          <p className="text-xs text-muted">Loading the full line.</p>
        </>
      }
    >
      {(record) => (
        <div className="grid gap-2">
          <p className="max-h-96 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
            {record.message}
          </p>
          {record.data !== undefined && <JsonBlock value={record.data} />}
        </div>
      )}
    </Load>
  );
}

const COLUMNS = [
  { key: "time", label: "Time", className: "w-32" },
  { key: "level", label: "Level", className: "w-20" },
  { key: "run", label: "Run", className: "w-48" },
  { key: "node", label: "Node", className: "w-44" },
  { key: "message", label: "Message" },
  { key: "open", label: <span className="sr-only">Full line</span>, className: "w-16" },
] satisfies { key: string; label: ReactNode; className?: string }[];

export function LogTable({
  rows,
  busy,
  withRun,
}: {
  rows: LogRow[];
  busy: boolean;
  withRun: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const columns = COLUMNS.filter((column) => withRun || column.key !== "run");

  return (
    <div className="table-scroll">
      <table className={`data dense ${busy ? "busy" : ""}`}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((log) => (
            <Fragment key={log.id}>
              <tr aria-selected={open === log.id}>
                <td className="font-mono text-xs text-muted tabular-nums" title={log.at}>
                  {preciseTime(log.at)}
                </td>
                <td>
                  <LevelPill level={log.level} />
                </td>
                {withRun && (
                  <td className="max-w-48 truncate text-xs">
                    <Link
                      to="/runs/$runId"
                      params={{ runId: log.runId }}
                      className="text-ink hover:text-active"
                    >
                      {log.slug} <span className="font-mono text-muted">{shortId(log.runId)}</span>
                    </Link>
                  </td>
                )}
                <td className="max-w-44 truncate font-mono text-xs">
                  {log.nodeId === null ? (
                    <span className="text-faint">run</span>
                  ) : (
                    <Link
                      to="/runs/$runId"
                      params={{ runId: log.runId }}
                      search={{ node: log.nodeId }}
                      className="text-ink hover:text-active"
                    >
                      {nodeIdParts(log.nodeId).local}
                      {log.attempt > 1 && <span className="text-faint"> try {log.attempt}</span>}
                    </Link>
                  )}
                </td>
                <td className="max-w-0 truncate font-mono text-xs" title={log.message}>
                  {log.message}
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="link-btn text-xs"
                    aria-expanded={open === log.id}
                    onClick={() => setOpen(open === log.id ? null : log.id)}
                  >
                    {log.hasData ? "Data" : "Open"}
                  </button>
                </td>
              </tr>
              {open === log.id && (
                <tr className="hover:bg-transparent">
                  <td colSpan={columns.length} className="bg-sunken">
                    <LogDetail id={log.id} preview={log.message} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
