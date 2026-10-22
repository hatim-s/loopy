import type { NodeRunView } from "loopy/contract";
import { type ReactNode, useState } from "react";
import type { GraphNodeModel } from "../../lib/graph.ts";
import { nodeFacts } from "../../lib/node-facts.ts";
import { useExecutions, useScopeItems } from "../../lib/ui-data.ts";
import type { Page, Pager, ScopeItemRow, ScopeSummary, ScopeTuple } from "../../lib/view-models.ts";
import { KindGlyph } from "../graph/kind-glyph.tsx";
import { Icon } from "../ui/icon.tsx";
import { Load } from "../ui/load.tsx";
import { PagerFoot } from "../ui/pager.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { StatusGlyph, StatusPill, statusTone, statusWord } from "../ui/status.tsx";
import { ExecutionCard } from "./execution-card.tsx";

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

const ITEM_FILTERS = ["all", "failed", "running", "retrying", "succeeded"] as const;

type ItemFilter = (typeof ITEM_FILTERS)[number];

const FILTER_STATUS = {
  all: undefined,
  failed: "failed",
  running: "running",
  retrying: "retrying",
  succeeded: "succeeded",
} satisfies Record<ItemFilter, NodeRunView["status"] | undefined>;

const ITEM_PAGE = 50;

/** One map's item list. The page owns it, so its page and filter outlive a change of node. */
export type ItemPicker = {
  mapId: GraphNodeModel["id"];
  parentScope: ScopeTuple;
  pager: Pager<ScopeItemRow>;
  filter: ItemFilter;
  setFilter: (filter: ItemFilter) => void;
};

/**
 * Holds a map's item pager while the reader moves between the map and the nodes inside it.
 * Key it by map and parent scope. Items load 50 at a time, only once something asks for them.
 */
export function MapPicker(props: {
  runId: string;
  mapId: GraphNodeModel["id"];
  parentScope: ScopeTuple;
  children: (picker: ItemPicker) => ReactNode;
}) {
  const { runId, mapId, parentScope, children } = props;
  const [filter, setFilter] = useState<ItemFilter>("all");
  const pager = useScopeItems(runId, { nodeId: mapId, parentScope, status: FILTER_STATUS[filter] });

  return children({ mapId, parentScope, pager, filter, setFilter });
}

const WORST_FIRST = [
  "failed",
  "retrying",
  "running",
  "rate_limited",
  "waiting",
  "sleeping",
  "queued",
  "cancelled",
  "succeeded",
  "skipped",
] as const satisfies NodeRunView["status"][];

/** The worst status among an item's executions, so a failed item reads as failed. */
function itemStatus(counts: ScopeSummary["counts"]): NodeRunView["status"] | null {
  return WORST_FIRST.find((status) => (counts[status] ?? 0) > 0) ?? null;
}

/**
 * How many items started and what their executions did. The daemon counts an item once it has
 * an execution, so the number is what the run reached, never the size of the list it maps over.
 */
function ItemCounts({ summary, running }: { summary: ScopeSummary; running: boolean }) {
  const counts = WORST_FIRST.flatMap((status) => {
    const count = summary.counts[status] ?? 0;

    return count > 0 ? [{ status, count }] : [];
  });

  return (
    <div className="space-y-1.5">
      <p className="text-xs">
        <span className="font-medium tabular-nums">{summary.total.toLocaleString()}</span>{" "}
        {summary.total === 1 ? "item" : "items"} started{running ? " so far" : ""}.{" "}
        <span className="text-muted">
          Counted from items with an execution, not from the list being mapped.
        </span>
      </p>
      <ul aria-label="Executions inside the map by status" className="flex flex-wrap gap-1.5">
        {counts.map(({ status, count }) => (
          <li key={status} className={`pill pill-sm tone-${statusTone(status)}`}>
            <StatusGlyph status={status} size={11} />
            {statusWord(status)} <span className="tabular-nums">{count.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemFoot({ picker, page }: { picker: ItemPicker; page: Page<ScopeItemRow> }) {
  const first = page.offset + 1;

  return (
    <div className="flex h-9 items-center gap-1 border-t border-line pr-1 pl-3 text-xs text-muted">
      <span className="flex-1 tabular-nums" aria-live="polite">
        {page.rows.length === 0
          ? "No items"
          : `${first.toLocaleString()} to ${(page.offset + page.rows.length).toLocaleString()}`}
      </span>
      <button
        type="button"
        className="icon-btn size-7"
        onClick={picker.pager.previous}
        disabled={!page.hasPrevious}
        aria-label={`Previous ${ITEM_PAGE} items`}
      >
        <Icon name="left" />
      </button>
      <button
        type="button"
        className="icon-btn size-7"
        onClick={picker.pager.next}
        disabled={!page.hasNext}
        aria-label={`Next ${ITEM_PAGE} items`}
      >
        <Icon name="right" />
      </button>
    </div>
  );
}

function MapItems(props: {
  picker: ItemPicker;
  summary: ScopeSummary | undefined;
  running: boolean;
  openIndex: number | null;
  onOpen: (index: number) => void;
  lead: ReactNode;
}) {
  const { picker, summary, running, openIndex, onOpen, lead } = props;

  return (
    <Section title="Items">
      {lead}
      {summary && <ItemCounts summary={summary} running={running} />}
      <Segmented
        label="Item status"
        value={picker.filter}
        options={ITEM_FILTERS.map((value) => ({
          value,
          label: value === "all" ? "All" : statusWord(value),
        }))}
        onChange={picker.setFilter}
      />
      <div className="overflow-hidden rounded-control border border-line">
        <Load
          value={picker.pager}
          pending={<p className="p-3 text-xs text-muted">Loading items.</p>}
        >
          {(page, fetching) => (
            <>
              <ul className={`max-h-72 overflow-y-auto ${fetching ? "opacity-55" : ""}`}>
                {page.rows.length === 0 && (
                  <li className="p-3 text-xs text-muted">No item matches.</li>
                )}
                {page.rows.map((item) => {
                  const status = itemStatus(item.counts);

                  return (
                    <li key={item.index}>
                      <button
                        type="button"
                        aria-pressed={item.index === openIndex}
                        onClick={() => onOpen(item.index)}
                        className="flex h-8 w-full cursor-pointer items-center gap-2 border-b border-line px-3 text-left text-xs last:border-b-0 hover:bg-hover aria-pressed:bg-selected aria-pressed:shadow-[inset_2px_0_0_var(--lamp)]"
                      >
                        <span className="w-14 font-mono text-muted tabular-nums">
                          #{item.index}
                        </span>
                        {status && <StatusGlyph status={status} />}
                        <span className="flex-1 text-muted">
                          {status ? statusWord(status) : "No executions"}
                        </span>
                        <Icon name="right" size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <ItemFoot picker={picker} page={page} />
            </>
          )}
        </Load>
      </div>
    </Section>
  );
}

/**
 * Which item a node inside a map is showing, with steps through the picker's current page and
 * a way back to the list at the same page.
 */
function ItemStrip(props: {
  picker: ItemPicker;
  openIndex: number;
  onOpen: (index: number) => void;
  onShowItems: () => void;
}) {
  const { picker, openIndex, onOpen, onShowItems } = props;
  const rows = picker.pager.state === "ready" ? picker.pager.data.rows : [];
  const at = rows.findIndex((row) => row.index === openIndex);
  const previous = at > 0 ? rows[at - 1] : undefined;
  const next = at >= 0 ? rows[at + 1] : undefined;

  return (
    <div className="flex h-10 items-center gap-1 border-y border-line bg-sunken pr-2 pl-4 text-xs">
      <span className="text-muted">Item</span>
      <span className="font-mono tabular-nums">#{openIndex}</span>
      <button
        type="button"
        className="icon-btn ml-1 size-7"
        disabled={!previous}
        onClick={() => previous && onOpen(previous.index)}
        aria-label={previous ? `Item #${previous.index}` : "No earlier item on this page"}
      >
        <Icon name="left" size={14} />
      </button>
      <button
        type="button"
        className="icon-btn size-7"
        disabled={!next}
        onClick={() => next && onOpen(next.index)}
        aria-label={next ? `Item #${next.index}` : "No later item on this page"}
      >
        <Icon name="right" size={14} />
      </button>
      <button type="button" className="link-btn ml-auto" onClick={onShowItems}>
        All items
      </button>
    </div>
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
            {(page.hasNext || page.hasPrevious) && (
              <PagerFoot pager={pager} page={page} noun="executions" />
            )}
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

/** Where the selected node sits relative to the map that runs it, if any. */
export type MapPlace =
  | { kind: "none" }
  /** The node is a map; the picker lists its items. */
  | { kind: "map"; picker: ItemPicker; summary: ScopeSummary | undefined; running: boolean }
  /** The node runs per item of the picker's map. `openIndex` is null until an item opens. */
  | { kind: "inside"; picker: ItemPicker; summary: ScopeSummary | undefined; running: boolean }
  /** The node runs per item, but an enclosing map has no item open, so nothing can be listed. */
  | { kind: "unreachable" };

function Header({
  node,
  status,
  onClose,
}: {
  node: GraphNodeModel;
  status: NodeRunView["status"] | null;
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

/**
 * The side panel for the selected node. `scope` is where its execution lives: the run's top
 * level, an open map item, or null when the node runs per item and no item is open. A run page
 * passes `runId`; a definition page passes null and gets the node's settings only.
 */
export function NodePanel(props: {
  runId: string | null;
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
          <MapItems
            picker={listing.picker}
            summary={listing.summary}
            running={listing.running}
            openIndex={openItem}
            onOpen={onOpenItem}
            lead={
              listing.kind === "inside" && (
                <p className="text-xs text-muted">
                  This node runs once per item. Pick an item to see its execution.
                </p>
              )
            }
          />
        )}
        {place.kind === "unreachable" && (
          <Section title="Execution">
            <p className="text-xs text-muted">
              This node runs inside a map that is itself inside another map. Open an item of the
              outer map first.
            </p>
          </Section>
        )}
        {runId !== null && scope !== null && (
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
        <Definition node={node} open={runId === null} />
      </div>
    </aside>
  );
}
