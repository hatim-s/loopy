import type { LoopySummary, RunRecord } from "loopy";
import { StatusBadge } from "./status-badge.tsx";

export function LoopyRail({
  loopies,
  runs,
  selected,
  onSelect,
}: {
  loopies: LoopySummary[];
  runs: RunRecord[];
  selected: string | undefined;
  onSelect: (slug: string) => void;
}) {
  return (
    <nav className="loopy-rail" aria-label="Saved loopies">
      <h1>Loopies</h1>
      {loopies.length === 0 && (
        <p className="empty-state">
          Save a loopy with <code>loopy save &lt;file.ts&gt;</code>.
        </p>
      )}
      {loopies.map((loopy) => {
        const last = runs
          .filter((run) => run.slug === loopy.slug)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

        return (
          <button
            type="button"
            key={loopy.slug}
            aria-pressed={selected === loopy.slug}
            onClick={() => onSelect(loopy.slug)}
          >
            <strong>{loopy.slug}</strong>
            <span className="scope">{loopy.scope}</span>
            {loopy.description && <span>{loopy.description}</span>}
            {loopy.schedule && (
              <code>
                {loopy.schedule.cron} · {loopy.schedule.tz ?? "UTC"}
              </code>
            )}
            {last ? <StatusBadge status={last.status} /> : <span>No runs yet</span>}
          </button>
        );
      })}
    </nav>
  );
}
