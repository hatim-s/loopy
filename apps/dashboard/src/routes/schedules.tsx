import { type LoopyView, routes } from "@loopy/contract";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { ErrorBanner } from "../components/error-banner";
import { ScheduleForm } from "../components/schedules/form";
import { ScheduleHead, ScheduleRow } from "../components/schedules/row";
import { Load, Note } from "../components/ui/load";
import { Segmented } from "../components/ui/segmented";
import { useClock } from "../lib/clock";
import { searchField } from "../lib/search";
import { useLoopyRows, useScheduleOverview, useSchedules } from "../lib/ui-data";

/**
 * The workspace whose schedules show, and the loopy whose form is open. A schedule belongs to
 * one workspace, so its identity is workspace plus slug.
 */
const searchSchema = Schema.Struct({
  workspace: searchField(Schema.String),
  slug: searchField(routes.putSchedule.params.fields.slug),
});

export const Route = createFileRoute("/schedules")({
  validateSearch: Schema.decodeUnknownSync(searchSchema),
  component: SchedulesPage,
});

const SHOW = ["all", "active", "paused"] as const;

type Show = (typeof SHOW)[number];

const SHOW_LABEL = { all: "All", active: "Active", paused: "Paused" } satisfies Record<
  Show,
  string
>;

/** A new schedule starts from what the definition declares, else every hour in UTC. */
function NewSchedule({ loopy }: { loopy: LoopyView }) {
  const navigate = Route.useNavigate();

  return (
    <section aria-label={`New schedule for ${loopy.slug}`} className="panel p-4">
      <h2 className="mb-3">
        New schedule for <code className="text-sm">{loopy.slug}</code>
      </h2>
      <ScheduleForm
        key={`${loopy.workspace}:${loopy.slug}`}
        slug={loopy.slug}
        workspace={loopy.workspace}
        draft={{
          cron: loopy.schedule?.cron ?? "@hourly",
          tz: loopy.schedule?.tz ?? "UTC",
          input: {},
          enabled: true,
        }}
        onDone={() => void navigate({ search: { workspace: loopy.workspace } })}
      />
    </section>
  );
}

function SchedulesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const loopies = useLoopyRows();
  const overview = useScheduleOverview();

  const loopyWorkspaces =
    loopies.state === "ready" ? [...new Set(loopies.data.map((loopy) => loopy.workspace))] : [];

  const scheduleWorkspaces = overview.state === "ready" ? overview.data.workspaces : [];

  // Without a workspace in the URL, wait for both reads, then open one that has schedules.
  const settled = loopies.state !== "loading" && overview.state !== "loading";

  const workspace =
    search.workspace ?? (settled ? (scheduleWorkspaces[0] ?? loopyWorkspaces[0] ?? null) : null);

  const choices = [
    ...new Set([...loopyWorkspaces, ...scheduleWorkspaces, ...(workspace ? [workspace] : [])]),
  ];

  const schedules = useSchedules(workspace);
  const scoped = useLoopyRows(workspace ?? undefined);
  const now = useClock();
  const [show, setShow] = useState<Show>("all");
  const slug = search.slug;

  // Until both reads answer, a scheduled slug could look unscheduled, so nothing is offered.
  const unscheduled =
    scoped.state === "ready" && schedules.state === "ready"
      ? scoped.data.filter(
          (loopy) =>
            loopy.workspace === workspace &&
            !schedules.data.some((schedule) => schedule.slug === loopy.slug),
        )
      : [];

  // A null workspace skips the schedule read, which stays loading; that case has its own note.
  const pending =
    workspace !== null && (scoped.state === "loading" || schedules.state === "loading");

  const creating = unscheduled.find((loopy) => loopy.slug === slug);

  return (
    <div className="content space-y-4">
      <div className="page-head mb-1">
        <div>
          <h1>Schedules</h1>
          <p className="lede">
            Cron schedules, when each fires next, and the input each fire sends.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {workspace !== null && choices.length > 1 && (
            <select
              className="field max-w-80"
              value={workspace}
              aria-label="Workspace"
              title={workspace}
              onChange={(event) => void navigate({ search: { workspace: event.target.value } })}
            >
              {choices.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          )}
          {pending && (
            <select className="field" value="" aria-label="Schedule a loopy" disabled>
              <option value="">Loading loopies</option>
            </select>
          )}
          {unscheduled.length > 0 && (
            <select
              className="field"
              value=""
              aria-label="Schedule a loopy"
              onChange={(event) =>
                void navigate({
                  search: { workspace: workspace ?? undefined, slug: event.target.value },
                })
              }
            >
              <option value="" disabled>
                Schedule a loopy
              </option>
              {unscheduled.map((loopy) => (
                <option key={`${loopy.workspace}:${loopy.slug}`} value={loopy.slug}>
                  {loopy.slug}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {scoped.state === "error" && <ErrorBanner error={scoped.error} />}
      {creating && <NewSchedule loopy={creating} />}
      <section className="table-card" aria-label="Schedules">
        {workspace === null ? (
          // Until both reads answer there is no workspace to list; after that, none means none saved.
          settled ? (
            <Load value={loopies} pending={<Note>Loading schedules.</Note>}>
              {() => (
                <Note>
                  No loopy is saved yet. Save one with <code>loopy save path/to/file.loopy.ts</code>
                  , then schedule it here.
                </Note>
              )}
            </Load>
          ) : (
            <Note>Loading schedules.</Note>
          )
        ) : (
          <Load value={schedules} pending={<Note>Loading schedules.</Note>}>
            {(data) => {
              const active = data.filter((schedule) => schedule.enabled).length;

              const rows = data
                .filter((schedule) => show === "all" || schedule.enabled === (show === "active"))
                .sort(
                  (a, b) =>
                    Number(b.enabled) - Number(a.enabled) ||
                    a.nextFireAt.localeCompare(b.nextFireAt),
                );

              return (
                <>
                  <div className="table-bar">
                    <Segmented
                      label="Show"
                      value={show}
                      options={SHOW.map((value) => ({
                        value,
                        label: SHOW_LABEL[value],
                        count:
                          value === "all"
                            ? data.length
                            : value === "active"
                              ? active
                              : data.length - active,
                      }))}
                      onChange={setShow}
                    />
                  </div>
                  {rows.length === 0 ? (
                    <Note>
                      {data.length > 0
                        ? "No schedule matches."
                        : unscheduled.length > 0
                          ? "No loopy runs on a schedule yet. Pick one above to add a schedule."
                          : scoped.state === "ready"
                            ? "No loopy runs on a schedule yet, and this workspace has no saved loopy to schedule."
                            : "No loopy runs on a schedule yet."}
                    </Note>
                  ) : (
                    <div className="table-scroll">
                      <table className="data">
                        <ScheduleHead />
                        <tbody>
                          {rows.map((schedule) => (
                            <ScheduleRow
                              key={`${schedule.workspace}:${schedule.slug}`}
                              schedule={schedule}
                              now={now}
                              editing={schedule.slug === slug}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              );
            }}
          </Load>
        )}
      </section>
    </div>
  );
}
