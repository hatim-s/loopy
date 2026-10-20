import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { runStatusSchema } from "loopy/contract";
import { timestamp } from "../../lib/format.ts";
import { runPagesQuery } from "../../lib/queries.ts";
import { useBackend } from "../../router-context.ts";
import { statusTone } from "../status-badge.tsx";

const ALL_RUNS = {} as const;

/**
 * The newest page of runs as one mark per run, oldest on the left. It shares its cache entry
 * with the unfiltered run table, so it costs no extra request and updates from the stream.
 * The marks are a pointer shortcut; keyboard users reach the same runs through the table.
 */
export function OutcomeRibbon() {
  const pages = useInfiniteQuery(runPagesQuery(useBackend(), ALL_RUNS));
  const newest = pages.data?.pages[0] ?? [];

  if (newest.length === 0) {
    return null;
  }

  const runs = [...newest].reverse();

  const tally = runStatusSchema.options
    .map((status) => ({ status, count: runs.filter((run) => run.status === status).length }))
    .filter(({ count }) => count > 0);

  return (
    <section
      aria-labelledby="ribbon-heading"
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <h2 id="ribbon-heading" className="text-xs text-muted">
        Last {runs.length} runs
      </h2>
      <div aria-hidden="true" className="flex h-5 items-stretch gap-[3px]">
        {runs.map((run) => (
          <Link
            key={run.id}
            to="/runs/$runId"
            params={{ runId: run.id }}
            tabIndex={-1}
            title={`${run.slug}, ${run.status}, ${timestamp(run.createdAt)}`}
            className={`w-1.5 rounded-[2px] bg-current opacity-80 hover:opacity-100 ${statusTone(run.status)}`}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-3 text-xs tabular-nums">
        {tally.map(({ status, count }) => (
          <li key={status} className={statusTone(status)}>
            <span className="font-mono">{count}</span> {status}
          </li>
        ))}
      </ul>
    </section>
  );
}
