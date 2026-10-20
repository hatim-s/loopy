import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type LoopyView, routes } from "loopy/contract";
import { z } from "zod";
import { type CanvasFrame, CanvasMessage, CanvasPage } from "../components/canvas-page.tsx";
import { Countdown } from "../components/countdown.tsx";
import { ErrorBanner, RouteError } from "../components/error-banner.tsx";
import { GraphStage } from "../components/graph/graph-stage.tsx";
import { RunStack } from "../components/run-list.tsx";
import { StartRunForm } from "../components/start-run-form.tsx";
import { StatusFilter } from "../components/status-filter.tsx";
import { useClock } from "../lib/clock.ts";
import { loopiesQuery, loopyGraphQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

const SCOPE = {
  project: "Project loopy",
  global: "Global loopy",
} satisfies Record<LoopyView["scope"], string>;

/** An unknown status in a pasted URL falls back to every run instead of an error page. */
const searchSchema = z.object({ status: routes.runs.query.shape.status.catch(undefined) });

export const Route = createFileRoute("/loopies/$slug")({
  validateSearch: searchSchema,
  loader: async ({ context, params }) => {
    const loopies = await context.queryClient.ensureQueryData(loopiesQuery(context.backend));
    // The slug alone can name another project's loopy, so the graph waits for the workspace.
    const loopy = loopies.find((item) => item.slug === params.slug);

    if (loopy) {
      void context.queryClient.prefetchQuery(
        loopyGraphQuery(context.backend, loopy.slug, loopy.workspace),
      );
    }

    return loopies;
  },
  component: LoopyPage,
  pendingComponent: () => <p className="page text-muted">Loading loopy.</p>,
  errorComponent: RouteError,
});

function useLoopy(slug: string): LoopyView | undefined {
  const { data } = useSuspenseQuery(loopiesQuery(useBackend()));

  return data.find((loopy) => loopy.slug === slug);
}

function ScheduleLine({ schedule, now }: { schedule: LoopyView["schedule"]; now: number }) {
  if (schedule === null) {
    return null;
  }

  if (schedule.nextFireAt === null) {
    return (
      <span title={schedule.tz}>
        Declares <code className="font-mono">{schedule.cron}</code>, not scheduled.
      </span>
    );
  }

  return (
    <span title={schedule.tz}>
      Scheduled <code className="font-mono">{schedule.cron}</code>
      {schedule.enabled ? (
        <>
          , next fire <Countdown at={schedule.nextFireAt} now={now} />.
        </>
      ) : (
        ", paused."
      )}
    </span>
  );
}

/** The compiled graph a new run will pin, drawn before anything starts. */
function DefinitionGraph({
  loopy,
  now,
  frame,
}: {
  loopy: LoopyView;
  now: number;
  frame: CanvasFrame;
}) {
  const graph = useQuery(loopyGraphQuery(useBackend(), loopy.slug, loopy.workspace));

  if (graph.isPending) {
    return <CanvasMessage>Loading the saved graph.</CanvasMessage>;
  }

  if (graph.isError) {
    return (
      <CanvasMessage>
        <ErrorBanner error={graph.error} />
      </CanvasMessage>
    );
  }

  return <GraphStage view={graph.data} run={null} now={now} frame={frame} />;
}

function LoopyDetails({ loopy, now }: { loopy: LoopyView; now: number }) {
  const { schedule } = loopy;

  return (
    <section aria-label="Details" className="space-y-1 px-3 py-3 text-xs text-muted">
      <p>
        {SCOPE[loopy.scope]}, {loopy.mode} mode.
      </p>
      <p>
        <ScheduleLine schedule={schedule} now={now} />{" "}
        <Link
          to="/schedules"
          search={{ slug: loopy.slug }}
          className="text-ink underline underline-offset-2 hover:text-active"
        >
          {schedule?.nextFireAt ? "Edit schedule" : "Schedule"}
        </Link>
      </p>
      <p className="truncate font-mono" title={loopy.workspace}>
        {loopy.workspace}
      </p>
    </section>
  );
}

function LoopyPage() {
  const { slug } = Route.useParams();
  const { status } = Route.useSearch();
  const loopy = useLoopy(slug);
  const now = useClock();

  if (!loopy) {
    return <p className="page text-muted">No saved loopy has this slug.</p>;
  }

  return (
    <CanvasPage
      label={`Loopy ${loopy.slug}`}
      header={
        <>
          <h1 className="truncate text-[17px] leading-tight font-semibold tracking-tight">
            {loopy.slug}
          </h1>
          {loopy.description && <p className="mt-0.5 text-xs text-muted">{loopy.description}</p>}
        </>
      }
      body={
        <>
          <LoopyDetails loopy={loopy} now={now} />
          <div className="border-t border-line px-3 py-3">
            <StartRunForm key={loopy.slug} loopy={loopy} />
          </div>
          <section
            aria-labelledby="loopy-runs-heading"
            className="space-y-2 border-t border-line px-3 py-3"
          >
            <h2 id="loopy-runs-heading" className="section-title">
              Runs
            </h2>
            <StatusFilter slug={slug} selected={status} counts={loopy.counts} />
            <RunStack
              filters={{ slug, status }}
              now={now}
              empty={status ? `No retained ${status} runs.` : "No retained runs."}
            />
          </section>
        </>
      }
    >
      {(frame) => <DefinitionGraph loopy={loopy} now={now} frame={frame} />}
    </CanvasPage>
  );
}
