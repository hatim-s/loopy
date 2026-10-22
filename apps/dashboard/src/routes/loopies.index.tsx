import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { LastRuns } from "../components/loopies/last-runs.tsx";
import { CronReading, FireTime } from "../components/schedules/schedule-text.tsx";
import { Icon } from "../components/ui/icon.tsx";
import { Load, Note } from "../components/ui/load.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { RunPill, StatusPill } from "../components/ui/status.tsx";
import { useClock } from "../lib/clock.ts";
import { ago } from "../lib/format.ts";
import {
  LOOPY_FILTERS,
  LOOPY_SORTS,
  type LoopyFilter,
  type LoopySort,
  loopyTable,
  successRate,
} from "../lib/loopy-table.ts";
import { useLoopyRows } from "../lib/ui-data.ts";
import type { LoopyRow } from "../lib/view-models.ts";

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  show: z.enum(LOOPY_FILTERS).optional().catch(undefined),
  sort: z.enum(LOOPY_SORTS).optional().catch(undefined),
  desc: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/loopies/")({
  validateSearch: searchSchema,
  component: LoopiesPage,
});

const FILTER_LABEL = {
  all: "All",
  scheduled: "Scheduled",
  failing: "Failing",
  active: "Active",
} satisfies Record<LoopyFilter, string>;

function SortHeader(props: {
  sort: LoopySort;
  label: string;
  numeric?: boolean;
  className?: string;
}) {
  const { sort, label, numeric = false, className = "" } = props;
  const search = Route.useSearch();
  const current = (search.sort ?? "attention") === sort;
  const desc = current ? (search.desc ?? false) : false;

  return (
    <th
      scope="col"
      aria-sort={current ? (desc ? "descending" : "ascending") : "none"}
      className={`${numeric ? "num" : ""} ${className}`}
    >
      <Link
        to="."
        search={(prev) => ({ ...prev, sort, desc: current ? !desc : undefined })}
        className={`inline-flex items-center gap-1 text-muted hover:text-ink ${numeric ? "flex-row-reverse" : ""}`}
      >
        {label}
        <Icon name={current ? (desc ? "down" : "up") : "sort"} size={12} />
      </Link>
    </th>
  );
}

function ScheduleCell({ loopy }: { loopy: LoopyRow }) {
  if (loopy.schedule === null) {
    return <span className="pill pill-sm pill-outline">Manual</span>;
  }

  return <CronReading cron={loopy.schedule.cron} tz={loopy.schedule.tz} />;
}

function NextCell({ loopy, now }: { loopy: LoopyRow; now: number }) {
  const schedule = loopy.schedule;

  if (schedule === null) {
    return <span className="text-faint">None</span>;
  }

  if (schedule.nextFireAt === null) {
    return <span className="text-xs text-muted">Declared, not scheduled</span>;
  }

  return schedule.enabled ? (
    <FireTime at={schedule.nextFireAt} now={now} />
  ) : (
    <StatusPill status="paused" small />
  );
}

function LoopyRows({ rows, now }: { rows: LoopyRow[]; now: number }) {
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <SortHeader sort="name" label="Loopy" className="min-w-64" />
            <SortHeader sort="attention" label="Latest run" className="w-40" />
            <th scope="col" className="w-36">
              Last 10
            </th>
            <SortHeader sort="success" label="Success" numeric className="w-24" />
            <SortHeader sort="runs" label="Runs" numeric className="w-20" />
            <th scope="col" className="w-52">
              Schedule
            </th>
            <SortHeader sort="next" label="Next run" className="w-36" />
          </tr>
        </thead>
        <tbody>
          {rows.map((loopy) => {
            const rate = successRate(loopy.counts);
            const total = Object.values(loopy.counts).reduce((sum, count) => sum + count, 0);

            return (
              <tr key={`${loopy.workspace}:${loopy.slug}`} className="[&>td]:h-14">
                <td className="max-w-80">
                  <Link
                    to="/loopies/$slug"
                    params={{ slug: loopy.slug }}
                    className="row-link cell-main"
                  >
                    {loopy.slug}
                  </Link>
                  <span className="cell-sub">{loopy.description ?? "No description"}</span>
                </td>
                <td>
                  {loopy.lastRun ? (
                    <span className="grid justify-items-start gap-0.5">
                      <RunPill run={loopy.lastRun} small />
                      <span className="text-xs text-muted">
                        {ago(loopy.lastRun.createdAt, now)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-faint">Never run</span>
                  )}
                </td>
                <td>
                  <LastRuns runs={loopy.latestRuns} now={now} />
                </td>
                <td className="num">
                  {rate === null ? (
                    <span className="text-xs whitespace-nowrap text-faint">None finished</span>
                  ) : (
                    `${(rate * 100).toFixed(rate === 1 ? 0 : 1)}%`
                  )}
                </td>
                <td className="num">{total.toLocaleString()}</td>
                <td className="max-w-52">
                  <ScheduleCell loopy={loopy} />
                </td>
                <td>
                  <NextCell loopy={loopy} now={now} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LoopiesPage() {
  const { q = "", show = "all", sort = "attention", desc = false } = Route.useSearch();
  const navigate = Route.useNavigate();
  const loopies = useLoopyRows();
  const now = useClock();

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Loopies</h1>
          <p className="lede">Every saved loopy, its latest runs and when it fires next.</p>
        </div>
      </div>
      <section className="table-card" aria-label="Loopies">
        <Load value={loopies} pending={<Note>Loading loopies.</Note>}>
          {(data) => {
            const table = loopyTable(data, { q, show, sort, desc });

            return (
              <>
                <div className="table-bar">
                  <input
                    type="search"
                    className="field w-64 max-md:w-full"
                    placeholder="Filter by name or description"
                    aria-label="Filter loopies"
                    value={q}
                    onChange={(event) =>
                      void navigate({
                        search: (prev) => ({ ...prev, q: event.target.value || undefined }),
                        replace: true,
                      })
                    }
                  />
                  <Segmented
                    label="Show"
                    value={show}
                    options={LOOPY_FILTERS.map((value) => ({
                      value,
                      label: FILTER_LABEL[value],
                      count: table.counts[value],
                    }))}
                    onChange={(value) =>
                      void navigate({
                        search: (prev) => ({ ...prev, show: value === "all" ? undefined : value }),
                      })
                    }
                  />
                </div>
                {data.length === 0 ? (
                  <Note>
                    No loopy is saved yet. Save one with{" "}
                    <code>loopy save path/to/file.loopy.ts</code>.
                  </Note>
                ) : table.rows.length === 0 ? (
                  <Note>No loopy matches these filters.</Note>
                ) : (
                  <LoopyRows rows={table.rows} now={now} />
                )}
                <div className="table-foot">
                  Success and run counts cover every retained run.
                  <span className="ml-auto tabular-nums">
                    {table.rows.length} of {data.length}
                  </span>
                </div>
              </>
            );
          }}
        </Load>
      </section>
    </div>
  );
}
