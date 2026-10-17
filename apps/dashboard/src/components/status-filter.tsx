import { Link } from "@tanstack/react-router";
import { type LoopyView, type RunStatus, runStatusSchema } from "loopy/contract";

const OPTION =
  "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-ink";

const SELECTED = "bg-raised text-ink";

/** Links rather than buttons, so the filter lives in the URL and survives a reload. */
export function StatusFilter({
  slug,
  selected,
  counts,
}: {
  slug: string;
  selected: RunStatus | undefined;
  counts: LoopyView["counts"];
}) {
  return (
    <nav aria-label="Filter runs by status" className="flex flex-wrap gap-1">
      <Link
        to="/loopies/$slug"
        params={{ slug }}
        search={{}}
        className={`${OPTION} ${selected === undefined ? SELECTED : ""}`}
        aria-current={selected === undefined ? "page" : undefined}
      >
        All
      </Link>
      {runStatusSchema.options.map((status) => (
        <Link
          key={status}
          to="/loopies/$slug"
          params={{ slug }}
          search={{ status }}
          className={`${OPTION} ${selected === status ? SELECTED : ""}`}
          aria-current={selected === status ? "page" : undefined}
        >
          {status}
          <span className="tabular-nums opacity-70">{counts[status]}</span>
        </Link>
      ))}
    </nav>
  );
}
