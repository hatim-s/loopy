import { Link } from "@tanstack/react-router";
import { type LoopyView, type RunStatus, runStatusSchema } from "loopy/contract";
import type { ReactNode } from "react";
import { StatusDot } from "./status-badge.tsx";

type FilterTarget = { slug: string | undefined; status: RunStatus | undefined };

/** The loopy page filters its own runs; without a slug the filter drives the overview. */
function FilterLink({
  target,
  current,
  children,
}: {
  target: FilterTarget;
  current: boolean;
  children: ReactNode;
}) {
  const search = target.status ? { status: target.status } : {};
  const shared = { className: "chip", "aria-current": current ? ("page" as const) : undefined };

  return target.slug === undefined ? (
    <Link
      from="/"
      to="/"
      search={(previous) => ({ ...previous, status: target.status })}
      resetScroll={false}
      {...shared}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/loopies/$slug"
      params={{ slug: target.slug }}
      search={search}
      resetScroll={false}
      {...shared}
    >
      {children}
    </Link>
  );
}

function Count({ value }: { value: number | undefined }) {
  return value === undefined ? null : (
    <span className="font-mono text-faint tabular-nums">{value}</span>
  );
}

/**
 * Links rather than buttons, so the filter lives in the URL and survives a reload. Counts stay
 * hidden until they are known, so a loading list never reads as zero runs; once known, statuses
 * with no runs drop out.
 */
export function StatusFilter({
  slug,
  selected,
  counts,
}: {
  slug?: string;
  selected: RunStatus | undefined;
  counts: LoopyView["counts"] | undefined;
}) {
  const total = counts && runStatusSchema.options.reduce((sum, status) => sum + counts[status], 0);

  return (
    <nav aria-label="Filter runs by status" className="flex flex-wrap gap-0.5">
      <FilterLink target={{ slug, status: undefined }} current={selected === undefined}>
        All
        <Count value={total} />
      </FilterLink>
      {runStatusSchema.options.map((status) =>
        // A status with no runs links to an empty list, so it stays out once counts are known.
        counts?.[status] === 0 && selected !== status ? null : (
          <FilterLink key={status} target={{ slug, status }} current={selected === status}>
            <StatusDot status={status} />
            {status}
            <Count value={counts?.[status]} />
          </FilterLink>
        ),
      )}
    </nav>
  );
}
