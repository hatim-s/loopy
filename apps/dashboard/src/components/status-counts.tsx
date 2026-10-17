import { type LoopyView, runStatusSchema } from "loopy/contract";
import { statusTone } from "./status-badge.tsx";

/** One compact count per status that has runs, in lifecycle order. */
export function StatusCounts({ counts }: { counts: LoopyView["counts"] }) {
  const present = runStatusSchema.options.filter((status) => counts[status] > 0);

  if (present.length === 0) {
    return <span className="text-xs text-muted">No runs</span>;
  }

  return (
    <ul className="flex flex-wrap gap-1">
      {present.map((status) => (
        <li
          key={status}
          title={`${counts[status]} ${status}`}
          className={`inline-flex items-center gap-1 rounded-sm bg-raised px-1.5 text-xs tabular-nums ${statusTone(status)}`}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          {counts[status]}
          <span className="sr-only"> {status}</span>
        </li>
      ))}
    </ul>
  );
}
