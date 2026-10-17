import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isTerminalRun, type RunView } from "loopy/contract";
import { ago, duration, timestamp } from "../lib/format.ts";
import type { RunFilters } from "../lib/keys.ts";
import { runPagesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";
import { Button } from "./button.tsx";
import { ErrorBanner } from "./error-banner.tsx";
import { StatusBadge } from "./status-badge.tsx";

/** Live while the run holds a worker, total once it finished, blank while it waits. */
function RunDuration({ run, now }: { run: RunView; now: number }) {
  if (run.status === "running") {
    return <span className="text-active">{duration(run.createdAt, now)}</span>;
  }

  return isTerminalRun(run.status) ? (
    <span>{duration(run.createdAt, Date.parse(run.updatedAt))}</span>
  ) : null;
}

function RunRow({ run, now, withLoopy }: { run: RunView; now: number; withLoopy: boolean }) {
  return (
    <tr className="relative hover:bg-raised">
      <td className="py-1.5 pr-4 pl-2">
        <StatusBadge status={run.status} />
      </td>
      <td className="max-w-0 truncate py-1.5 pr-4">
        <Link
          to="/runs/$runId"
          params={{ runId: run.id }}
          className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-active"
        >
          {withLoopy && <span className="mr-2 font-medium">{run.slug}</span>}
          <span className="block truncate font-mono text-xs text-muted" title={run.id}>
            {run.id.slice(-12)}
          </span>
        </Link>
        {run.waitingOn && (
          <span className="ml-2 rounded-sm bg-attention/12 px-1.5 py-px text-xs text-attention">
            waiting on {run.waitingOn.hook}
          </span>
        )}
        {run.ownerStale && (
          <span
            className="ml-2 text-xs text-danger"
            title="The owner missed its heartbeat lease. Resume the run to recover it."
          >
            stale owner
          </span>
        )}
      </td>
      <td className="py-1.5 pr-4 text-right text-xs whitespace-nowrap text-muted tabular-nums">
        <time dateTime={run.createdAt} title={timestamp(run.createdAt)}>
          {ago(run.createdAt, now)}
        </time>
      </td>
      <td className="hidden py-1.5 pr-2 text-right font-mono text-xs whitespace-nowrap text-muted tabular-nums sm:table-cell">
        <RunDuration run={run} now={now} />
      </td>
    </tr>
  );
}

type RunListProps = {
  filters: RunFilters;
  now: number;
  withLoopy: boolean;
  empty: string;
};

/** Newest runs first, one page at a time; older pages append below. */
export function RunList({ filters, now, withLoopy, empty }: RunListProps) {
  const pages = useInfiniteQuery(runPagesQuery(useBackend(), filters));
  const runs = pages.data?.pages.flat() ?? [];

  if (pages.error) {
    return <ErrorBanner error={pages.error} />;
  }

  if (pages.isPending) {
    return <p className="py-2 text-muted">Loading runs.</p>;
  }

  if (runs.length === 0) {
    return <p className="py-2 text-muted">{empty}</p>;
  }

  return (
    <div className="space-y-3">
      <table className="w-full table-fixed border-y border-line text-left">
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th scope="col" className="w-28 py-1.5 pl-2 font-normal">
              Status
            </th>
            <th scope="col" className="py-1.5 font-normal">
              Run
            </th>
            <th scope="col" className="w-24 py-1.5 pr-4 text-right font-normal">
              Created
            </th>
            <th
              scope="col"
              className="hidden w-20 py-1.5 pr-2 text-right font-normal sm:table-cell"
            >
              Duration
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} now={now} withLoopy={withLoopy} />
          ))}
        </tbody>
      </table>
      {pages.hasNextPage && (
        <Button disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
          {pages.isFetchingNextPage ? "Loading" : "Load older"}
        </Button>
      )}
    </div>
  );
}
