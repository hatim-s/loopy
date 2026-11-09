import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { LoopySelect } from "../components/loopy-select";
import { RunTable } from "../components/runs/run-table";
import { Load, Note } from "../components/ui/load";
import { PagerFoot } from "../components/ui/pager";
import { Segmented } from "../components/ui/segmented";
import { useClock } from "../lib/clock";
import { useRunPages } from "../lib/pages";
import { PERIODS } from "../lib/period";
import { searchField } from "../lib/search";
import { statusWord } from "../lib/status";
import type { RunListFilters } from "../lib/view-models";

/** Awaiting is a suspended run held on a hook; it reads as its own status here. */
const STATUS_TABS = ["all", "failed", "awaiting", "running", "succeeded", "cancelled"] as const;

type StatusTab = (typeof STATUS_TABS)[number];

const PERIOD_TABS = ["all", ...PERIODS] as const;

/** Unknown values in a pasted URL fall back to the default view instead of an error page. */
const searchSchema = Schema.Struct({
  status: searchField(Schema.Literals(STATUS_TABS)),
  slug: searchField(Schema.String),
  period: searchField(Schema.Literals(PERIODS)),
});

export const Route = createFileRoute("/runs/")({
  validateSearch: Schema.decodeUnknownSync(searchSchema),
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
          <PagerFoot pager={pager} noun="runs">
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
            options={STATUS_TABS.map((value) => ({
              value,
              label: value === "all" ? "All" : statusWord(value),
            }))}
            onChange={(value) =>
              void navigate({
                search: (prev) => ({ ...prev, status: value === "all" ? undefined : value }),
              })
            }
          />
          <span className="flex-1" />
          <LoopySelect
            value={slug}
            onChange={(next) => void navigate({ search: (prev) => ({ ...prev, slug: next }) })}
          />
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
        <RunsTable filters={filters} />
      </section>
    </div>
  );
}
