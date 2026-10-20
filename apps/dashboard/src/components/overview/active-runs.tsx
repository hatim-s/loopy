import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LoopyView } from "loopy/contract";
import {
  ACTIVE_LIMIT,
  ACTIVE_STATUSES,
  type ActiveStatus,
  activeRunsQuery,
  mergeActiveRuns,
} from "../../lib/overview.ts";
import { useBackend } from "../../router-context.ts";
import { ErrorBanner } from "../error-banner.tsx";
import { RunTable } from "../run-list.tsx";

/** A list that came back full was cut at the limit, and the runs cut are the ones waiting longest. */
function CappedNote({ status, total }: { status: ActiveStatus; total: number | undefined }) {
  const of = total !== undefined && total > ACTIVE_LIMIT ? ` of ${total}` : "";

  return (
    <p className="text-xs text-muted">
      Showing the newest {ACTIVE_LIMIT}
      {of} {status} runs. Older ones are left out.{" "}
      <Link
        from="/"
        to="/"
        search={(previous) => ({ ...previous, status })}
        hash="runs"
        className="text-active underline-offset-2 hover:underline"
      >
        All {status} runs
      </Link>
    </p>
  );
}

/** Everything that holds or wants a worker right now, running first, oldest first within each. */
export function ActiveRuns({
  now,
  counts,
}: {
  now: number;
  counts: LoopyView["counts"] | undefined;
}) {
  const backend = useBackend();

  const lists = useQueries({
    queries: ACTIVE_STATUSES.map((status) => activeRunsQuery(backend, status)),
  });

  const error = lists.find((list) => list.error)?.error;
  const pending = lists.some((list) => list.isPending);
  const runs = mergeActiveRuns(lists.map((list) => list.data ?? []));

  // useQueries keeps the order of its input, so list i holds ACTIVE_STATUSES[i].
  const capped = lists.flatMap((list, index) => {
    const status = ACTIVE_STATUSES[index];

    return status !== undefined && list.data?.length === ACTIVE_LIMIT ? [status] : [];
  });

  return (
    <section aria-labelledby="active-heading" className="space-y-2">
      <div className="section-head">
        <h2 id="active-heading" className="section-title">
          Active now
          {!pending && !error && (
            <span className="ml-2 font-mono text-xs font-normal text-faint tabular-nums">
              {runs.length}
              {capped.length > 0 && "+"}
            </span>
          )}
        </h2>
        <p className="text-xs text-faint">Running, queued and suspended runs</p>
      </div>
      {error && <ErrorBanner error={error} />}
      {!pending && !error && runs.length === 0 && (
        <p className="panel px-3 py-3 text-muted">Nothing is running, queued or suspended.</p>
      )}
      {runs.length > 0 && <RunTable runs={runs} now={now} withLoopy />}
      {capped.map((status) => (
        <CappedNote key={status} status={status} total={counts?.[status]} />
      ))}
    </section>
  );
}
