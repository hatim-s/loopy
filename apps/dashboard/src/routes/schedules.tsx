import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { LoopyView, ScheduleView } from "loopy/contract";
import { z } from "zod";
import { ErrorBanner } from "../components/error-banner.tsx";
import { ScheduleForm } from "../components/schedules/schedule-form.tsx";
import { ScheduleRow } from "../components/schedules/schedule-row.tsx";
import { useClock } from "../lib/clock.ts";
import { loopiesQuery, schedulesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

/** The loopy whose schedule form is open. */
const searchSchema = z.object({ slug: z.string().optional().catch(undefined) });

export const Route = createFileRoute("/schedules")({
  validateSearch: searchSchema,
  component: SchedulesPage,
});

const HEAD = "py-1.5 pr-4 font-normal";

function ScheduleTable({ schedules, open }: { schedules: ScheduleView[]; open?: string }) {
  const now = useClock();

  return (
    <table className="w-full table-fixed border-y border-line text-left">
      <thead className="text-xs text-muted">
        <tr className="border-b border-line">
          <th scope="col" className={`${HEAD} pl-2`}>
            Loopy
          </th>
          <th scope="col" className={`${HEAD} hidden w-32 md:table-cell`}>
            Time zone
          </th>
          <th scope="col" className={`${HEAD} w-20`}>
            Next fire
          </th>
          <th scope="col" className={`${HEAD} hidden w-48 xl:table-cell`}>
            Last fire
          </th>
          <th scope="col" className={`${HEAD} hidden w-36 lg:table-cell`}>
            Input
          </th>
          <th scope="col" className={`${HEAD} w-16`}>
            Enabled
          </th>
          <th scope="col" className="w-32 py-1.5 pr-2 text-right font-normal">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {schedules.map((schedule) => (
          <ScheduleRow
            key={`${schedule.workspace}:${schedule.slug}`}
            schedule={schedule}
            now={now}
            editing={schedule.slug === open}
          />
        ))}
      </tbody>
    </table>
  );
}

function SchedulePicker({ loopies }: { loopies: LoopyView[] }) {
  const navigate = Route.useNavigate();

  if (loopies.length === 0) {
    return null;
  }

  return (
    <select
      value=""
      aria-label="Schedule a loopy"
      onChange={(event) => void navigate({ search: { slug: event.target.value } })}
      className="h-7 rounded-md border border-line bg-panel px-2 text-[13px]"
    >
      <option value="" disabled>
        Schedule a loopy
      </option>
      {loopies.map((loopy) => (
        <option key={loopy.slug} value={loopy.slug}>
          {loopy.slug}
        </option>
      ))}
    </select>
  );
}

/** A new schedule starts from what the definition declares, else every hour in UTC. */
function NewSchedule({ loopy }: { loopy: LoopyView }) {
  const navigate = Route.useNavigate();

  return (
    <section
      aria-labelledby="new-schedule-heading"
      className="space-y-3 border-l-2 border-active py-1 pl-4"
    >
      <h2 id="new-schedule-heading" className="font-medium">
        New schedule for <span className="font-mono">{loopy.slug}</span>
      </h2>
      <ScheduleForm
        key={loopy.slug}
        slug={loopy.slug}
        draft={{
          cron: loopy.schedule?.cron ?? "@hourly",
          tz: loopy.schedule?.tz ?? "UTC",
          input: {},
          enabled: true,
        }}
        onDone={() => void navigate({ search: {} })}
      />
    </section>
  );
}

function SchedulesPage() {
  const backend = useBackend();
  const { slug } = Route.useSearch();
  const schedules = useQuery(schedulesQuery(backend));
  const loopies = useQuery(loopiesQuery(backend));
  const scheduled = new Set(schedules.data?.map((schedule) => schedule.slug));
  const unscheduled = loopies.data?.filter((loopy) => !scheduled.has(loopy.slug)) ?? [];
  const creating = schedules.data && unscheduled.find((loopy) => loopy.slug === slug);

  return (
    <section aria-labelledby="schedules-heading" className="mx-auto max-w-5xl space-y-5 px-6 py-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 id="schedules-heading" className="text-base font-semibold">
          Schedules
        </h1>
        <SchedulePicker loopies={unscheduled} />
      </header>
      {schedules.error && <ErrorBanner error={schedules.error} />}
      {creating && <NewSchedule loopy={creating} />}
      {schedules.isPending && <p className="text-muted">Loading schedules.</p>}
      {schedules.data?.length === 0 && !creating && (
        <p className="border-y border-line py-6 text-muted">No loopy runs on a schedule yet.</p>
      )}
      {schedules.data && schedules.data.length > 0 && (
        <ScheduleTable schedules={schedules.data} open={slug} />
      )}
    </section>
  );
}
