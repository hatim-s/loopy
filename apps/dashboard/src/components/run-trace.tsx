import type { LogRecord, StepRecord } from "loopy/contract";
import { Fragment, useEffect, useRef } from "react";
import { groupTimeline } from "../lib/timeline.ts";
import { LogLines } from "./log-lines.tsx";
import { StepRow } from "./step-row.tsx";

/** Keeps the end of the trace in view while new entries arrive, unless the reader scrolled up. */
function useTail(length: number) {
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    const target = end.current;

    if (!target) {
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      following.current = entry?.isIntersecting ?? following.current;
    });

    observer.observe(target);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (following.current && length > 0) {
      end.current?.scrollIntoView({ block: "end" });
    }
  }, [length]);

  return end;
}

function WorkflowLogs({ logs }: { logs: LogRecord[] }) {
  return logs.length === 0 ? null : (
    <li className="grid grid-cols-[2.5rem_minmax(0,1fr)]">
      <span />
      <div className="py-1 pl-4.5">
        <LogLines logs={logs} />
      </div>
    </li>
  );
}

export function RunTrace({
  steps,
  logs,
  now,
}: {
  steps: StepRecord[];
  logs: LogRecord[];
  now: number;
}) {
  const timeline = groupTimeline(steps, logs);
  const end = useTail(steps.length + logs.length);

  return (
    <section aria-labelledby="trace-heading" className="space-y-3">
      <div className="flex items-baseline justify-between border-b border-line pb-2">
        <h2 id="trace-heading" className="font-medium">
          Trace
        </h2>
        <span className="text-xs text-muted tabular-nums">
          {steps.length} {steps.length === 1 ? "step" : "steps"}, {logs.length}{" "}
          {logs.length === 1 ? "log" : "logs"}
        </span>
      </div>
      {steps.length === 0 && logs.length === 0 ? (
        <p className="py-6 text-muted">No steps yet. They appear here as the run records them.</p>
      ) : (
        <ol className="space-y-1">
          <WorkflowLogs logs={timeline.before} />
          {timeline.steps.map(({ step, logs: stepLogs, after }) => (
            <Fragment key={step.seq}>
              <li className="grid grid-cols-[2.5rem_minmax(0,1fr)]">
                <span className="pt-2 pr-3 text-right font-mono text-xs text-muted tabular-nums">
                  {step.seq}
                </span>
                <StepRow step={step} logs={stepLogs} now={now} />
              </li>
              <WorkflowLogs logs={after} />
            </Fragment>
          ))}
        </ol>
      )}
      <div ref={end} />
    </section>
  );
}
