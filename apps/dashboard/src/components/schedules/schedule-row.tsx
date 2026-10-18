import { Link, useNavigate } from "@tanstack/react-router";
import type { ScheduleView } from "loopy/contract";
import { useState } from "react";
import { describeCron } from "../../lib/cron.ts";
import { useRemoveSchedule, useToggleSchedule } from "../../lib/mutations.ts";
import { Button } from "../button.tsx";
import { Countdown } from "../countdown.tsx";
import { ResolveError } from "../resolve-form.tsx";
import { ScheduleForm } from "./schedule-form.tsx";

export const SCHEDULE_COLUMNS = 7;

type Toggle = ReturnType<typeof useToggleSchedule>;

type Remove = ReturnType<typeof useRemoveSchedule>;

function EnabledSwitch({ schedule, toggle }: { schedule: ScheduleView; toggle: Toggle }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={schedule.enabled}
      aria-label={`Enabled, ${schedule.slug}`}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!schedule.enabled)}
      className="group relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-line bg-raised transition-colors aria-checked:border-success aria-checked:bg-success/25 disabled:opacity-60"
    >
      <span className="ml-0.5 size-2.5 rounded-full bg-muted transition-transform group-aria-checked:translate-x-3 group-aria-checked:bg-success motion-reduce:transition-none" />
    </button>
  );
}

/** The first click arms the button; the second removes. Leaving it disarms. */
function RemoveButton({ remove }: { remove: Remove }) {
  const [armed, setArmed] = useState(false);

  return (
    <Button
      disabled={remove.isPending}
      onBlur={() => setArmed(false)}
      onClick={() => (armed ? remove.mutate() : setArmed(true))}
      className={armed ? "border-danger text-danger" : ""}
    >
      {armed ? "Remove?" : "Remove"}
    </Button>
  );
}

function NextFire({ schedule, now }: { schedule: ScheduleView; now: number }) {
  return schedule.enabled ? (
    <Countdown at={schedule.nextFireAt} now={now} />
  ) : (
    <span className="text-muted">Paused</span>
  );
}

function InputSummary({ input }: { input: ScheduleView["input"] }) {
  const text = JSON.stringify(input);

  return text === "{}" ? (
    <span className="text-muted">No input</span>
  ) : (
    <span className="block truncate font-mono" title={JSON.stringify(input, null, 2)}>
      {text}
    </span>
  );
}

export function ScheduleRow({
  schedule,
  now,
  editing,
}: {
  schedule: ScheduleView;
  now: number;
  editing: boolean;
}) {
  const reading = describeCron(schedule.cron);
  const toggle = useToggleSchedule(schedule.slug, schedule.workspace);
  const remove = useRemoveSchedule(schedule.slug, schedule.workspace);
  const error = toggle.error ?? remove.error;

  return (
    <>
      <tr className="align-baseline max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-4 max-md:px-2 max-md:py-2">
        <td className="max-w-0 py-2 pr-4 pl-2 max-md:max-w-none max-md:basis-full max-md:p-0 max-md:pb-1.5">
          <Link
            to="/loopies/$slug"
            params={{ slug: schedule.slug }}
            className="block truncate font-medium underline-offset-2 hover:underline"
          >
            {schedule.slug}
          </Link>
          <span className="block truncate text-xs text-muted max-md:whitespace-normal">
            <code className="mr-2 font-mono text-ink">{schedule.cron}</code>
            {reading && <span className="mr-2 md:hidden lg:inline">{reading}</span>}
            <span className="font-mono md:hidden">{schedule.tz}</span>
          </span>
        </td>
        <td className="hidden truncate py-2 pr-4 font-mono text-xs md:table-cell">{schedule.tz}</td>
        <td className="py-2 pr-4 text-xs whitespace-nowrap max-md:p-0">
          <NextFire schedule={schedule} now={now} />
        </td>
        <td className="hidden max-w-0 py-2 pr-4 text-xs xl:table-cell">
          {schedule.lastFireKey === null ? (
            <span className="text-muted">Never fired</span>
          ) : (
            <span className="block truncate font-mono" title={schedule.lastFireKey}>
              {schedule.lastFireKey}
            </span>
          )}
        </td>
        <td className="hidden max-w-0 py-2 pr-4 text-xs lg:table-cell">
          <InputSummary input={schedule.input} />
        </td>
        <td className="py-2 pr-4 max-md:flex max-md:p-0">
          <EnabledSwitch schedule={schedule} toggle={toggle} />
        </td>
        <td className="py-2 pr-2 max-md:ml-auto max-md:p-0">
          <span className="flex justify-end gap-1.5">
            <Link
              to="/schedules"
              search={
                editing
                  ? { workspace: schedule.workspace }
                  : { slug: schedule.slug, workspace: schedule.workspace }
              }
              className="inline-flex h-7 items-center rounded-md border border-line bg-panel px-2.5 text-[13px] font-medium hover:bg-raised"
              aria-expanded={editing}
            >
              {editing ? "Close" : "Edit"}
            </Link>
            <RemoveButton remove={remove} />
          </span>
        </td>
      </tr>
      {error && (
        <tr className="max-md:block">
          <td colSpan={SCHEDULE_COLUMNS} className="px-2 pb-2 max-md:block">
            <ResolveError error={error} />
          </td>
        </tr>
      )}
      {editing && <EditRow schedule={schedule} />}
    </>
  );
}

function EditRow({ schedule }: { schedule: ScheduleView }) {
  const navigate = useNavigate();

  return (
    <tr className="max-md:block">
      <td colSpan={SCHEDULE_COLUMNS} className="bg-raised/50 px-2 py-3 max-md:block">
        <ScheduleForm
          slug={schedule.slug}
          workspace={schedule.workspace}
          draft={schedule}
          onDone={() =>
            void navigate({ to: "/schedules", search: { workspace: schedule.workspace } })
          }
        />
      </td>
    </tr>
  );
}
