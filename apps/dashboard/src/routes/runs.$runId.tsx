import { createFileRoute } from "@tanstack/react-router";
import {
  executionKeySchema,
  type GraphRevisionView,
  type NodeRunView,
  type RunSnapshotView,
} from "loopy/contract";
import { type ReactNode, useEffect, useMemo } from "react";
import { z } from "zod";
import { SourcePane } from "../components/code/source-pane.tsx";
import { ErrorBanner } from "../components/error-banner.tsx";
import { GraphPane } from "../components/graph/graph-pane.tsx";
import { MapPicker, type MapPlace, NodePanel } from "../components/run/node-panel.tsx";
import { HookHistory, RunGuide } from "../components/run/run-guide.tsx";
import { RunHeader } from "../components/run/run-header.tsx";
import { RunTimeline } from "../components/run/run-timeline.tsx";
import { Icon } from "../components/ui/icon.tsx";
import { Load } from "../components/ui/load.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { useClock } from "../lib/clock.ts";
import { type GraphModel, graphModel } from "../lib/graph.ts";
import { layoutGraph } from "../lib/graph-layout.ts";
import { firstInside, owningMap, perItemNodes, runMarks } from "../lib/run-marks.ts";
import {
  useExecutions,
  useLoopyGraph,
  useRunGraph,
  useRunSnapshot,
  useRunSource,
  useScopes,
} from "../lib/ui-data.ts";
import type { ScopeSummary, ScopeTuple } from "../lib/view-models.ts";

const VIEWS = ["code", "split", "graph"] as const;

type View = (typeof VIEWS)[number];

const VIEW_LABEL = { code: "Code", split: "Both", graph: "Graph" } satisfies Record<View, string>;

/** Unknown values in a pasted URL fall back to the default view instead of an error page. */
const searchSchema = z.object({
  node: z.string().optional().catch(undefined),
  item: executionKeySchema.shape.scope.optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
});

export const Route = createFileRoute("/runs/$runId")({
  validateSearch: searchSchema,
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

const SETTLED = new Set<NodeRunView["status"]>(["succeeded", "failed", "cancelled", "skipped"]);

function sameScope(a: ScopeTuple, b: ScopeTuple): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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

/** Where the selected map or the map around the selected node sits, and its picker scope. */
function focusOf(options: {
  graph: GraphRevisionView["graph"];
  model: GraphModel;
  selected: string;
  scopeOf: (nodeId: string) => ScopeTuple | null;
}): {
  mapId: GraphModel["nodes"][number]["id"];
  parentScope: ScopeTuple | null;
  inside: boolean;
} | null {
  const { graph, model, selected, scopeOf } = options;
  const node = model.nodes.find((item) => item.id === selected);

  if (node?.node.kind === "map") {
    return { mapId: node.id, parentScope: scopeOf(node.id), inside: false };
  }

  const mapId = owningMap(graph, selected);

  return mapId === null ? null : { mapId, parentScope: scopeOf(mapId), inside: true };
}

function Workspace(props: {
  snapshot: RunSnapshotView;
  graph: GraphRevisionView;
  rootScopes: ScopeSummary[];
}) {
  const { snapshot, graph, rootScopes } = props;
  const { runId } = Route.useParams();
  const { node: selected = null, item = null, view = "code" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const now = useClock();
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

  const perItem = useMemo(() => perItemNodes(graph.graph), [graph.graph]);

  // Where a node executes: the top level, or the open item of the map that owns it. Null when
  // it runs per item and that map has no item open.
  const scopeOf = (nodeId: string): ScopeTuple | null => {
    if (!perItem.has(nodeId)) {
      return [];
    }

    const owner = owningMap(graph.graph, nodeId);
    const depth = item?.findIndex((part) => part.nodeId === owner) ?? -1;

    return item && depth >= 0 ? item.slice(0, depth + 1) : null;
  };

  // The snapshot and the item page are bounded, so the selected node's own first page fills in
  // a node they cut off. NodePanel asks for the same page, so this adds no request.
  const selectedScope =
    selected !== null && graph.graph.nodes.some((node) => node.id === selected)
      ? scopeOf(selected)
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

  const layout = useMemo(() => layoutGraph(graphModel(graph.graph, null)), [graph.graph]);

  const marks = useMemo(
    () => runMarks({ model, perItem, itemOpen: item !== null, scopes, now }),
    [model, perItem, item, scopes, now],
  );

  // A key set to undefined clears it; a key left out keeps its value.
  const setSearch = (patch: Partial<z.output<typeof searchSchema>>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  const select = (id: string | null) => setSearch({ node: id ?? undefined });

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

  const inspected = model.nodes.find((node) => node.id === selected);

  const failed = model.nodes.find(
    (node) => node.state.kind === "ran" && node.state.status === "failed",
  );

  const focus = selected ? focusOf({ graph: graph.graph, model, selected, scopeOf }) : null;
  const openEntry = focus ? item?.find((part) => part.nodeId === focus.mapId) : undefined;
  const mapModel = focus ? model.nodes.find((node) => node.id === focus.mapId) : undefined;

  const openItem = (index: number) => {
    if (!focus || focus.parentScope === null) {
      return;
    }

    // Opening an item from the map's list moves to the first node it runs, where the item's
    // input, output and error live. From a node inside the map, the node stays.
    const next = [...focus.parentScope, { nodeId: focus.mapId, index }];

    setSearch(
      focus.inside
        ? { item: next }
        : { item: next, node: firstInside(graph.graph, focus.mapId) ?? focus.mapId },
    );
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
      <NodePanel
        runId={runId}
        node={inspected}
        scope={scopeOf(inspected.id)}
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
            summary: scopes.find(
              (summary) => summary.nodeId === mapId && sameScope(summary.parentScope, parentScope),
            ),
            running: mapModel?.state.kind === "ran" ? !SETTLED.has(mapModel.state.status) : false,
          })
        }
      </MapPicker>
    );
  }

  return (
    <>
      <RunHeader
        snapshot={snapshot}
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

  return (
    <div className="flex w-full flex-col gap-3 px-6 pt-5 pb-10 max-md:px-3">
      <Load value={snapshot} pending={<p className="text-muted">Loading run.</p>}>
        {(run) =>
          graph.state === "error" ? (
            // A missing revision must not hide the run itself.
            <>
              <RunHeader
                snapshot={run}
                revision={null}
                olderThanLatest={false}
                now={Date.now()}
                onShowFailure={null}
              />
              <ErrorBanner error={graph.error} />
            </>
          ) : (
            <Load
              value={graph}
              pending={<p className="text-muted">Loading the graph this run pinned.</p>}
            >
              {(pinned) => <Workspace snapshot={run} graph={pinned} rootScopes={scopes} />}
            </Load>
          )
        }
      </Load>
    </div>
  );
}
