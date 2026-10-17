import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorBanner } from "../components/error-banner.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { timestamp } from "../lib/format.ts";
import { runsQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

export const Route = createFileRoute("/")({ component: RecentRuns });

const RECENT = { limit: 50 } as const;

function RecentRuns() {
  const runs = useQuery(runsQuery(useBackend(), RECENT));

  return (
    <section aria-labelledby="runs-heading" className="mx-auto max-w-4xl space-y-3 px-6 py-6">
      <h1 id="runs-heading" className="text-base font-semibold">
        Recent runs
      </h1>
      {runs.error && <ErrorBanner error={runs.error} />}
      {runs.data?.length === 0 && (
        <p className="text-muted">
          No runs yet. Start one with <code className="font-mono">loopy run &lt;slug&gt;</code>.
        </p>
      )}
      <ul className="divide-y divide-line border-y border-line">
        {runs.data?.map((run) => (
          <li key={run.id}>
            <Link
              to="/runs/$runId"
              params={{ runId: run.id }}
              className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-baseline gap-4 px-2 py-2 hover:bg-raised"
            >
              <StatusBadge status={run.status} />
              <span className="min-w-0 truncate">
                <span className="font-medium">{run.slug}</span>{" "}
                <span className="font-mono text-xs text-muted">{run.id}</span>
                {run.waitingOn && (
                  <span className="ml-2 text-xs text-attention">
                    waiting on {run.waitingOn.hook}
                  </span>
                )}
              </span>
              <time dateTime={run.createdAt} className="text-xs text-muted tabular-nums">
                {timestamp(run.createdAt)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
