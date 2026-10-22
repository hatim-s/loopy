import { isTerminalRun, type NodeRunView, type RunView } from "loopy/contract";
import { useId, useState } from "react";
import { elapsed } from "../../lib/format.ts";
import type { GraphNodeModel } from "../../lib/graph.ts";
import { KindGlyph } from "../graph/kind-glyph.tsx";
import { Icon } from "../ui/icon.tsx";
import { statusTone } from "../ui/status.tsx";

const BAR = {
  ok: "bg-[var(--chart-ok)]",
  bad: "bg-[var(--chart-bad)]",
  warn: "bg-attention",
  blue: "bg-[var(--chart-live)]",
  neutral: "bg-[var(--chart-cancel)]",
} as const;

function end(execution: NodeRunView, now: number): number {
  return "endedAt" in execution ? Date.parse(execution.endedAt) : now;
}

const TICKS = 4;

/**
 * When each node ran, against the run's own clock. One lane per node that executed, one bar per
 * execution. It shows what the page holds: the top level, plus the open item's executions.
 * Rows select the node, so the timeline doubles as a way to move through the code. It starts
 * closed: the code carries each node's status, and the timeline answers when. `partial` means
 * a bounded page left executions out, so a missing lane is not proof a node never ran.
 */
export function RunTimeline(props: {
  run: RunView;
  nodes: GraphNodeModel[];
  partial: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
}) {
  const { run, nodes, partial, selected, onSelect, now } = props;
  const [open, setOpen] = useState(false);
  const id = useId();
  const start = Date.parse(run.createdAt);
  const finish = isTerminalRun(run.status) ? Date.parse(run.updatedAt) : now;
  const length = Math.max(1, finish - start);

  const lanes = nodes
    .filter((node) => node.executions.length > 0)
    .sort(
      (a, b) =>
        Math.min(...a.executions.map((x) => Date.parse(x.startedAt))) -
        Math.min(...b.executions.map((x) => Date.parse(x.startedAt))),
    );

  const at = (time: number) => `${((time - start) / length) * 100}%`;

  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <div className="flex h-10 items-center gap-2.5 px-3">
        <button
          type="button"
          className="text-btn -ml-1 font-semibold text-ink"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          <span className={`transition-transform ${open ? "" : "-rotate-90"}`}>
            <Icon name="chevron" size={12} />
          </span>
          <span id={`${id}-title`}>Timeline</span>
        </button>
        <span className="text-xs text-muted">
          {lanes.length} {lanes.length === 1 ? "node" : "nodes"}, {elapsed(length)}
          {isTerminalRun(run.status) ? "" : " so far"}
          {partial && ", loaded executions only"}
        </span>
      </div>
      {open && (
        <div id={id} className="relative border-t border-line pt-1 pb-2">
          {partial && (
            <p className="px-3 pt-1 pb-2 text-xs text-muted">
              This run has more executions than the page loaded. Nodes marked not loaded may have
              run. Select one to load its executions.
            </p>
          )}
          <div className="grid grid-cols-[200px_minmax(0,1fr)_80px] text-[11px] text-faint max-md:grid-cols-[120px_minmax(0,1fr)_64px]">
            <span className="px-3">
              Started {new Date(start).toLocaleTimeString(undefined, { hour12: false })}
            </span>
            <span className="relative h-5">
              {[...Array(TICKS + 1).keys()].map((index) => (
                <span
                  key={index}
                  className={`absolute top-0.5 whitespace-nowrap ${index === 0 ? "" : index === TICKS ? "-translate-x-full" : "-translate-x-1/2"}`}
                  style={{ left: `${(index / TICKS) * 100}%` }}
                >
                  +{elapsed((length * index) / TICKS)}
                </span>
              ))}
            </span>
            <span />
          </div>
          {lanes.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted">No node has started.</p>
          )}
          {lanes.map((node) => {
            const first = Math.min(...node.executions.map((x) => Date.parse(x.startedAt)));
            const last = Math.max(...node.executions.map((x) => end(x, now)));

            return (
              <button
                key={node.id}
                type="button"
                aria-pressed={node.id === selected}
                onClick={() => onSelect(node.id)}
                className="grid min-h-[24px] w-full cursor-pointer grid-cols-[200px_minmax(0,1fr)_80px] items-center text-left hover:bg-hover aria-pressed:bg-selected max-md:grid-cols-[120px_minmax(0,1fr)_64px]"
              >
                <span className="flex min-w-0 items-center gap-1.5 px-3 text-xs">
                  <span className="text-muted">
                    <KindGlyph kind={node.node.kind} />
                  </span>
                  <span className="truncate">{node.title}</span>
                  {node.executions.length > 1 && (
                    <span className="text-faint tabular-nums">×{node.executions.length}</span>
                  )}
                </span>
                <span className="relative h-3">
                  {node.executions.map((execution) => (
                    <i
                      key={JSON.stringify(execution.key.scope)}
                      title={`${execution.status}, ${elapsed(end(execution, now) - Date.parse(execution.startedAt))}`}
                      className={`absolute top-0 h-3 min-w-[2px] rounded-[2px] ${BAR[statusTone(execution.status)]}`}
                      style={{
                        left: at(Date.parse(execution.startedAt)),
                        width: `calc(${at(end(execution, now))} - ${at(Date.parse(execution.startedAt))})`,
                      }}
                    />
                  ))}
                </span>
                <span className="px-3 text-right text-xs text-muted tabular-nums">
                  {elapsed(last - first)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
