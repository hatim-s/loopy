import { type LoopyView, runStatusSchema } from "loopy/contract";
import { statusTone } from "./status-badge.tsx";

/**
 * Every status with runs, in lifecycle order: a proportion bar over the exact counts. The
 * bar shows the mix at a glance; the numbers carry the values, so colour is never the only cue.
 * The list is `relative` so each count's status tooltip shows above a row link's overlay.
 */
export function StatusCounts({ counts }: { counts: LoopyView["counts"] }) {
  const present = runStatusSchema.options.filter((status) => counts[status] > 0);
  const total = present.reduce((sum, status) => sum + counts[status], 0);

  if (total === 0) {
    return <span className="text-xs text-faint">No runs</span>;
  }

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-raised"
      >
        {present.map((status) => (
          <span
            key={status}
            className={`h-full bg-current ${statusTone(status)}`}
            style={{ width: `${(counts[status] / total) * 100}%` }}
          />
        ))}
      </span>
      <ul className="relative flex min-w-0 flex-wrap gap-x-2 font-mono text-xs tabular-nums">
        {present.map((status) => (
          <li key={status} title={`${counts[status]} ${status}`} className={statusTone(status)}>
            {counts[status]}
            <span className="sr-only"> {status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
