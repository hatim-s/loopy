import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LoopyView } from "loopy/contract";
import { LOOPY_SORTS, type LoopySort, sortLoopies } from "../lib/overview.ts";
import { loopiesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";
import { Countdown } from "./countdown.tsx";
import { ErrorBanner } from "./error-banner.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { StatusCounts } from "./status-counts.tsx";
import { TimeStamp } from "./time-stamp.tsx";

const SORT_LABEL = {
  attention: "Needs attention",
  name: "Name",
  recent: "Last run",
  next: "Next fire",
} satisfies Record<LoopySort, string>;

/** Sorting lives in the URL next to the run filter, so a reload keeps the view. */
export function LoopySortControl({ sort }: { sort: LoopySort }) {
  return (
    <nav aria-label="Sort loopies" className="flex flex-wrap items-center gap-0.5">
      <span className="mr-1 text-xs text-faint">Sort</span>
      {LOOPY_SORTS.map((option) => (
        <Link
          key={option}
          from="/"
          to="/"
          search={(previous) => ({
            ...previous,
            sort: option === "attention" ? undefined : option,
          })}
          resetScroll={false}
          aria-current={option === sort ? "page" : undefined}
          className="chip"
        >
          {SORT_LABEL[option]}
        </Link>
      ))}
    </nav>
  );
}

function Schedule({ schedule, now }: { schedule: LoopyView["schedule"]; now: number }) {
  if (schedule === null) {
    return <span className="text-faint">Not scheduled</span>;
  }

  return (
    <span
      className="relative flex min-w-0 items-baseline gap-2"
      title={`${schedule.cron} (${schedule.tz})`}
    >
      {schedule.enabled && schedule.nextFireAt !== null ? (
        <Countdown at={schedule.nextFireAt} now={now} />
      ) : (
        <span className="text-attention">Paused</span>
      )}
      <code className="truncate font-mono text-faint">{schedule.cron}</code>
    </span>
  );
}

function LoopyRow({ loopy, now }: { loopy: LoopyView; now: number }) {
  const { lastRun } = loopy;

  return (
    <tr className="relative">
      <td className="max-w-0">
        <span className="flex min-w-0 items-baseline gap-2.5">
          <Link
            to="/loopies/$slug"
            params={{ slug: loopy.slug }}
            className="row-link max-w-full shrink-0 truncate font-medium"
          >
            {loopy.slug}
          </Link>
          {loopy.description && (
            <span className="relative truncate text-xs text-muted" title={loopy.description}>
              {loopy.description}
            </span>
          )}
        </span>
      </td>
      <td>
        {lastRun ? (
          <StatusBadge status={lastRun.status} />
        ) : (
          <span className="text-xs text-faint">No retained runs</span>
        )}
      </td>
      <td className="max-w-0 max-sm:hidden">
        {lastRun && <TimeStamp at={lastRun.createdAt} now={now} />}
      </td>
      <td className="max-lg:hidden">
        <StatusCounts counts={loopy.counts} />
      </td>
      <td className="max-w-0 text-xs max-xl:hidden">
        <Schedule schedule={loopy.schedule} now={now} />
      </td>
    </tr>
  );
}

/*
 * The table is fixed layout, so the loopy column gets what the others leave. Columns drop out by
 * breakpoint (Started below sm, Run history below lg, Schedule below xl) to keep it at 220px or
 * more from a 375px phone up, with the rail taking 248px from md.
 */
export function LoopyTable({ now, sort }: { now: number; sort: LoopySort }) {
  const loopies = useQuery(loopiesQuery(useBackend()));

  if (loopies.error) {
    return <ErrorBanner error={loopies.error} />;
  }

  if (loopies.isPending) {
    return <p className="py-2 text-muted">Loading loopies.</p>;
  }

  if (loopies.data.length === 0) {
    return (
      <p className="panel px-3 py-4 text-muted">
        No saved loopies. Save one with{" "}
        <code className="font-mono text-ink">loopy save &lt;file.ts&gt;</code>.
      </p>
    );
  }

  const ariaSort = (key: LoopySort) => (sort === key ? "ascending" : undefined);

  return (
    <div className="panel">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort("name")}>
              Loopy
            </th>
            <th scope="col" className="w-28">
              Last run
            </th>
            <th
              scope="col"
              className="w-36 max-sm:hidden xl:w-56"
              aria-sort={sort === "recent" ? "descending" : undefined}
            >
              Started
            </th>
            <th scope="col" className="w-48 max-lg:hidden">
              Run history
            </th>
            <th scope="col" className="w-52 max-xl:hidden" aria-sort={ariaSort("next")}>
              Schedule
            </th>
          </tr>
        </thead>
        <tbody>
          {sortLoopies(loopies.data, sort).map((loopy) => (
            <LoopyRow key={loopy.slug} loopy={loopy} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
