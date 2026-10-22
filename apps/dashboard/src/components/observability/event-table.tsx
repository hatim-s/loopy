import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { shortId } from "../../lib/format.ts";
import { useEvent } from "../../lib/ui-data.ts";
import type { EventRow } from "../../lib/view-models.ts";
import { JsonBlock } from "../json-preview.tsx";
import { Icon } from "../ui/icon.tsx";
import { Load } from "../ui/load.tsx";
import { preciseTime } from "./log-table.tsx";

const KIND_TONE = new Map([
  ["succeeded", "bg-success"],
  ["resolved", "bg-success"],
  ["failed", "bg-danger"],
  ["expired", "bg-danger"],
  ["retrying", "bg-attention"],
  ["waiting", "bg-attention"],
  ["sleeping", "bg-attention"],
  ["suspended", "bg-attention"],
  ["running", "bg-active"],
  ["created", "bg-active"],
]);

/** The entity in mono beside the kind with a dot in its tone: `node · running`. */
export function EventType({ entity, kind }: { entity: string; kind: string }) {
  return (
    <span className="inline-flex h-[22px] items-center overflow-hidden rounded-control font-mono text-xs whitespace-nowrap shadow-[inset_0_0_0_1px_var(--line)]">
      <span className="flex h-full items-center bg-sunken px-1.5 text-muted">{entity}</span>
      <span className="flex h-full items-center gap-1.5 pr-2 pl-1.5">
        <i className={`size-1.5 rounded-full ${KIND_TONE.get(kind) ?? "bg-neutral"}`} />
        {kind}
      </span>
    </span>
  );
}

export function EventTable(props: {
  rows: EventRow[];
  busy: boolean;
  open: number | null;
  onOpen: (sequence: number | null) => void;
}) {
  const { rows, busy, open, onOpen } = props;

  return (
    <div className="table-scroll">
      <table className={`data dense ${busy ? "busy" : ""}`}>
        <thead>
          <tr>
            <th scope="col" className="num w-24">
              Sequence
            </th>
            <th scope="col" className="w-32">
              Time
            </th>
            <th scope="col" className="w-44">
              Type
            </th>
            <th scope="col">Run</th>
            <th scope="col">Node</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((event) => (
            <tr key={event.sequence} aria-selected={open === event.sequence}>
              <td className="num font-mono text-xs">
                <button
                  type="button"
                  className="row-link cursor-pointer"
                  aria-label={`Open event ${event.sequence}`}
                  onClick={() => onOpen(open === event.sequence ? null : event.sequence)}
                >
                  {event.sequence.toLocaleString()}
                </button>
              </td>
              <td className="font-mono text-xs text-muted tabular-nums">{preciseTime(event.at)}</td>
              <td>
                <EventType entity={event.entity} kind={event.kind} />
              </td>
              <td className="max-w-48 truncate text-xs">
                {event.runId === null ? (
                  <span className="text-faint">None</span>
                ) : (
                  <>
                    {event.slug}{" "}
                    <span className="font-mono text-muted">{shortId(event.runId)}</span>
                  </>
                )}
              </td>
              <td className="max-w-40 truncate font-mono text-xs">
                {event.nodeId?.replace(/^\d+:/, "") ?? <span className="text-faint">None</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The event drawer. The record loads when it opens; links trace the event elsewhere. */
export function EventDrawer(props: {
  row: EventRow;
  onClose: () => void;
  onSameTxn: (txn: string) => void;
  onRunEvents: (runId: string) => void;
}) {
  const { row, onClose, onSameTxn, onRunEvents } = props;
  const event = useEvent(row.sequence);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
  }, [row.sequence]);

  return (
    <aside aria-label={`Event ${row.sequence}`} className="panel flex min-h-0 flex-col">
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <EventType entity={row.entity} kind={row.kind} />
          <p className="mt-1.5 text-xs text-muted tabular-nums">
            Sequence {row.sequence.toLocaleString()}, {new Date(row.at).toLocaleString()}
          </p>
        </div>
        <button
          ref={close}
          type="button"
          className="icon-btn"
          aria-label="Close event"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b border-line px-4 py-3 text-xs">
        <dt className="text-muted">Loopy</dt>
        <dd>{row.slug ?? "None"}</dd>
        <dt className="text-muted">Run</dt>
        <dd className="font-mono">{row.runId ?? "None"}</dd>
        <dt className="text-muted">Node</dt>
        <dd className="font-mono">{row.nodeId ?? "None"}</dd>
        <dt className="text-muted">Transaction</dt>
        <dd className="truncate font-mono">{row.txn}</dd>
      </dl>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3">
        {row.runId !== null && (
          <>
            <Link
              to="/runs/$runId"
              params={{ runId: row.runId }}
              search={row.nodeId === null ? {} : { node: row.nodeId }}
              className="btn btn-sm"
            >
              Show in run
            </Link>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => row.runId !== null && onRunEvents(row.runId)}
            >
              Events for this run
            </button>
          </>
        )}
        <button type="button" className="btn btn-sm" onClick={() => onSameTxn(row.txn)}>
          Same transaction
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <h3 className="text-xs font-semibold text-muted">Record</h3>
        <Load
          value={event}
          pending={<p className="mt-2 text-xs text-muted">Loading the record.</p>}
        >
          {(data) => <JsonBlock value={data.record} />}
        </Load>
      </div>
    </aside>
  );
}
