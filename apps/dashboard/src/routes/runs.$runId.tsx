import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { RunSnapshotView } from "loopy/contract";
import { useId, useState } from "react";
import { type CanvasFrame, CanvasMessage, CanvasPage } from "../components/canvas-page.tsx";
import { ErrorBanner, RouteError } from "../components/error-banner.tsx";
import { GraphStage } from "../components/graph/graph-stage.tsx";
import { HookPanel } from "../components/hook-panel.tsx";
import { LogLines } from "../components/log-lines.tsx";
import { RunFacts, RunTitle } from "../components/run-header.tsx";
import { RunIo } from "../components/run-io.tsx";
import { RunTrace } from "../components/run-trace.tsx";
import { useClock } from "../lib/clock.ts";
import { loopyGraphQuery, runGraphQuery, runQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

export const Route = createFileRoute("/runs/$runId")({
  loader: ({ context, params }) => {
    // The graph loads beside the snapshot; a missing revision must not hide the run.
    if (context.backend.graphSupport === "available") {
      void context.queryClient.prefetchQuery(runGraphQuery(context.backend, params.runId));
    }

    return context.queryClient.ensureQueryData(runQuery(context.backend, params.runId));
  },
  component: RunPage,
  pendingComponent: () => <p className="page text-muted">Loading run.</p>,
  errorComponent: RouteError,
});

function RunGraph(props: { snapshot: RunSnapshotView; now: number; frame: CanvasFrame }) {
  const { snapshot, now, frame } = props;
  const backend = useBackend();
  const graph = useQuery(runGraphQuery(backend, snapshot.run.id));

  // Only labels an older pin; a removed loopy leaves the pinned graph fully usable.
  const latest = useQuery({
    ...loopyGraphQuery(backend, snapshot.run.slug, snapshot.run.workspace),
    retry: false,
  });

  if (graph.isPending) {
    return <CanvasMessage>Loading the graph this run pinned.</CanvasMessage>;
  }

  if (graph.isError) {
    return (
      <CanvasMessage>
        <ErrorBanner error={graph.error} />
      </CanvasMessage>
    );
  }

  return (
    <GraphStage
      // A cached graph keeps the stage mounted across runs, so the key resets node selection.
      key={`${snapshot.run.id}:${graph.data.revision}`}
      view={graph.data}
      run={{
        status: snapshot.run.status,
        nodeRuns: snapshot.nodeRuns,
        logs: snapshot.logs,
        latestRevision: latest.data?.revision ?? null,
      }}
      now={now}
      frame={frame}
    />
  );
}

const TABS = ["details", "logs"] as const;

type Tab = (typeof TABS)[number];

/** Details and the run's logs share the panel, so long logs never push the facts away. */
function RunBody({ snapshot, now }: { snapshot: RunSnapshotView; now: number }) {
  const [tab, setTab] = useState<Tab>("details");
  const id = useId();
  const { run, logs } = snapshot;

  return (
    <>
      <div
        role="tablist"
        aria-label="Run"
        className="sticky top-0 z-10 flex gap-0.5 border-b border-line bg-panel px-2 py-1.5"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-${name}-panel`}
            className="chip"
            onClick={() => setTab(name)}
          >
            {name === "details" ? "Details" : "Logs"}
            {name === "logs" && (
              <span className="font-mono text-faint tabular-nums">{logs.length}</span>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-${tab}-panel`}
        aria-labelledby={`${id}-${tab}`}
        className="space-y-3 px-3 py-3"
      >
        {tab === "details" ? (
          <>
            <RunFacts run={run} now={now} />
            <HookPanel snapshot={snapshot} now={now} />
            <RunIo run={run} />
          </>
        ) : logs.length === 0 ? (
          <p className="text-xs text-muted">No logs recorded.</p>
        ) : (
          <LogLines logs={logs} />
        )}
      </div>
    </>
  );
}

function RunPage() {
  const { runId } = Route.useParams();
  const backend = useBackend();
  const { data } = useSuspenseQuery(runQuery(backend, runId));
  const now = useClock();

  return (
    <CanvasPage
      label={`Run ${data.run.id}`}
      header={<RunTitle run={data.run} />}
      body={<RunBody key={data.run.id} snapshot={data} now={now} />}
    >
      {(frame) =>
        backend.graphSupport === "legacy_unavailable" ? (
          <RunTrace steps={data.steps} now={now} frame={frame} />
        ) : (
          <RunGraph snapshot={data} now={now} frame={frame} />
        )
      }
    </CanvasPage>
  );
}
