import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RunTable } from "../components/runs/run-table.tsx";
import { Load, Note } from "../components/ui/load.tsx";
import { PagerFoot } from "../components/ui/pager.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { useClock } from "../lib/clock.ts";
import { useLoopyRows, useRunPages } from "../lib/ui-data.ts";
import { PERIODS, type RunListFilters } from "../lib/view-models.ts";

/** Awaiting is a suspended run held on a hook; it reads as its own status here. */
const STATUS_TABS = ["all", "failed", "awaiting", "running", "succeeded", "cancelled"] as const;

type StatusTab = (typeof STATUS_TABS)[number];

const TAB_LABEL = {
  all: "All",
  failed: "Failed",
  awaiting: "Awaiting",
  running: "Running",
  succeeded: "Succeeded",
  cancelled: "Cancelled",
} satisfies Record<StatusTab, string>;

const PERIOD_TABS = ["all", ...PERIODS] as const;

/** Unknown values in a pasted URL fall back to the default view instead of an error page. */
const searchSchema = z.object({
  status: z.enum(STATUS_TABS).optional().catch(undefined),
  slug: z.string().optional().catch(undefined),
  period: z.enum(PERIODS).optional().catch(undefined),
});

export const Route = createFileRoute("/runs/")({
  validateSearch: searchSchema,
  component: RunsPage,
});

const PAGE_SIZE = 50;

const TAB_FILTER = {
  all: {},
  failed: { status: "failed" },
  awaiting: { status: "suspended", waiting: true },
  running: { status: "running" },
  succeeded: { status: "succeeded" },
  cancelled: { status: "cancelled" },
} satisfies Record<StatusTab, RunListFilters>;

function RunsTable({ filters }: { filters: RunListFilters }) {
  const pager = useRunPages(filters, PAGE_SIZE);
  const now = useClock();

  return (
    <Load value={pager} pending={<Note>Loading runs.</Note>}>
      {(page, fetching) => (
        <>
          {page.rows.length === 0 ? (
            <Note>No runs match these filters.</Note>
          ) : (
            <RunTable
              runs={page.rows}
              now={now}
              withLoopy={filters.slug === undefined}
              busy={fetching}
            />
          )}
          <PagerFoot pager={pager} page={page} noun="runs">
            Newest first
          </PagerFoot>
        </>
      )}
    </Load>
  );
}

function RunsPage() {
  const { status = "all", slug, period } = Route.useSearch();
  const navigate = Route.useNavigate();
  const loopies = useLoopyRows();
  const filters: RunListFilters = { ...TAB_FILTER[status], slug, period };

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="lede">Every retained run, newest first. Filters run on the daemon.</p>
        </div>
      </div>
      <section className="table-card" aria-label="Runs">
        <div className="table-bar">
          <Segmented
            label="Status"
            value={status}
            options={STATUS_TABS.map((value) => ({ value, label: TAB_LABEL[value] }))}
            onChange={(value) =>
              void navigate({
                search: (prev) => ({ ...prev, status: value === "all" ? undefined : value }),
              })
            }
          />
          <span className="flex-1" />
          <select
            className="field"
            aria-label="Loopy"
            value={slug ?? ""}
            onChange={(event) =>
              void navigate({
                search: (prev) => ({ ...prev, slug: event.target.value || undefined }),
              })
            }
          >
            <option value="">All loopies</option>
            {loopies.state === "ready" &&
              loopies.data.map((loopy) => (
                <option key={`${loopy.workspace}:${loopy.slug}`} value={loopy.slug}>
                  {loopy.slug}
                </option>
              ))}
          </select>
          <Segmented
            label="Created within"
            value={period ?? "all"}
            options={PERIOD_TABS.map((value) => ({
              value,
              label: value === "all" ? "All" : value,
            }))}
            onChange={(value) =>
              void navigate({
                search: (prev) => ({ ...prev, period: value === "all" ? undefined : value }),
              })
            }
          />
        </div>
        <RunsTable key={JSON.stringify(filters)} filters={filters} />
      </section>
    </div>
  );
}
