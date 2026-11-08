import type { NodeRunView, ScopeCountsView } from "@loopy/contract";
import { type ReactNode, useState } from "react";
import type { GraphNodeModel } from "../../lib/graph";
import { useScopeItems } from "../../lib/pages";
import { itemsStarted } from "../../lib/run-marks";
import { countedStatuses, statusTone, statusWord } from "../../lib/status";
import type { Pager, ScopeItemRow, ScopeTuple } from "../../lib/view-models";
import { Icon } from "../ui/icon";
import { Load } from "../ui/load";
import { PagerFoot } from "../ui/pager";
import { Segmented } from "../ui/segmented";
import { StatusGlyph } from "../ui/status";

const ITEM_FILTERS = ["all", "failed", "running", "retrying", "succeeded"] as const;

type ItemFilter = (typeof ITEM_FILTERS)[number];

const FILTER_STATUS = {
  all: undefined,
  failed: "failed",
  running: "running",
  retrying: "retrying",
  succeeded: "succeeded",
} satisfies Record<ItemFilter, NodeRunView["status"] | undefined>;

/** One map's item list. The page owns it, so its page and filter outlive a change of node. */
export type ItemPicker = {
  mapId: GraphNodeModel["id"];
  parentScope: ScopeTuple;
  pager: Pager<ScopeItemRow>;
  filter: ItemFilter;
  setFilter: (filter: ItemFilter) => void;
};

/** Key it by map and parent scope. Items load only once something asks for them. */
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

// The worst status among an item's executions, so a failed item reads as failed.
function itemStatus(counts: ScopeCountsView["counts"]): NodeRunView["status"] | null {
  return countedStatuses(counts)[0]?.status ?? null;
}

function ItemCounts({ summary, running }: { summary: ScopeCountsView; running: boolean }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs">
        {itemsStarted(summary.total, running)}.{" "}
        <span className="text-muted">
          Counted from items with an execution, not from the list being mapped.
        </span>
      </p>
      <ul aria-label="Executions inside the map by status" className="flex flex-wrap gap-1.5">
        {countedStatuses(summary.counts).map(({ status, count }) => (
          <li key={status} className={`pill pill-sm tone-${statusTone(status)}`}>
            <StatusGlyph status={status} size={11} />
            {statusWord(status)} <span className="tabular-nums">{count.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MapItems(props: {
  picker: ItemPicker;
  summary: ScopeCountsView | undefined;
  running: boolean;
  openIndex: number | null;
  onOpen: (index: number) => void;
}) {
  const { picker, summary, running, openIndex, onOpen } = props;

  return (
    <>
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
                      <span className="w-14 font-mono text-muted tabular-nums">#{item.index}</span>
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
          )}
        </Load>
        <PagerFoot pager={picker.pager} noun="items" />
      </div>
    </>
  );
}

/** Steps through the picker's current page, with a way back to the list at the same page. */
export function ItemStrip(props: {
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
