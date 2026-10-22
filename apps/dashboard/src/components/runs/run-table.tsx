import { Link } from "@tanstack/react-router";
import { isTerminalRun, type RunView } from "loopy/contract";
import { ago, elapsed, shortId } from "../../lib/format.ts";
import { TimeStamp } from "../time-stamp.tsx";
import { RunPill } from "../ui/status.tsx";

/** How long a run took, or has taken so far. Terminal runs end at their last update. */
export function runElapsed(run: RunView, now: number): number {
  return (isTerminalRun(run.status) ? Date.parse(run.updatedAt) : now) - Date.parse(run.createdAt);
}

const PREVIEW = 120;

export function bytes(count: number): string {
  if (count < 1024) {
    return `${count} B`;
  }

  return count < 1_048_576
    ? `${(count / 1024).toFixed(1)} KB`
    : `${(count / 1_048_576).toFixed(1)} MB`;
}

/** One line that says how the run ended or what holds it. */
export type RunResult = { text: string; tone: string };

export function runResult(run: RunView): RunResult {
  switch (run.status) {
    case "failed": {
      return { text: run.error.split("\n")[0] ?? run.error, tone: "text-danger" };
    }

    case "succeeded": {
      const truncated = run.truncatedFields?.output;

      if (truncated !== undefined) {
        return {
          text: `Output is ${bytes(truncated)}. Open the run to load it.`,
          tone: "text-muted",
        };
      }

      const text = JSON.stringify(run.output);

      return {
        text: text === "null" ? "Output: null" : text.slice(0, PREVIEW),
        tone: "text-muted",
      };
    }

    case "suspended": {
      if (run.waitingOn) {
        return { text: `Waiting on ${run.waitingOn.hook}`, tone: "text-attention" };
      }

      return run.wakeAt === null
        ? { text: "Suspended with no wake time", tone: "text-muted" }
        : { text: `Sleeping until ${new Date(run.wakeAt).toLocaleString()}`, tone: "text-muted" };
    }

    case "cancelled": {
      return { text: "Cancelled", tone: "text-muted" };
    }

    default: {
      return {
        text: run.ownerStale ? "Owner stopped heartbeating" : "In progress",
        tone: "text-muted",
      };
    }
  }
}

/**
 * Runs as table rows. `withLoopy` drops the loopy column on a loopy's own page. `compact` shows
 * the start as an age and drops the duration, for narrow panels.
 */
export function RunTable(props: {
  runs: RunView[];
  now: number;
  withLoopy: boolean;
  busy?: boolean;
  compact?: boolean;
}) {
  const { runs, now, withLoopy, busy = false, compact = false } = props;

  return (
    <div className="table-scroll">
      <table className={`data ${busy ? "busy" : ""}`}>
        <thead>
          <tr>
            <th scope="col" className="w-36">
              Status
            </th>
            {withLoopy && <th scope="col">Loopy</th>}
            <th scope="col" className="w-28">
              Run
            </th>
            <th scope="col" className={compact ? "w-24" : "w-56"}>
              Started
            </th>
            {!compact && (
              <th scope="col" className="num w-24">
                Duration
              </th>
            )}
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const result = runResult(run);

            return (
              <tr key={run.id}>
                <td>
                  <RunPill run={run} />
                </td>
                {withLoopy && (
                  <td className="max-w-56">
                    <span className="cell-main">{run.loopy.slug}</span>
                  </td>
                )}
                <td>
                  <Link
                    to="/runs/$runId"
                    params={{ runId: run.id }}
                    className="row-link font-mono text-xs"
                    aria-label={`Run ${run.id} of ${run.loopy.slug}`}
                  >
                    <span className="inline-block max-w-[14ch] truncate align-bottom">
                      {shortId(run.id)}
                    </span>
                  </Link>
                </td>
                <td>
                  {compact ? (
                    <time dateTime={run.createdAt} className="text-xs whitespace-nowrap text-muted">
                      {ago(run.createdAt, now)}
                    </time>
                  ) : (
                    <TimeStamp at={run.createdAt} now={now} />
                  )}
                </td>
                {!compact && <td className="num">{elapsed(runElapsed(run, now))}</td>}
                <td
                  className={`max-w-[28rem] truncate font-mono text-xs ${result.tone}`}
                  title={result.text}
                >
                  {result.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
