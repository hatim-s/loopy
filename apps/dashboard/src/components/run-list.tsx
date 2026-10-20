import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isTerminalRun, type RunView } from "loopy/contract";
import type { ReactNode } from "react";
import { duration, timestamp } from "../lib/format.ts";
import type { RunFilters } from "../lib/keys.ts";
import { runPagesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";
import { Button } from "./button.tsx";
import { Countdown } from "./countdown.tsx";
import { ErrorBanner } from "./error-banner.tsx";
import { StatusBadge, StatusDot } from "./status-badge.tsx";
import { shortAge, TimeStamp } from "./time-stamp.tsx";

/** Live while the run holds a worker, total once it finished, blank while it waits. */
export function RunDuration({ run, now }: { run: RunView; now: number }) {
  if (run.status === "running") {
    return <span className="text-active">{duration(run.createdAt, now)}</span>;
  }

  return isTerminalRun(run.status) ? (
    <span>{duration(run.createdAt, Date.parse(run.updatedAt))}</span>
  ) : null;
}

/**
 * The one thing worth reading about a run beyond its status, if there is one. Notes with a
 * tooltip are `relative` so they paint above the row link's overlay and the tooltip can show.
 */
export function RunNote({ run, now }: { run: RunView; now: number }) {
  if (run.ownerStale) {
    return (
      <span
        className="relative text-danger"
        title="The owner missed its heartbeat lease. Resume the run to recover it."
      >
        Stale owner, resume to recover
      </span>
    );
  }

  if (run.waitingOn) {
    return (
      <span className="text-attention">
        Waiting on <span className="font-mono">{run.waitingOn.hook}</span>
      </span>
    );
  }

  if (run.status === "suspended" && run.wakeAt !== null) {
    return (
      <span className="relative text-attention">
        Wakes <Countdown at={run.wakeAt} now={now} />
      </span>
    );
  }

  if (run.status === "failed") {
    return (
      <span className="relative text-danger" title={run.error}>
        {run.error.split("\n", 1)[0]}
      </span>
    );
  }

  return null;
}

/*
 * Below lg there is no room for a loopy column beside a readable note, so the slug moves into the
 * run cell and the note takes a second line. Started hides below sm and Duration below lg.
 */
function RunRow({ run, now, withLoopy }: { run: RunView; now: number; withLoopy: boolean }) {
  return (
    <tr className="relative">
      <td>
        <StatusBadge status={run.status} />
      </td>
      {withLoopy && <td className="truncate font-medium max-lg:hidden">{run.slug}</td>}
      <td className="max-w-0">
        <span
          className={`flex min-w-0 items-baseline gap-x-3 ${withLoopy ? "max-lg:flex-col" : ""}`}
        >
          <span className="flex max-w-full min-w-0 shrink-0 items-baseline gap-2">
            {withLoopy && <span className="truncate font-medium lg:hidden">{run.slug}</span>}
            <Link
              to="/runs/$runId"
              params={{ runId: run.id }}
              title={run.id}
              className="row-link shrink-0 font-mono text-xs text-muted hover:text-ink"
            >
              {run.id.slice(-10)}
            </Link>
          </span>
          <span className="max-w-full min-w-0 truncate text-xs">
            <RunNote run={run} now={now} />
          </span>
        </span>
      </td>
      <td className="max-w-0 max-sm:hidden">
        <TimeStamp at={run.createdAt} now={now} />
      </td>
      <td className="text-right font-mono text-xs whitespace-nowrap text-muted tabular-nums max-lg:hidden">
        <RunDuration run={run} now={now} />
      </td>
    </tr>
  );
}

/** The shared run table: one row per run, the row itself links to the run page. */
export function RunTable({
  runs,
  now,
  withLoopy,
}: {
  runs: RunView[];
  now: number;
  withLoopy: boolean;
}) {
  return (
    <div className="panel">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col" className="w-28">
              Status
            </th>
            {withLoopy && (
              <th scope="col" className="w-36 max-lg:hidden xl:w-[22%]">
                Loopy
              </th>
            )}
            <th scope="col">Run</th>
            <th scope="col" className="w-36 max-sm:hidden xl:w-56">
              Started
            </th>
            <th scope="col" className="w-20 text-right max-lg:hidden">
              Duration
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <RunRow key={run.id} run={run} now={now} withLoopy={withLoopy} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type RunListProps = {
  filters: RunFilters;
  now: number;
  empty: string;
};

/** Newest runs first, one page at a time; older pages append below. */
function PagedRuns(
  props: RunListProps & { children: (runs: RunView[]) => ReactNode; emptyClass: string },
) {
  const { filters, empty, children, emptyClass } = props;
  const pages = useInfiniteQuery(runPagesQuery(useBackend(), filters));
  const runs = pages.data?.pages.flat() ?? [];

  if (pages.error) {
    return <ErrorBanner error={pages.error} />;
  }

  if (pages.isPending) {
    return <p className="py-2 text-muted">Loading runs.</p>;
  }

  if (runs.length === 0) {
    return <p className={emptyClass}>{empty}</p>;
  }

  return (
    <div className="space-y-2">
      {children(runs)}
      <div className="flex items-center justify-between gap-3 text-xs text-faint">
        <span className="tabular-nums">
          {runs.length} {runs.length === 1 ? "run" : "runs"} loaded, newest first
        </span>
        {pages.hasNextPage && (
          <Button disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
            {pages.isFetchingNextPage ? "Loading" : "Load older"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function RunList(props: RunListProps & { withLoopy: boolean }) {
  const { withLoopy, ...rest } = props;

  return (
    <PagedRuns {...rest} emptyClass="panel px-3 py-4 text-muted">
      {(runs) => <RunTable runs={runs} now={props.now} withLoopy={withLoopy} />}
    </PagedRuns>
  );
}

/** One loopy's runs as a narrow list for a side panel: status, id, the note and the age. */
export function RunStack(props: RunListProps) {
  const { now } = props;

  return (
    <PagedRuns {...props} emptyClass="py-2 text-xs text-muted">
      {(runs) => (
        <ol className="-mx-1.5">
          {runs.map((run) => (
            <li key={run.id} className="relative">
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2.5 rounded-md px-1.5 py-1.5 hover:bg-raised">
                <StatusDot status={run.status} />
                <Link
                  to="/runs/$runId"
                  params={{ runId: run.id }}
                  title={run.id}
                  className="row-link truncate font-mono text-xs"
                >
                  {run.id.slice(-10)}
                  <span className="sr-only">, {run.status}</span>
                </Link>
                <time
                  dateTime={run.createdAt}
                  title={timestamp(run.createdAt)}
                  className="text-xs text-faint tabular-nums"
                >
                  {shortAge(run.createdAt, now)}
                </time>
                <span className="col-start-2 col-end-4 flex min-w-0 justify-between gap-3 text-xs text-muted">
                  <span className="min-w-0 truncate">
                    <RunNote run={run} now={now} />
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">
                    <RunDuration run={run} now={now} />
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </PagedRuns>
  );
}
