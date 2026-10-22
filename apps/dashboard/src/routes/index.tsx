import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";
import { AwaitingYou, NextScheduled, RunningNow } from "../components/overview/live-lists.tsx";
import {
  ChartLegend,
  type ChartMetric,
  OutcomeChart,
} from "../components/overview/outcome-chart.tsx";
import { RunTable } from "../components/runs/run-table.tsx";
import { Load, Note } from "../components/ui/load.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { StatusGlyph } from "../components/ui/status.tsx";
import { useClock } from "../lib/clock.ts";
import { useDaemon, useOverview, useRunPages } from "../lib/ui-data.ts";
import { PERIODS, type Period, type StatusCounts } from "../lib/view-models.ts";

const searchSchema = z.object({
  period: z.enum(PERIODS).optional().catch(undefined),
  metric: z.enum(["runs", "failed"]).optional().catch(undefined),
});

export const Route = createFileRoute("/")({ validateSearch: searchSchema, component: Overview });

const PERIOD_TEXT = {
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
} satisfies Record<Period, string>;

function total(counts: StatusCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** The change against the previous window, or nothing when that window is unknown or empty. */
function Change({
  now,
  before,
  worseUp,
}: {
  now: number;
  before: number | null;
  worseUp: boolean;
}) {
  if (before === null || before === 0) {
    return null;
  }

  const change = (now - before) / before;
  const worse = worseUp ? change > 0 : change < 0;
  const tone = change === 0 ? "tone-neutral" : worse ? "tone-bad" : "tone-ok";

  return (
    <span className={`pill pill-sm pill-plain ${tone}`} title="Against the window before this one">
      {change > 0 ? "+" : ""}
      {(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%
    </span>
  );
}

function Tile(props: {
  label: ReactNode;
  value: ReactNode;
  note: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { label, value, note, selected, onSelect } = props;

  const body = (
    <>
      <span className="flex items-center gap-1.5 text-muted">{label}</span>
      <span className="mt-1.5 flex items-center gap-2 text-[28px] leading-8 font-semibold tracking-[-0.02em] tabular-nums">
        {value}
      </span>
      <span className="mt-1.5 block text-xs text-muted">{note}</span>
    </>
  );

  if (onSelect === undefined) {
    return (
      <div className="border-line px-5 py-4 max-lg:border-b lg:border-r lg:last:border-r-0">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className="cursor-pointer border-line px-5 py-4 text-left shadow-[inset_0_-2px_0_transparent] hover:bg-hover aria-selected:shadow-[inset_0_-2px_0_var(--ink)] max-lg:border-b lg:border-r"
    >
      {body}
    </button>
  );
}

function Metrics({ period, metric }: { period: Period; metric: ChartMetric }) {
  const overview = useOverview(period);
  const awaiting = useRunPages({ status: "suspended", waiting: true }, 20);
  const daemon = useDaemon();
  const navigate = Route.useNavigate();

  return (
    <section className="panel" aria-label="Run totals">
      <Load value={overview} pending={<Note>Loading totals.</Note>}>
        {(data) => {
          const runs = total(data.totals);
          const finished = data.totals.succeeded + data.totals.failed + data.totals.cancelled;

          return (
            <>
              <div
                role="tablist"
                aria-label="Chart"
                className="grid border-b border-line lg:grid-cols-4"
              >
                <Tile
                  label="Runs"
                  value={
                    <>
                      {runs.toLocaleString()}
                      <Change
                        now={runs}
                        before={data.previous ? total(data.previous) : null}
                        worseUp={false}
                      />
                    </>
                  }
                  note={
                    finished === 0
                      ? "None finished in this window"
                      : `${((data.totals.succeeded / finished) * 100).toFixed(1)}% of finished runs succeeded`
                  }
                  selected={metric === "runs"}
                  onSelect={() =>
                    void navigate({ search: (prev) => ({ ...prev, metric: undefined }) })
                  }
                />
                <Tile
                  label={
                    <>
                      <StatusGlyph status="failed" /> Failed
                    </>
                  }
                  value={
                    <>
                      {data.totals.failed.toLocaleString()}
                      <Change
                        now={data.totals.failed}
                        before={data.previous?.failed ?? null}
                        worseUp
                      />
                    </>
                  }
                  note={
                    finished === 0
                      ? "None finished in this window"
                      : `${((data.totals.failed / finished) * 100).toFixed(1)}% of finished runs`
                  }
                  selected={metric === "failed"}
                  onSelect={() =>
                    void navigate({ search: (prev) => ({ ...prev, metric: "failed" }) })
                  }
                />
                <Tile
                  label={
                    <>
                      <StatusGlyph status="awaiting" /> Awaiting
                    </>
                  }
                  value={
                    awaiting.state === "ready"
                      ? `${awaiting.data.rows.length}${awaiting.data.hasNext ? "+" : ""}`
                      : "…"
                  }
                  note="Right now, held on a hook"
                />
                <Tile
                  label={
                    <>
                      <StatusGlyph status="running" /> Running
                    </>
                  }
                  value={daemon.state === "ready" ? daemon.data.running : "…"}
                  note={
                    daemon.state === "ready"
                      ? `Right now, of ${daemon.data.concurrency} worker slots`
                      : daemon.state === "error"
                        ? "The daemon did not answer"
                        : "Asking the daemon"
                  }
                />
              </div>
              <div className="px-5 pt-4 pb-3">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <h2>{metric === "runs" ? "Runs by outcome" : "Failed runs"}</h2>
                  <span className="text-xs text-muted">
                    per{" "}
                    {data.bucketSeconds >= 86_400
                      ? "day"
                      : data.bucketSeconds >= 3600
                        ? "hour"
                        : `${data.bucketSeconds / 60} minutes`}
                  </span>
                  <span className="ml-auto">
                    <ChartLegend metric={metric} />
                  </span>
                </div>
                <OutcomeChart
                  buckets={data.buckets}
                  bucketSeconds={data.bucketSeconds}
                  metric={metric}
                />
              </div>
            </>
          );
        }}
      </Load>
    </section>
  );
}

const FAILURE_ROWS = 8;

function RecentFailures({ period }: { period: Period }) {
  const pager = useRunPages({ status: "failed", period }, FAILURE_ROWS);
  const now = useClock();

  return (
    <section className="table-card" aria-label="Recent failures">
      <div className="panel-head">
        <h2>Recent failures</h2>
        <span className="text-xs text-muted">{PERIOD_TEXT[period].toLowerCase()}</span>
        <Link to="/runs" search={{ status: "failed", period }} className="ml-auto text-xs">
          All failed runs
        </Link>
      </div>
      <Load value={pager} pending={<Note>Loading.</Note>}>
        {(page) =>
          page.rows.length === 0 ? (
            <Note>No run failed in this window.</Note>
          ) : (
            <RunTable runs={page.rows} now={now} withLoopy compact />
          )
        }
      </Load>
    </section>
  );
}

function Overview() {
  const { period = "24h", metric = "runs" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const now = useClock();

  return (
    <div className="content space-y-4">
      <div className="page-head mb-1">
        <div>
          <h1>Overview</h1>
          <p className="lede">{PERIOD_TEXT[period]}. Awaiting and running counts are live.</p>
        </div>
        <Segmented
          label="Window"
          value={period}
          options={PERIODS.map((value) => ({ value, label: value }))}
          onChange={(value) =>
            void navigate({
              search: (prev) => ({ ...prev, period: value === "24h" ? undefined : value }),
            })
          }
        />
      </div>
      <Metrics key={period} period={period} metric={metric} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <AwaitingYou now={now} />
        <RunningNow now={now} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <RecentFailures period={period} />
        <NextScheduled now={now} />
      </div>
    </div>
  );
}
