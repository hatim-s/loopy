import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RouteError } from "../components/error-banner.tsx";
import { HookPanel } from "../components/hook-panel.tsx";
import { RunHeader } from "../components/run-header.tsx";
import { RunIo } from "../components/run-io.tsx";
import { RunTrace } from "../components/run-trace.tsx";
import { useClock } from "../lib/clock.ts";
import { useRunStream } from "../lib/connection.ts";
import { runQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

export const Route = createFileRoute("/runs/$runId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(runQuery(context.backend, params.runId)),
  component: RunPage,
  pendingComponent: () => <p className="px-6 py-6 text-muted">Loading run.</p>,
  errorComponent: RouteError,
});

function RunPage() {
  const { runId } = Route.useParams();
  const { data } = useSuspenseQuery(runQuery(useBackend(), runId));
  const { run, steps, logs } = data;
  const now = useClock();

  useRunStream(runId);

  return (
    <article className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <RunHeader run={run} now={now} />
      <HookPanel snapshot={data} now={now} />
      <RunIo run={run} />
      <RunTrace steps={steps} logs={logs} now={now} />
    </article>
  );
}
