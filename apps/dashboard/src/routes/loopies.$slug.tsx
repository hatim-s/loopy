import type { GraphRevisionView, LoopyView } from "@loopy/contract";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Schema } from "effect";
import { useMemo, useState } from "react";
import { SourcePane } from "../components/code/source-pane";
import { GraphPane } from "../components/graph/pane";
import { loopyTarget } from "../components/loopy-select";
import { NodeDetails } from "../components/run/node-panel";
import { RunTable } from "../components/runs/run-table";
import { CronReading, FireTime } from "../components/schedules/text";
import { StartRunForm } from "../components/start-run-form";
import { Icon } from "../components/ui/icon";
import { Load, Note } from "../components/ui/load";
import { PagerFoot } from "../components/ui/pager";
import { useClock } from "../lib/clock";
import { graphModel } from "../lib/graph";
import { layoutGraph } from "../lib/graph-layout";
import { loopyInWorkspace } from "../lib/loopy-table";
import { useNodeSelection } from "../lib/node-selection";
import { useRunPages } from "../lib/pages";
import { definitionMarks } from "../lib/run-marks";
import { searchField } from "../lib/search";
import { useLoopyGraph, useLoopyRows, useLoopySource } from "../lib/ui-data";

const PANES = ["both", "code", "graph"] as const;

const searchSchema = Schema.Struct({
  workspace: searchField(Schema.String),
  node: searchField(Schema.String),
  panes: searchField(Schema.Literals(PANES)),
});

export const Route = createFileRoute("/loopies/$slug")({
  validateSearch: Schema.decodeUnknownSync(searchSchema),
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

function Definition({ loopy, graph }: { loopy: LoopyView; graph: GraphRevisionView }) {
  const { node: selected = null, panes = "both" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const source = useLoopySource(loopy.slug, loopy.workspace);
  const model = useMemo(() => graphModel(graph.graph, null), [graph.graph]);
  const layout = useMemo(() => layoutGraph(model), [model]);
  const marks = useMemo(() => definitionMarks(model), [model]);
  const inspected = model.nodes.find((node) => node.id === selected);

  const select = useNodeSelection(selected, (node) =>
    navigate({ search: (prev) => ({ ...prev, node }), replace: true }),
  );

  const setPanes = (next: (typeof PANES)[number]) =>
    void navigate({
      search: (prev) => ({ ...prev, panes: next === "both" ? undefined : next }),
      replace: true,
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
          <NodeDetails node={inspected} onClose={() => select(null)} />
        </div>
      )}
    </div>
  );
}

const RUN_ROWS = 25;

function LoopyRuns({ loopy }: { loopy: LoopyView }) {
  const target = loopyTarget(loopy);
  const pager = useRunPages(target, RUN_ROWS);
  const now = useClock();

  return (
    <section className="table-card" aria-label="Runs of this loopy">
      <div className="panel-head">
        <h2>Runs</h2>
        <Link to="/runs" search={target} className="ml-auto text-xs">
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
            <PagerFoot pager={pager} noun="runs">
              Newest first
            </PagerFoot>
          </>
        )}
      </Load>
    </section>
  );
}

function LoopyHead({ loopy, graph }: { loopy: LoopyView; graph: GraphRevisionView | null }) {
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
                  {loopy.schedule.state === "declared" ? (
                    <span className="text-muted">declared, not scheduled</span>
                  ) : loopy.schedule.enabled ? (
                    <FireTime at={loopy.schedule.nextFireAt} now={now} />
                  ) : (
                    <span className="text-muted">paused</span>
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
            {loopy.schedule?.state === "saved" ? "Edit schedule" : "Add schedule"}
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
    </header>
  );
}

function LoopyDetail({ loopy }: { loopy: LoopyView }) {
  const graph = useLoopyGraph(loopy.slug, loopy.workspace);

  return (
    <>
      <LoopyHead loopy={loopy} graph={graph.state === "ready" ? graph.data : null} />
      <Load value={graph} pending={<Note>Loading the saved graph.</Note>}>
        {(data) => <Definition loopy={loopy} graph={data} />}
      </Load>
      <LoopyRuns loopy={loopy} />
    </>
  );
}

function LoopyPage() {
  const { slug } = Route.useParams();
  const { workspace } = Route.useSearch();
  const loopies = useLoopyRows();

  return (
    <div className="flex w-full flex-col gap-4 px-6 pt-5 pb-10 max-md:px-3">
      <Load value={loopies} pending={<p className="text-muted">Loading loopy.</p>}>
        {(data) => {
          const loopy = loopyInWorkspace(data, slug, workspace);

          return loopy ? (
            <LoopyDetail loopy={loopy} />
          ) : (
            <p className="text-muted">No saved loopy has this slug in this workspace.</p>
          );
        }}
      </Load>
    </div>
  );
}
