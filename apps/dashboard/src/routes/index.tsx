import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { routes } from "loopy/contract";
import { z } from "zod";
import { ErrorBanner } from "../components/error-banner.tsx";
import { LoopySortControl, LoopyTable } from "../components/loopy-table.tsx";
import { ActiveRuns } from "../components/overview/active-runs.tsx";
import { OutcomeRibbon } from "../components/overview/outcome-ribbon.tsx";
import { SummaryStrip } from "../components/overview/summary-strip.tsx";
import { RunList } from "../components/run-list.tsx";
import { StatusFilter } from "../components/status-filter.tsx";
import { useClock } from "../lib/clock.ts";
import { LOOPY_SORTS, totalCounts } from "../lib/overview.ts";
import { loopiesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

/** Unknown values in a pasted URL fall back to the default view instead of an error page. */
const searchSchema = z.object({
  status: routes.runs.query.shape.status.catch(undefined),
  sort: z.enum(LOOPY_SORTS).optional().catch(undefined),
});

export const Route = createFileRoute("/")({ validateSearch: searchSchema, component: Overview });

function Overview() {
  const { status, sort = "attention" } = Route.useSearch();
  const loopies = useQuery(loopiesQuery(useBackend()));
  const now = useClock();
  // Counts sum saved loopies, so they wait for that list rather than showing zeros beside runs.
  const counts = loopies.data ? totalCounts(loopies.data) : undefined;

  return (
    <div className="page max-w-[100rem] space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-[15px] font-semibold tracking-tight">Overview</h1>
        {loopies.data && (
          <p className="text-xs text-faint tabular-nums">
            Run counts cover {loopies.data.length} saved{" "}
            {loopies.data.length === 1 ? "loopy" : "loopies"}
          </p>
        )}
      </header>
      {loopies.error && <ErrorBanner error={loopies.error} />}
      {loopies.data && <SummaryStrip loopies={loopies.data} now={now} />}
      <OutcomeRibbon />
      <ActiveRuns now={now} counts={counts} />
      <section aria-labelledby="loopies-heading" className="space-y-2">
        <div className="section-head">
          <h2 id="loopies-heading" className="section-title">
            Loopies
          </h2>
          <LoopySortControl sort={sort} />
        </div>
        <LoopyTable now={now} sort={sort} />
      </section>
      <section id="runs" aria-labelledby="runs-heading" className="scroll-mt-4 space-y-2">
        <div className="section-head">
          <h2 id="runs-heading" className="section-title">
            Run history
          </h2>
          <StatusFilter selected={status} counts={counts} />
        </div>
        <RunList
          filters={{ status }}
          now={now}
          withLoopy
          empty={
            status
              ? `No ${status} runs.`
              : "No runs yet. Start one from a loopy's page or with loopy run <slug>."
          }
        />
      </section>
    </div>
  );
}
