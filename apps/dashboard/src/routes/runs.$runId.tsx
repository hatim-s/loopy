import {
  executionKeySchema,
  type GraphRevisionView,
  type RunSnapshotView,
  type ScopeCountsView,
} from "@loopy/contract";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { type ReactNode, useMemo } from "react";
import { SourcePane } from "../components/code/source-pane";
import { ErrorBanner } from "../components/error-banner";
import { GraphPane } from "../components/graph/pane";
import { HookHistory, RunGuide } from "../components/run/guide";
import { RunHeader } from "../components/run/header";
import { MapPicker } from "../components/run/map-items";
import { type MapPlace, RunNodePanel } from "../components/run/node-panel";
import { RunTimeline } from "../components/run/timeline";
import { Icon } from "../components/ui/icon";
import { Load } from "../components/ui/load";
import { Segmented } from "../components/ui/segmented";
import { useClock } from "../lib/clock";
import { graphModel } from "../lib/graph";
import { layoutGraph } from "../lib/graph-layout";
import { useNodeSelection } from "../lib/node-selection";
import { useExecutions } from "../lib/pages";
import { focusOf, focusSummary, openItemTarget, scopeOf } from "../lib/run-focus";
import { mapRunning, runMarks } from "../lib/run-marks";
import { searchField } from "../lib/search";
import {
  useLoopyGraph,
  useRunGraph,
  useRunSnapshot,
  useRunSource,
  useScopes,
} from "../lib/ui-data";
import type { ScopeTuple } from "../lib/view-models";

const VIEWS = ["code", "split", "graph"] as const;

type View = (typeof VIEWS)[number];

const VIEW_LABEL = { code: "Code", split: "Both", graph: "Graph" } satisfies Record<View, string>;

/** Unknown values in a pasted URL fall back to the default view instead of an error page. */
const searchSchema = Schema.Struct({
  node: searchField(Schema.String),
  item: searchField(executionKeySchema.fields.scope),
  view: searchField(Schema.Literals(VIEWS)),
});

export const Route = createFileRoute("/runs/$runId")({
  validateSearch: Schema.decodeUnknownSync(searchSchema),
  component: RunPage,
});

/*
 * Pane heights. Code sizes to its lines between a floor and a cap, so a short file does not
 * leave a screen of empty panel. The graph needs a fixed box, so graph and split views take the
 * cap. The cap leaves room for the run header and the timeline bar on a laptop screen.
 */
const CODE_HEIGHT =
  "min-h-[400px] max-h-[70vh] lg:max-h-[clamp(400px,calc(100dvh-var(--head-h)-240px),640px)]";

const FIXED_HEIGHT = "h-[clamp(400px,calc(100dvh-var(--head-h)-240px),640px)]";

const SIDE_HEIGHT = "max-h-[70vh] lg:max-h-[clamp(400px,calc(100dvh-var(--head-h)-240px),640px)]";

function ItemChip({ item, onClose }: { item: ScopeTuple; onClose: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-control bg-active-soft py-0.5 pr-0.5 pl-2 text-xs text-active">
      Item
      {item.map((part) => (
        <code key={`${part.nodeId}:${part.index}`} className="tabular-nums">
          #{part.index}
        </code>
      ))}
      <button
        type="button"
        className="icon-btn size-6 text-active"
        aria-label="Close item, show the run's top level"
        title="Close item"
        onClick={onClose}
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

function Workspace(props: {
  snapshot: RunSnapshotView;
  graph: GraphRevisionView;
  rootScopes: ScopeCountsView[];
  now: number;
}) {
  const { snapshot, graph, rootScopes, now } = props;
  const { runId } = Route.useParams();
  const { node: selected = null, item = null, view = "code" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const source = useRunSource(runId);
  const latest = useLoopyGraph(snapshot.run.slug, snapshot.run.workspace);

  const itemPage = useExecutions(runId, item === null ? null : { scope: item });

  const nested = useScopes(runId, item ?? []);

  const itemRuns = useMemo(
    () =>
      item && itemPage.state === "ready" ? itemPage.data.rows.map((row) => row.execution) : [],
    [item, itemPage],
  );

  const scopes = useMemo(
    () => (item && nested.state === "ready" ? [...rootScopes, ...nested.data] : rootScopes),
    [item, rootScopes, nested],
  );

  const nodeRuns = useMemo(
    () => [...snapshot.nodeRuns, ...itemRuns],
    [snapshot.nodeRuns, itemRuns],
  );

  const definition = useMemo(() => graphModel(graph.graph, null), [graph.graph]);
  const layout = useMemo(() => layoutGraph(definition), [definition]);

  // The snapshot and the item page are bounded, so the selected node's own first page fills in
  // a node they cut off. NodePanel asks for the same page, so this adds no request.
  const selectedScope =
    selected !== null && graph.graph.nodes.some((node) => node.id === selected)
      ? scopeOf(definition, item, selected)
      : null;

  const selectedPage = useExecutions(
    runId,
    selected !== null && selectedScope !== null ? { scope: selectedScope, nodeId: selected } : null,
  );

  const selectedExecutions = useMemo(
    () =>
      selectedPage.state === "ready" ? selectedPage.data.rows.map((row) => row.execution) : [],
    [selectedPage],
  );

  const rootComplete = snapshot.nodeRunsNext == null;
  const itemComplete = itemPage.state === "ready" && itemPage.data.complete;

  const model = useMemo(
    () =>
      graphModel(graph.graph, {
        status: snapshot.run.status,
        nodeRuns,
        coverage: [
          { scope: [], complete: rootComplete },
          ...(item ? [{ scope: item, complete: itemComplete }] : []),
        ],
        selectedExecutions,
      }),
    [
      graph.graph,
      snapshot.run.status,
      nodeRuns,
      rootComplete,
      item,
      itemComplete,
      selectedExecutions,
    ],
  );

  const marks = useMemo(
    () => runMarks({ model, itemOpen: item !== null, scopes, now }),
    [model, item, scopes, now],
  );

  // A key set to undefined clears it; a key left out keeps its value.
  const setSearch = (patch: Partial<Schema.Schema.Type<typeof searchSchema>>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  const select = useNodeSelection(selected, (node) => setSearch({ node }));

  const inspected = model.nodes.find((node) => node.id === selected);

  const failed = model.nodes.find(
    (node) => node.state.kind === "ran" && node.state.status === "failed",
  );

  const focus = selected ? focusOf(definition, item, selected) : null;
  const openEntry = focus ? item?.find((part) => part.nodeId === focus.mapId) : undefined;
  const mapModel = focus ? model.nodes.find((node) => node.id === focus.mapId) : undefined;

  const openItem = (index: number) => {
    const target = focus && openItemTarget(focus, graph.graph, index);

    if (target) {
      setSearch(target);
    }
  };

  const switcher = (
    <Segmented
      label="Show"
      value={view}
      options={VIEWS.map((value) => ({ value, label: VIEW_LABEL[value] }))}
      onChange={(value) => setSearch({ view: value === "code" ? undefined : value })}
    />
  );

  const code = (
    <SourcePane
      source={source}
      graph={graph.graph}
      marks={marks}
      selected={selected}
      onSelect={select}
      toolbar={
        <>
          {item !== null && <ItemChip item={item} onClose={() => setSearch({ item: undefined })} />}
          {switcher}
        </>
      }
    />
  );

  const drawing = (
    <GraphPane
      model={model}
      layout={layout}
      entry={graph.graph.entry}
      revision={graph.revision}
      selected={selected}
      onSelect={select}
    />
  );

  const panel = (place: MapPlace) =>
    inspected && (
      <RunNodePanel
        runId={runId}
        node={inspected}
        scope={scopeOf(definition, item, inspected.id)}
        place={place}
        openItem={openEntry?.index ?? null}
        onOpenItem={openItem}
        onSelectMap={() => focus && select(focus.mapId)}
        onClose={() => select(null)}
        now={now}
      />
    );

  let side: ReactNode;

  if (!inspected) {
    side = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RunGuide model={model} marks={marks} onSelect={select} />
        <HookHistory hooks={snapshot.hooks} truncated={snapshot.hooksTruncated === true} />
      </div>
    );
  } else if (focus === null) {
    side = panel({ kind: "none" });
  } else if (focus.parentScope === null) {
    side = panel({ kind: "unreachable" });
  } else {
    const { mapId, parentScope, inside } = focus;

    // Keyed by map and scope, so the list keeps its page and filter while the reader moves
    // between the map and the nodes inside it.
    side = (
      <MapPicker
        key={JSON.stringify([mapId, parentScope])}
        runId={runId}
        mapId={mapId}
        parentScope={parentScope}
      >
        {(picker) =>
          panel({
            kind: inside ? "inside" : "map",
            picker,
            summary: focusSummary(scopes, focus),
            running: mapRunning(mapModel),
          })
        }
      </MapPicker>
    );
  }

  return (
    <>
      <RunHeader
        snapshot={snapshot}
        graph={graph.graph}
        revision={graph.revision}
        olderThanLatest={latest.state === "ready" && latest.data.revision !== graph.revision}
        now={now}
        onShowFailure={failed ? () => select(failed.id) : null}
      />
      {model.orphans.length > 0 && (
        <p role="alert" className="text-xs text-danger">
          {model.orphans.length} execution records name nodes missing from this revision, so the
          code and graph do not match the run.
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div
          className={`panel flex min-w-0 flex-col overflow-hidden ${view === "code" ? CODE_HEIGHT : FIXED_HEIGHT}`}
        >
          {view === "graph" && (
            <>
              <div className="flex min-h-11 items-center justify-end gap-2 border-b border-line px-2">
                {item !== null && (
                  <ItemChip item={item} onClose={() => setSearch({ item: undefined })} />
                )}
                {switcher}
              </div>
              <div className="min-h-0 flex-1">{drawing}</div>
            </>
          )}
          {view === "split" && (
            <div className="grid min-h-0 flex-1 lg:grid-cols-2">
              <div className="flex min-h-0 min-w-0 flex-col border-line lg:border-r">{code}</div>
              <div className="min-h-[360px] min-w-0">{drawing}</div>
            </div>
          )}
          {view === "code" && code}
        </div>
        <div className={`panel flex min-h-0 flex-col overflow-hidden ${SIDE_HEIGHT}`}>{side}</div>
      </div>
      <RunTimeline
        run={snapshot.run}
        nodes={model.nodes}
        partial={model.historyIncomplete}
        selected={selected}
        onSelect={select}
        now={now}
      />
    </>
  );
}

function RunPage() {
  const { runId } = Route.useParams();
  const snapshot = useRunSnapshot(runId);
  const graph = useRunGraph(runId);
  const rootScopes = useScopes(runId, []);
  const scopes = rootScopes.state === "ready" ? rootScopes.data : [];
  const now = useClock();

  return (
    <div className="flex w-full flex-col gap-3 px-6 pt-5 pb-10 max-md:px-3">
      <Load value={snapshot} pending={<p className="text-muted">Loading run.</p>}>
        {(run) =>
          graph.state === "error" ? (
            // A missing revision must not hide the run itself.
            <>
              <RunHeader
                snapshot={run}
                graph={null}
                revision={null}
                olderThanLatest={false}
                now={now}
                onShowFailure={null}
              />
              <ErrorBanner error={graph.error} />
            </>
          ) : (
            <Load
              value={graph}
              pending={<p className="text-muted">Loading the graph this run pinned.</p>}
            >
              {(pinned) => (
                <Workspace snapshot={run} graph={pinned} rootScopes={scopes} now={now} />
              )}
            </Load>
          )
        }
      </Load>
    </div>
  );
}
