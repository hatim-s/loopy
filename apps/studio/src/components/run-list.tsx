import type { RunRecord } from "loopy";
import { useClock } from "../hooks/use-clock.ts";
import { duration, timestamp } from "../lib/format.ts";
import { StatusBadge } from "./status-badge.tsx";

export function RunList({
  runs,
  slug,
  selected,
  onSelect,
}: {
  runs: RunRecord[];
  slug: string | undefined;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  const now = useClock();

  return (
    <nav className="run-list" aria-label="Runs">
      <h2>{slug ?? "Runs"}</h2>
      <p className="muted">
        {slug ? `${runs.length} recorded runs` : "Select a loopy to see its runs."}
      </p>
      {slug && runs.length === 0 && (
        <p className="empty-state">
          No runs yet. Use <code>loopy run {slug}</code>.
        </p>
      )}
      {runs.map((run) => (
        <button
          type="button"
          key={run.id}
          aria-pressed={selected === run.id}
          onClick={() => onSelect(run.id)}
        >
          <StatusBadge status={run.status} />
          <code>{run.id}</code>
          <time dateTime={run.createdAt}>{timestamp(run.createdAt)}</time>
          <span>
            {duration(
              run.createdAt,
              run.status === "running" || run.status === "queued" || run.status === "suspended"
                ? now
                : Date.parse(run.updatedAt),
            )}
          </span>
        </button>
      ))}
    </nav>
  );
}
