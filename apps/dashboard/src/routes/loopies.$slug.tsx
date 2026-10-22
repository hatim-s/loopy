import { createFileRoute, Link } from "@tanstack/react-router";
import type { GraphRevisionView } from "loopy/contract";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { SourcePane } from "../components/code/source-pane.tsx";
import { GraphPane } from "../components/graph/graph-pane.tsx";
import { NodePanel } from "../components/run/node-panel.tsx";
import { RunTable } from "../components/runs/run-table.tsx";
import { CronReading, FireTime } from "../components/schedules/schedule-text.tsx";
import { StartRunForm } from "../components/start-run-form.tsx";
import { Icon } from "../components/ui/icon.tsx";
import { Load, Note } from "../components/ui/load.tsx";
import { PagerFoot } from "../components/ui/pager.tsx";
import { useClock } from "../lib/clock.ts";
import { graphModel } from "../lib/graph.ts";
import { layoutGraph } from "../lib/graph-layout.ts";
import { definitionMarks } from "../lib/run-marks.ts";
import { useLoopyGraph, useLoopyRows, useLoopySource, useRunPages } from "../lib/ui-data.ts";
import type { LoopyRow } from "../lib/view-models.ts";

const PANES = ["both", "code", "graph"] as const;

const searchSchema = z.object({
  node: z.string().optional().catch(undefined),
  panes: z.enum(PANES).optional().catch(undefined),
});

export const Route = createFileRoute("/loopies/$slug")({
  validateSearch: searchSchema,
  component: LoopyPage,
});

function PaneToggle(props: { label: string; shown: boolean; onToggle: () => void }) {
  const { label, shown, onToggle } = props;

  return (
    <button type="button" className="text-btn text-xs" aria-pressed={shown} onClick={onToggle}>
      <Icon name={label === "Code" ? "code" : "graph"} size={14} />
      {shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
    </button>
  );
}

function Definition({ loopy, graph }: { loopy: LoopyRow; graph: GraphRevisionView }) {
  const { node: selected = null, panes = "both" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const source = useLoopySource(loopy.slug, loopy.workspace);
  const model = useMemo(() => graphModel(graph.graph, null), [graph.graph]);
  const layout = useMemo(() => layoutGraph(model), [model]);
  const marks = useMemo(() => definitionMarks(model), [model]);
  const inspected = model.nodes.find((node) => node.id === selected);

  const select = (id: string | null) =>
    void navigate({ search: (prev) => ({ ...prev, node: id ?? undefined }), replace: true });

  const setPanes = (next: (typeof PANES)[number]) =>
    void navigate({
      search: (prev) => ({ ...prev, panes: next === "both" ? undefined : next }),
      replace: true,
    });

  useEffect(() => {
    if (selected === null) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        select(null);
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  });

  const showCode = panes !== "graph";
  const showGraph = panes !== "code";

  const toggles = (
    <span className="flex shrink-0 items-center">
      <PaneToggle
        label="Code"
        shown={showCode}
        onToggle={() => setPanes(showCode ? "graph" : "both")}
      />
      <PaneToggle
        label="Graph"
        shown={showGraph}
        onToggle={() => setPanes(showGraph ? "code" : "both")}
      />
    </span>
  );

  // Both panes stay mounted. Hiding one only hides it, so the graph keeps its zoom and pan and
  // the code keeps its scroll when the reader brings it back.
  return (
    <div className={`grid gap-3 ${inspected ? "xl:grid-cols-[minmax(0,1fr)_360px]" : ""}`}>
      <div
        className={`panel grid h-[clamp(420px,calc(100dvh-var(--head-h)-200px),720px)] min-w-0 overflow-hidden ${showCode && showGraph ? "lg:grid-cols-2" : ""}`}
      >
        <div
          className={`min-h-0 min-w-0 flex-col border-line lg:border-r ${showCode ? "flex" : "hidden"}`}
        >
          <SourcePane
            source={source}
            graph={graph.graph}
            marks={marks}
            selected={selected}
            onSelect={select}
            toolbar={toggles}
          />
        </div>
        <div className={`min-h-0 min-w-0 flex-col ${showGraph ? "flex" : "hidden"}`}>
          {!showCode && (
            <div className="flex min-h-11 items-center justify-end border-b border-line px-2">
              {toggles}
            </div>
          )}
          <div className="min-h-0 flex-1">
            <GraphPane
              model={model}
              layout={layout}
              entry={graph.graph.entry}
              revision={graph.revision}
              selected={selected}
              onSelect={select}
            />
          </div>
        </div>
      </div>
      {inspected && (
        <div className="panel flex max-h-[clamp(420px,calc(100dvh-var(--head-h)-200px),720px)] min-h-0 flex-col overflow-hidden">
          <NodePanel
            runId={null}
            node={inspected}
            scope={null}
            place={{ kind: "none" }}
            openItem={null}
            onOpenItem={() => undefined}
            onSelectMap={() => undefined}
            onClose={() => select(null)}
            now={0}
          />
        </div>
      )}
    </div>
  );
}

const RUN_ROWS = 25;

function LoopyRuns({ slug }: { slug: string }) {
  const pager = useRunPages({ slug }, RUN_ROWS);
  const now = useClock();

  return (
    <section className="table-card" aria-label="Runs of this loopy">
      <div className="panel-head">
        <h2>Runs</h2>
        <Link to="/runs" search={{ slug }} className="ml-auto text-xs">
          Filter all runs
        </Link>
      </div>
      <Load value={pager} pending={<Note>Loading runs.</Note>}>
        {(page, fetching) => (
          <>
            {page.rows.length === 0 ? (
              <Note>No run yet.</Note>
            ) : (
              <RunTable runs={page.rows} now={now} withLoopy={false} busy={fetching} />
            )}
            <PagerFoot pager={pager} page={page} noun="runs">
              Newest first
            </PagerFoot>
          </>
        )}
      </Load>
    </section>
  );
}

function LoopyHead({ loopy, graph }: { loopy: LoopyRow; graph: GraphRevisionView | null }) {
  const [starting, setStarting] = useState(false);
  const now = useClock();

  const input =
    loopy.input === "schema"
      ? "JSON schema"
      : Object.entries(loopy.input)
          .map(([key, type]) => `${key}: ${type}`)
          .join(", ") || "None";

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2">
            {loopy.slug}
            <span className="pill pill-sm pill-outline">{loopy.scope}</span>
            <span className="pill pill-sm pill-outline">{loopy.mode}</span>
          </h1>
          {loopy.description && <p className="lede">{loopy.description}</p>}
          <p className="facts">
            <span>
              <span>Input</span>
              <code>{input}</code>
            </span>
            <span>
              <span>Schedule</span>
              {loopy.schedule ? (
                <span className="inline-flex items-baseline gap-2">
                  <CronReading cron={loopy.schedule.cron} tz={loopy.schedule.tz} />
                  {loopy.schedule.enabled && loopy.schedule.nextFireAt ? (
                    <FireTime at={loopy.schedule.nextFireAt} now={now} />
                  ) : (
                    <span className="text-muted">
                      {loopy.schedule.nextFireAt === null ? "declared, not scheduled" : "paused"}
                    </span>
                  )}
                </span>
              ) : (
                "Manual"
              )}
            </span>
            {graph && (
              <>
                <span>
                  <span>Revision</span>
                  <code>{graph.revision.slice(0, 8)}</code>
                </span>
                <span>
                  <span>Nodes</span>
                  {graph.graph.nodes.length}
                </span>
                {graph.graph.meta.secrets.length > 0 && (
                  <span>
                    <span>Secrets</span>
                    <code>{graph.graph.meta.secrets.join(", ")}</code>
                  </span>
                )}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/schedules"
            search={{ workspace: loopy.workspace, slug: loopy.slug }}
            className="btn"
          >
            {loopy.schedule?.nextFireAt ? "Edit schedule" : "Add schedule"}
          </Link>
          <button
            type="button"
            className="btn btn-primary"
            aria-expanded={starting}
            onClick={() => setStarting(!starting)}
          >
            Start run
          </button>
        </div>
      </div>
      {starting && (
        <div className="panel max-w-xl p-4">
          <StartRunForm key={loopy.slug} loopy={loopy} />
        </div>
      )}
      {graph && graph.graph.warnings.length > 0 && (
        <details className="text-xs text-attention">
          <summary className="cursor-pointer">
            {graph.graph.warnings.length} compiler{" "}
            {graph.graph.warnings.length === 1 ? "warning" : "warnings"}
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {graph.graph.warnings.map((warning) => (
              <li key={`${warning.code}:${warning.nodeId}:${warning.message}`}>
                {warning.code}
                {warning.nodeId !== null && ` at ${warning.label ?? warning.nodeId}`}:{" "}
                {warning.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </header>
  );
}

function LoopyView({ loopy }: { loopy: LoopyRow }) {
  const graph = useLoopyGraph(loopy.slug, loopy.workspace);

  return (
    <>
      <LoopyHead loopy={loopy} graph={graph.state === "ready" ? graph.data : null} />
      <Load value={graph} pending={<Note>Loading the saved graph.</Note>}>
        {(data) => <Definition loopy={loopy} graph={data} />}
      </Load>
      <LoopyRuns slug={loopy.slug} />
    </>
  );
}

function LoopyPage() {
  const { slug } = Route.useParams();
  const loopies = useLoopyRows();

  return (
    <div className="flex w-full flex-col gap-4 px-6 pt-5 pb-10 max-md:px-3">
      <Load value={loopies} pending={<p className="text-muted">Loading loopy.</p>}>
        {(data) => {
          const loopy = data.find((item) => item.slug === slug);

          return loopy ? (
            <LoopyView loopy={loopy} />
          ) : (
            <p className="text-muted">No saved loopy has this slug.</p>
          );
        }}
      </Load>
    </div>
  );
}
