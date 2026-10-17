import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LoopyView } from "loopy/contract";
import { ago, timestamp } from "../lib/format.ts";
import { loopiesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";
import { Countdown } from "./countdown.tsx";
import { ErrorBanner } from "./error-banner.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { StatusCounts } from "./status-counts.tsx";

function LoopyRow({ loopy, now }: { loopy: LoopyView; now: number }) {
  const { lastRun, schedule } = loopy;

  return (
    <tr className="relative align-baseline hover:bg-raised">
      <td className="max-w-0 py-2 pr-4 pl-2">
        <Link
          to="/loopies/$slug"
          params={{ slug: loopy.slug }}
          className="font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-active"
        >
          {loopy.slug}
        </Link>
        {loopy.description && <p className="truncate text-xs text-muted">{loopy.description}</p>}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap">
        {lastRun ? (
          <span className="flex items-baseline gap-2">
            <StatusBadge status={lastRun.status} />
            <time
              dateTime={lastRun.createdAt}
              title={timestamp(lastRun.createdAt)}
              className="text-xs text-muted tabular-nums"
            >
              {ago(lastRun.createdAt, now)}
            </time>
          </span>
        ) : (
          <span className="text-xs text-muted">Never run</span>
        )}
      </td>
      <td className="hidden py-2 pr-4 md:table-cell">
        <StatusCounts counts={loopy.counts} />
      </td>
      <td className="hidden py-2 pr-2 text-right text-xs whitespace-nowrap text-muted sm:table-cell">
        {schedule?.enabled ? (
          <span title={`${schedule.cron} (${schedule.tz})`}>
            <Countdown at={schedule.nextFireAt} now={now} />
          </span>
        ) : (
          <span>{schedule ? "Paused" : "Not scheduled"}</span>
        )}
      </td>
    </tr>
  );
}

export function LoopyTable({ now }: { now: number }) {
  const loopies = useQuery(loopiesQuery(useBackend()));

  if (loopies.error) {
    return <ErrorBanner error={loopies.error} />;
  }

  if (loopies.data?.length === 0) {
    return (
      <p className="py-2 text-muted">
        No saved loopies. Save one with{" "}
        <code className="font-mono">loopy save &lt;file.ts&gt;</code>.
      </p>
    );
  }

  return (
    <table className="w-full table-fixed border-y border-line text-left">
      <thead className="text-xs text-muted">
        <tr className="border-b border-line">
          <th scope="col" className="py-1.5 pl-2 font-normal">
            Loopy
          </th>
          <th scope="col" className="w-44 py-1.5 font-normal">
            Last run
          </th>
          <th scope="col" className="hidden w-48 py-1.5 font-normal md:table-cell">
            Runs
          </th>
          <th scope="col" className="hidden w-32 py-1.5 pr-2 text-right font-normal sm:table-cell">
            Next fire
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {loopies.data?.map((loopy) => (
          <LoopyRow key={loopy.slug} loopy={loopy} now={now} />
        ))}
      </tbody>
    </table>
  );
}
