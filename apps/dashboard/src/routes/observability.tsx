import { createFileRoute } from "@tanstack/react-router";
import { runStatusSchema } from "loopy/contract";
import { useState } from "react";
import { z } from "zod";
import { EventDrawer, EventTable } from "../components/observability/event-table.tsx";
import { LogTable } from "../components/observability/log-table.tsx";
import { Load, Note } from "../components/ui/load.tsx";
import { PagerFoot, ScanNote } from "../components/ui/pager.tsx";
import { Segmented } from "../components/ui/segmented.tsx";
import { useEventPages, useLogPages, useLoopyRows } from "../lib/ui-data.ts";
import {
  type EventFilters,
  LOG_LEVELS,
  type LogFilters,
  PERIODS,
  type Period,
} from "../lib/view-models.ts";

const ENTITIES = ["run", "node", "step", "log", "hook", "schedule"] as const;

const RUN_STATUSES = runStatusSchema.options;

/** Suspended covers runs held on a hook and runs sleeping on a timer. */
const STATUS_LABEL = {
  queued: "Queued",
  running: "Running",
  suspended: "Suspended or awaiting",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
} satisfies Record<(typeof RUN_STATUSES)[number], string>;

/**
 * One URL search object for both tabs, so a filter set in Logs still applies in Runtime
 * events. Unknown values in a pasted URL fall back to defaults instead of an error page.
 */
const searchSchema = z.object({
  tab: z.enum(["logs", "events"]).optional().catch(undefined),
  period: z.enum(PERIODS).optional().catch(undefined),
  slug: z.string().optional().catch(undefined),
  runId: z.string().optional().catch(undefined),
  nodeId: z.string().optional().catch(undefined),
  status: runStatusSchema.optional().catch(undefined),
  level: z.enum(LOG_LEVELS).optional().catch(undefined),
  text: z.string().optional().catch(undefined),
  entity: z.enum(ENTITIES).optional().catch(undefined),
  kind: z.string().optional().catch(undefined),
  txn: z.string().optional().catch(undefined),
  event: z.number().int().optional().catch(undefined),
});

export const Route = createFileRoute("/observability")({
  validateSearch: searchSchema,
  component: ObservabilityPage,
});

type Search = z.infer<typeof searchSchema>;

function Logs({ filters }: { filters: LogFilters }) {
  const pager = useLogPages(filters);

  return (
    <Load value={pager} pending={<Note>Loading logs.</Note>}>
      {(page, fetching) => (
        <>
          {page.rows.length === 0 ? (
            <Note>No log line matches these filters on this page.</Note>
          ) : (
            <LogTable rows={page.rows} busy={fetching} withRun={filters.runId === undefined} />
          )}
          <PagerFoot pager={pager} page={page} noun="lines">
            <ScanNote scan={page} noun="lines" />
          </PagerFoot>
        </>
      )}
    </Load>
  );
}

function Events({
  filters,
  open,
  onOpen,
  onFilter,
}: {
  filters: EventFilters;
  open: number | null;
  onOpen: (sequence: number | null) => void;
  onFilter: (patch: Partial<Search>) => void;
}) {
  const pager = useEventPages(filters);

  return (
    <Load value={pager} pending={<Note>Loading events.</Note>}>
      {(page, fetching) => {
        const row = page.rows.find((event) => event.sequence === open);

        return (
          <div className={row ? "grid xl:grid-cols-[minmax(0,1fr)_400px]" : ""}>
            <div className="min-w-0">
              {page.rows.length === 0 ? (
                <Note>No event matches these filters on this page.</Note>
              ) : (
                <EventTable rows={page.rows} busy={fetching} open={open} onOpen={onOpen} />
              )}
              <PagerFoot pager={pager} page={page} noun="events">
                <ScanNote scan={page} noun="events" />
              </PagerFoot>
            </div>
            {row && (
              <div className="border-line xl:border-l">
                <EventDrawer
                  row={row}
                  onClose={() => onOpen(null)}
                  onSameTxn={(txn) => onFilter({ txn, event: undefined })}
                  onRunEvents={(runId) => onFilter({ runId, event: undefined })}
                />
              </div>
            )}
          </div>
        );
      }}
    </Load>
  );
}

function TextFilter(props: {
  label: string;
  value: string | undefined;
  onCommit: (value: string | undefined) => void;
  mono?: boolean;
  width: string;
}) {
  const { label, value, onCommit, mono = false, width } = props;
  const [draft, setDraft] = useState(value ?? "");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onCommit(draft.trim() || undefined);
      }}
    >
      <input
        type="search"
        className={`field ${mono ? "field-mono" : ""} ${width}`}
        placeholder={label}
        aria-label={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft.trim() || undefined)}
      />
    </form>
  );
}

function ObservabilityPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const loopies = useLoopyRows();
  const [tail, setTail] = useState(true);
  const tab = search.tab ?? "logs";
  const period: Period = search.period ?? "24h";

  const set = (patch: Partial<Search>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  const shared = {
    period,
    slug: search.slug,
    runId: search.runId,
    nodeId: search.nodeId,
    status: search.status,
  };

  const logFilters: LogFilters = {
    ...shared,
    level: search.level,
    text: search.text,
    tail,
  };

  const eventFilters: EventFilters = {
    ...shared,
    entity: search.entity,
    kind: search.kind,
    txn: search.txn,
  };

  return (
    <div className="content space-y-4">
      <div className="page-head mb-1">
        <div>
          <h1>Logs and events</h1>
          <p className="lede">
            Log lines from every run, and the daemon's runtime events in commit order. Filters apply
            to both tabs; details load when a row opens.
          </p>
        </div>
      </div>
      <div role="tablist" aria-label="Feed" className="tabs">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "logs"}
          onClick={() => set({ tab: undefined })}
        >
          Logs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "events"}
          onClick={() => set({ tab: "events" })}
        >
          Runtime events
        </button>
      </div>
      <section className="table-card" aria-label={tab === "logs" ? "Logs" : "Runtime events"}>
        <div className="table-bar">
          <select
            className="field"
            aria-label="Loopy"
            value={search.slug ?? ""}
            onChange={(event) => set({ slug: event.target.value || undefined })}
          >
            <option value="">All loopies</option>
            {loopies.state === "ready" &&
              loopies.data.map((loopy) => (
                <option key={`${loopy.workspace}:${loopy.slug}`} value={loopy.slug}>
                  {loopy.slug}
                </option>
              ))}
          </select>
          <select
            className="field"
            aria-label="Run status"
            value={search.status ?? ""}
            onChange={(event) =>
              set({ status: RUN_STATUSES.find((status) => status === event.target.value) })
            }
          >
            <option value="">Any run status</option>
            {RUN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
          <TextFilter
            key={`run:${search.runId}`}
            label="Run id"
            value={search.runId}
            mono
            width="w-40"
            onCommit={(runId) => set({ runId })}
          />
          <TextFilter
            key={`node:${search.nodeId}`}
            label="Node id"
            value={search.nodeId}
            mono
            width="w-36"
            onCommit={(nodeId) => set({ nodeId })}
          />
          {tab === "logs" ? (
            <>
              <Segmented
                label="Level"
                value={search.level ?? "all"}
                options={[
                  { value: "all", label: "All" },
                  ...LOG_LEVELS.map((level) => ({
                    value: level,
                    label: level[0]?.toUpperCase() + level.slice(1),
                  })),
                ]}
                onChange={(level) => set({ level: level === "all" ? undefined : level })}
              />
              <TextFilter
                key={`text:${search.text}`}
                label="Search messages"
                value={search.text}
                width="w-56"
                onCommit={(text) => set({ text })}
              />
            </>
          ) : (
            <>
              <select
                className="field"
                aria-label="Entity"
                value={search.entity ?? ""}
                onChange={(event) =>
                  set({ entity: ENTITIES.find((entity) => entity === event.target.value) })
                }
              >
                <option value="">Any entity</option>
                {ENTITIES.map((entity) => (
                  <option key={entity} value={entity}>
                    {entity}
                  </option>
                ))}
              </select>
              <TextFilter
                key={`kind:${search.kind}`}
                label="Event kind"
                value={search.kind}
                mono
                width="w-40"
                onCommit={(kind) => set({ kind })}
              />
              {search.txn && (
                <button
                  type="button"
                  className="pill pill-outline cursor-pointer"
                  onClick={() => set({ txn: undefined })}
                >
                  Transaction {search.txn.slice(0, 8)} <span aria-hidden="true">×</span>
                  <span className="sr-only">, clear</span>
                </button>
              )}
            </>
          )}
          <span className="flex-1" />
          <Segmented
            label="Window"
            value={period}
            options={PERIODS.map((value) => ({ value, label: value }))}
            onChange={(value) => set({ period: value === "24h" ? undefined : value })}
          />
          {tab === "logs" && (
            <label className="flex items-center gap-2 text-xs text-muted">
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={tail}
                onClick={() => setTail(!tail)}
              >
                <span />
              </button>
              Follow new lines
            </label>
          )}
        </div>
        {tab === "logs" ? (
          <Logs key={JSON.stringify(logFilters)} filters={logFilters} />
        ) : (
          <Events
            key={JSON.stringify(eventFilters)}
            filters={eventFilters}
            open={search.event ?? null}
            onOpen={(event) => set({ event: event ?? undefined })}
            onFilter={set}
          />
        )}
      </section>
    </div>
  );
}
