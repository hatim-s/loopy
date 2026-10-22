import { executionKeyString, type NodeRunView } from "loopy/contract";
import { type ReactNode, useId, useState } from "react";
import { clockTime, elapsed, timestamp } from "../../lib/format.ts";
import { useExecution, useLogPages } from "../../lib/ui-data.ts";
import type { ExecutionRow, LogRow } from "../../lib/view-models.ts";
import { Countdown } from "../countdown.tsx";
import { JsonBlock } from "../json-preview.tsx";
import { LogDetail } from "../observability/log-table.tsx";
import { bytes } from "../runs/run-table.tsx";
import { Load } from "../ui/load.tsx";
import { PagerFoot, ScanNote } from "../ui/pager.tsx";
import { LevelPill, StatusPill } from "../ui/status.tsx";

const TABS = ["output", "input", "attempts", "logs"] as const;

type Tab = (typeof TABS)[number];

const TAB_LABEL = {
  output: "Output",
  input: "Input",
  attempts: "Attempts",
  logs: "Logs",
} satisfies Record<Tab, string>;

function Pending({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted">{children}</p>;
}

/** The output, from the list row when it fits inline, else from the execution detail. */
function OutputTab({ runId, row }: { runId: string; row: ExecutionRow }) {
  const { execution, truncatedOutputBytes } = row;

  const detail = useExecution(
    runId,
    truncatedOutputBytes === null ? null : executionKeyString(execution.key),
  );

  if (execution.status !== "succeeded") {
    return <Pending>Only a succeeded execution has an output.</Pending>;
  }

  if (truncatedOutputBytes === null) {
    return <JsonBlock value={execution.output} />;
  }

  return (
    <Load
      value={detail}
      pending={<Pending>Loading the full output, {bytes(truncatedOutputBytes)}.</Pending>}
    >
      {(data) =>
        data.execution.status === "succeeded" ? <JsonBlock value={data.execution.output} /> : null
      }
    </Load>
  );
}

function InputTab({ runId, execution }: { runId: string; execution: NodeRunView }) {
  const detail = useExecution(runId, executionKeyString(execution.key));

  return (
    <Load value={detail} pending={<Pending>Loading the input.</Pending>}>
      {(data) => {
        switch (data.input.state) {
          case "recorded": {
            return <JsonBlock value={data.input.value} />;
          }

          case "truncated": {
            return (
              <Pending>
                The input was {bytes(data.input.bytes)}, over the inline limit, so the daemon kept
                only its size.
              </Pending>
            );
          }

          default: {
            return (
              <Pending>The daemon did not record the resolved input for this execution.</Pending>
            );
          }
        }
      }}
    </Load>
  );
}

function AttemptsTab({ runId, execution }: { runId: string; execution: NodeRunView }) {
  const detail = useExecution(runId, executionKeyString(execution.key));

  return (
    <Load value={detail} pending={<Pending>Loading attempts.</Pending>}>
      {(data) => (
        <>
          <ol className="grid gap-1.5">
            {[...data.attempts]
              .sort((a, b) => a.attempt - b.attempt)
              .map((attempt) => (
                <li
                  key={attempt.attempt}
                  className="rounded-control border border-line px-2.5 py-2 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium">Attempt {attempt.attempt}</span>
                    <StatusPill status={attempt.status} small />
                    <span
                      className="ml-auto text-muted tabular-nums"
                      title={timestamp(attempt.startedAt)}
                    >
                      {clockTime(attempt.startedAt)}
                      {attempt.endedAt &&
                        `, ${elapsed(Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt))}`}
                    </span>
                  </span>
                  {attempt.error && (
                    <p className="mt-1 font-mono whitespace-pre-wrap text-danger">
                      {attempt.error.code}: {attempt.error.message}
                    </p>
                  )}
                </li>
              ))}
          </ol>
          {data.attemptsIncomplete && (
            <Pending>
              Earlier attempts were not stored, so this list may start after attempt 1.
            </Pending>
          )}
        </>
      )}
    </Load>
  );
}

/** One log line. It opens to the stored record, because pages carry a bounded message. */
function LogLine({ log, attempt }: { log: LogRow; attempt: number }) {
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid w-full cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-2 rounded-control text-left hover:bg-raised"
      >
        <time dateTime={log.at} className="text-muted tabular-nums">
          {clockTime(log.at)}
        </time>
        <LevelPill level={log.level} />
        <span className="line-clamp-3 break-words whitespace-pre-wrap">
          {log.attempt !== null && log.attempt !== attempt && (
            <span className="text-faint">try {log.attempt} </span>
          )}
          {log.message}
        </span>
      </button>
      {open && (
        <div className="mt-1 mb-2 rounded-control bg-sunken px-2.5 py-2">
          <LogDetail id={log.id} preview={log.message} />
        </div>
      )}
    </li>
  );
}

/**
 * The execution's lines, 50 a page, oldest first within the page. A selective filter scans a
 * bounded window, so an empty page with older pages is a search still in progress, not silence.
 */
function LogsTab({ runId, execution }: { runId: string; execution: NodeRunView }) {
  const pager = useLogPages({
    runId,
    executionKey: executionKeyString(execution.key),
    tail: execution.status === "running",
  });

  return (
    <Load value={pager} pending={<Pending>Loading logs.</Pending>}>
      {(page) => {
        if (page.rows.length === 0 && !page.hasNext && !page.hasPrevious) {
          return <Pending>This execution wrote no logs.</Pending>;
        }

        return (
          <>
            {page.rows.length === 0 ? (
              <Pending>
                {page.hasNext
                  ? "No line on this page. Older pages continue the search."
                  : "No older lines."}
              </Pending>
            ) : (
              <ol className="grid gap-1 font-mono text-xs">
                {[...page.rows].reverse().map((log) => (
                  <LogLine key={log.id} log={log} attempt={execution.attempt} />
                ))}
              </ol>
            )}
            <div className="-mx-3 mt-2 -mb-3">
              <PagerFoot pager={pager} page={page} noun="lines">
                <ScanNote scan={page} noun="lines" />
              </PagerFoot>
            </div>
          </>
        );
      }}
    </Load>
  );
}

/**
 * One execution of the selected node. The record's status, timing and error show at once.
 * Output, input, attempts and logs load only when their tab opens.
 */
export function ExecutionCard(props: {
  runId: string;
  row: ExecutionRow;
  now: number;
  openOutput: boolean;
}) {
  const { runId, row, now, openOutput } = props;
  const { execution } = row;

  // Only an inline output opens by itself; a large one, such as a map's item array, waits for a click.
  const [tab, setTab] = useState<Tab | null>(
    openOutput && execution.status === "succeeded" && row.truncatedOutputBytes === null
      ? "output"
      : null,
  );

  const id = useId();
  const end = "endedAt" in execution ? Date.parse(execution.endedAt) : now;

  return (
    <article className="rounded-panel border border-line">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 pt-2.5 pb-2 text-xs">
        <StatusPill status={execution.status} small />
        <span className="text-muted tabular-nums">
          attempt {execution.attempt} of {execution.maxAttempts}
        </span>
        <span className="ml-auto text-muted tabular-nums" title={timestamp(execution.startedAt)}>
          {clockTime(execution.startedAt)}, {elapsed(end - Date.parse(execution.startedAt))}
          {"endedAt" in execution ? "" : " so far"}
        </span>
      </header>
      {"error" in execution && (
        <pre
          role="alert"
          className="mx-3 mb-2 max-h-48 overflow-auto rounded-control bg-danger-soft px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-danger"
        >
          {execution.error.code}: {execution.error.message}
        </pre>
      )}
      {"nextRetryAt" in execution && (
        <p className="mx-3 mb-2 text-xs text-attention">
          Retries <Countdown at={execution.nextRetryAt} now={now} />
        </p>
      )}
      {"wakeAt" in execution && execution.wakeAt !== null && (
        <p className="mx-3 mb-2 text-xs text-attention">
          Wakes <Countdown at={execution.wakeAt} now={now} />
        </p>
      )}
      <div
        role="tablist"
        aria-label="Execution details"
        className="flex gap-0.5 border-t border-line px-2 pt-1.5"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-panel`}
            onClick={() => setTab(tab === name ? null : name)}
            className="h-7 cursor-pointer rounded-control px-2 text-xs text-muted hover:bg-raised hover:text-ink aria-selected:bg-raised aria-selected:text-ink"
          >
            {TAB_LABEL[name]}
            {name === "output" && row.truncatedOutputBytes !== null && (
              <span className="ml-1 text-faint">{bytes(row.truncatedOutputBytes)}</span>
            )}
          </button>
        ))}
      </div>
      {tab !== null && (
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-${tab}`}
          className="px-3 pt-2 pb-3"
        >
          {tab === "output" && <OutputTab runId={runId} row={row} />}
          {tab === "input" && <InputTab runId={runId} execution={execution} />}
          {tab === "attempts" && <AttemptsTab runId={runId} execution={execution} />}
          {tab === "logs" && <LogsTab runId={runId} execution={execution} />}
        </div>
      )}
      <p className="sr-only">Receipt {execution.receipt}</p>
    </article>
  );
}
