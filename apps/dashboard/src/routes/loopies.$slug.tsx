import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type LoopyView, runsQuerySchema } from "loopy/contract";
import { z } from "zod";
import { Countdown } from "../components/countdown.tsx";
import { RouteError } from "../components/error-banner.tsx";
import { RunList } from "../components/run-list.tsx";
import { StartRunForm } from "../components/start-run-form.tsx";
import { StatusFilter } from "../components/status-filter.tsx";
import { useClock } from "../lib/clock.ts";
import { loopiesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

const SCOPE = {
  project: "Project loopy",
  global: "Global loopy",
} satisfies Record<LoopyView["scope"], string>;

/** An unknown status in a pasted URL falls back to every run instead of an error page. */
const searchSchema = z.object({ status: runsQuerySchema.shape.status.catch(undefined) });

export const Route = createFileRoute("/loopies/$slug")({
  validateSearch: searchSchema,
  loader: ({ context }) => context.queryClient.ensureQueryData(loopiesQuery(context.backend)),
  component: LoopyPage,
  pendingComponent: () => <p className="px-6 py-6 text-muted">Loading loopy.</p>,
  errorComponent: RouteError,
});

function useLoopy(slug: string): LoopyView | undefined {
  const { data } = useSuspenseQuery(loopiesQuery(useBackend()));

  return data.find((loopy) => loopy.slug === slug);
}

function LoopyHeader({ loopy, now }: { loopy: LoopyView; now: number }) {
  const { schedule } = loopy;

  return (
    <header className="space-y-1">
      <h1 className="text-xl font-semibold tracking-tight">{loopy.slug}</h1>
      {loopy.description && <p className="text-muted">{loopy.description}</p>}
      <p className="text-xs text-muted">
        {SCOPE[loopy.scope]}, {loopy.mode} mode.{" "}
        {schedule && (
          <span title={schedule.tz}>
            Scheduled <code className="font-mono">{schedule.cron}</code>
            {schedule.enabled && schedule.nextFireAt !== null ? (
              <>
                , next fire <Countdown at={schedule.nextFireAt} now={now} />.
              </>
            ) : (
              ", paused."
            )}
          </span>
        )}
      </p>
    </header>
  );
}

function LoopyPage() {
  const { slug } = Route.useParams();
  const { status } = Route.useSearch();
  const loopy = useLoopy(slug);
  const now = useClock();

  if (!loopy) {
    return <p className="px-6 py-6 text-muted">No saved loopy has this slug.</p>;
  }

  return (
    <article className="mx-auto max-w-4xl space-y-8 px-6 py-6">
      <LoopyHeader loopy={loopy} now={now} />
      <StartRunForm key={loopy.slug} loopy={loopy} />
      <section aria-labelledby="loopy-runs-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="loopy-runs-heading" className="font-medium">
            Runs
          </h2>
          <StatusFilter slug={slug} selected={status} counts={loopy.counts} />
        </div>
        <RunList
          filters={{ slug, status }}
          now={now}
          withLoopy={false}
          empty={status ? `No ${status} runs.` : "No runs yet. Start one above."}
        />
      </section>
    </article>
  );
}
