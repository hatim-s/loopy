import { isTerminalRun, type RunView } from "loopy/contract";
import { elapsed } from "../../lib/format.ts";
import { runElapsed } from "../runs/run-table.tsx";
import { runStatus, statusWord } from "../ui/status.tsx";

const SLOTS = 10;

const FILL = {
  succeeded: "bg-[var(--chart-ok)]",
  failed: "bg-[var(--chart-bad)]",
  cancelled: "bg-[var(--chart-cancel)]",
  running: "bg-[var(--chart-live)]",
  queued: "bg-[var(--chart-live)]",
  suspended: "bg-attention",
} satisfies Record<RunView["status"], string>;

/**
 * The newest runs, oldest on the left. Each bar is coloured by outcome and sized by how long
 * the run took against the slowest of them, so a slow run stands out. Empty slots draw as dots
 * so a loopy with two runs does not look like one with ten.
 */
export function LastRuns({ runs, now }: { runs: RunView[]; now: number }) {
  const shown = runs.slice(0, SLOTS).reverse();
  const longest = Math.max(1, ...shown.map((run) => runElapsed(run, now)));
  const label = shown.map((run) => statusWord(runStatus(run)).toLowerCase()).join(", ");

  return (
    <span
      role="img"
      aria-label={
        shown.length === 0 ? "No runs" : `Last ${shown.length} runs, oldest first: ${label}`
      }
      className="flex h-6 items-end gap-[3px]"
    >
      {[...Array(SLOTS - shown.length).keys()].map((index) => (
        <i key={`empty-${index}`} className="mb-0.5 size-[3px] rounded-full bg-line-strong" />
      ))}
      {shown.map((run) => {
        const length = runElapsed(run, now);

        return (
          <i
            key={run.id}
            title={`${statusWord(runStatus(run))}, ${elapsed(length)}${isTerminalRun(run.status) ? "" : " so far"}`}
            className={`w-[5px] rounded-[1px] ${FILL[run.status]}`}
            style={{ height: `${Math.max(18, (length / longest) * 100)}%` }}
          />
        );
      })}
    </span>
  );
}
