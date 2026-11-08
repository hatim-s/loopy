import type { NodeRun, ScopeCountsView } from "@loopy/contract";
import type { ReactNode } from "react";
import type { GraphNodeModel } from "../../lib/graph";
import { nodeFacts } from "../../lib/node-facts";
import { useExecutions } from "../../lib/pages";
import type { ScopeTuple } from "../../lib/view-models";
import { KindGlyph } from "../graph/kind-glyph";
import { Icon } from "../ui/icon";
import { Load } from "../ui/load";
import { PagerFoot } from "../ui/pager";
import { StatusPill } from "../ui/status";
import { ExecutionCard } from "./execution-card";
import { type ItemPicker, ItemStrip, MapItems } from "./map-items";

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-t border-line px-4 py-3 first:border-t-0">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-semibold text-muted">{title}</h3>
        <span className="ml-auto">{aside}</span>
      </div>
      {children}
    </section>
  );
}

function Executions(props: {
  runId: string;
  nodeId: string;
  scope: ScopeTuple;
  now: number;
  control: boolean;
}) {
  const { runId, nodeId, scope, now, control } = props;
  const pager = useExecutions(runId, { scope, nodeId });

  return (
    <Load value={pager} pending={<p className="text-xs text-muted">Loading executions.</p>}>
      {(page) =>
        page.rows.length === 0 ? (
          <p className="text-xs text-muted">No execution recorded for this node here.</p>
        ) : (
          <div className="grid gap-2">
            {page.rows.map((row) => (
              <ExecutionCard
                key={JSON.stringify(row.execution.key.scope)}
                runId={runId}
                row={row}
                now={now}
                openOutput={!control}
              />
            ))}
            {(page.hasNext || page.hasPrevious) && <PagerFoot pager={pager} noun="executions" />}
          </div>
        )
      }
    </Load>
  );
}

/** The compiled node's settings. Closed on a run, where the execution matters more. */
function Definition({ node, open }: { node: GraphNodeModel; open: boolean }) {
  const facts = nodeFacts(node.node);

  if (facts.length === 0) {
    return null;
  }

  return (
    <details open={open} className="group border-t border-line px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-muted hover:text-ink">
        <span className="-rotate-90 transition-transform group-open:rotate-0">
          <Icon name="chevron" size={12} />
        </span>
        Definition
      </summary>
      <dl className="mt-2 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="truncate font-mono text-muted" title={label}>
              {label}
            </dt>
            <dd className="font-mono break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * Where the selected node sits relative to the map that runs it. `map`: the node is a map and
 * the picker lists its items. `inside`: the node runs per item of the picker's map.
 * `unreachable`: an enclosing map has no item open, so nothing can be listed.
 */
export type MapPlace =
  | { kind: "none" }
  | {
      kind: "map" | "inside";
      picker: ItemPicker;
      summary: ScopeCountsView | undefined;
      running: boolean;
    }
  | { kind: "unreachable" };

function Header({
  node,
  status,
  onClose,
}: {
  node: GraphNodeModel;
  status: NodeRun["status"] | null;
  onClose: () => void;
}) {
  return (
    <header className="flex items-start gap-2.5 px-4 pt-3.5 pb-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-control bg-raised">
        <KindGlyph kind={node.node.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px]" title={node.title}>
          {node.title}
        </h2>
        <p className="truncate text-xs text-muted">
          {node.node.kind} <code>{node.id}</code>
        </p>
      </div>
      {status && <StatusPill status={status} small />}
      <button
        type="button"
        className="icon-btn -mt-0.5 -mr-1.5"
        aria-label="Close node details"
        title="Close (Esc)"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </header>
  );
}

/** A saved definition's node: its settings only. */
export function NodeDetails({ node, onClose }: { node: GraphNodeModel; onClose: () => void }) {
  return (
    <aside aria-label={`Node ${node.title}`} className="flex min-h-0 flex-1 flex-col">
      <Header node={node} status={null} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
        <Definition node={node} open />
      </div>
    </aside>
  );
}

/**
 * A run's node. `scope` is where its execution lives: the run's top level, an open map item, or
 * null when the node runs per item and no item is open.
 */
export function RunNodePanel(props: {
  runId: string;
  node: GraphNodeModel;
  scope: ScopeTuple | null;
  place: MapPlace;
  openItem: number | null;
  onOpenItem: (index: number) => void;
  onSelectMap: () => void;
  onClose: () => void;
  now: number;
}) {
  const { runId, node, scope, place, openItem, onOpenItem, onSelectMap, onClose, now } = props;
  const status = node.state.kind === "ran" && scope !== null ? node.state.status : null;
  const inside = place.kind === "inside" ? place : null;

  const listing =
    place.kind === "map" || (place.kind === "inside" && openItem === null) ? place : null;

  return (
    <aside aria-label={`Node ${node.title}`} className="flex min-h-0 flex-1 flex-col">
      <Header node={node} status={status} onClose={onClose} />
      {inside && openItem !== null && (
        <ItemStrip
          picker={inside.picker}
          openIndex={openItem}
          onOpen={onOpenItem}
          onShowItems={onSelectMap}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
        {listing && (
          <Section title="Items">
            {listing.kind === "inside" && (
              <p className="text-xs text-muted">
                This node runs once per item. Pick an item to see its execution.
              </p>
            )}
            <MapItems
              picker={listing.picker}
              summary={listing.summary}
              running={listing.running}
              openIndex={openItem}
              onOpen={onOpenItem}
            />
          </Section>
        )}
        {place.kind === "unreachable" && (
          <Section title="Execution">
            <p className="text-xs text-muted">
              This node runs inside a map that is itself inside another map. Open an item of the
              outer map first.
            </p>
          </Section>
        )}
        {scope !== null && (
          <Section
            title={scope.length > 0 ? `Execution in item #${scope.at(-1)?.index}` : "Execution"}
          >
            <Executions
              key={JSON.stringify(scope)}
              runId={runId}
              nodeId={node.id}
              scope={scope}
              now={now}
              control={node.role === "control"}
            />
          </Section>
        )}
        <Definition node={node} open={false} />
      </div>
    </aside>
  );
}
