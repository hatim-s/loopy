import { Link, useNavigate } from "@tanstack/react-router";
import type { ScheduleView } from "loopy/contract";
import { useState } from "react";
import { useRemoveSchedule, useToggleSchedule } from "../../lib/mutations.ts";
import { Button } from "../button.tsx";
import { ResolveError } from "../resolve-form.tsx";
import { StatusPill } from "../ui/status.tsx";
import { ScheduleForm } from "./schedule-form.tsx";
import { CronReading, FireTime } from "./schedule-text.tsx";

export const SCHEDULE_COLUMNS = 7;

type Remove = ReturnType<typeof useRemoveSchedule>;

/** The first click arms the button; the second removes. Leaving it disarms. */
function RemoveButton({ remove }: { remove: Remove }) {
  const [armed, setArmed] = useState(false);

  return (
    <Button
      small
      variant={armed ? "danger" : "plain"}
      disabled={remove.isPending}
      onBlur={() => setArmed(false)}
      onClick={() => (armed ? remove.mutate() : setArmed(true))}
    >
      {armed ? "Remove?" : "Remove"}
    </Button>
  );
}

function InputSummary({ input }: { input: ScheduleView["input"] }) {
  const text = JSON.stringify(input);

  return text === "{}" ? (
    <span className="text-faint">No input</span>
  ) : (
    <code className="block truncate" title={JSON.stringify(input, null, 2)}>
      {text}
    </code>
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
  const toggle = useToggleSchedule(schedule.slug, schedule.workspace);
  const remove = useRemoveSchedule(schedule.slug, schedule.workspace);
  const error = toggle.error ?? remove.error;

  return (
    <>
      <tr aria-selected={editing} className="[&>td]:h-14">
        <td className="max-w-56">
          <Link
            to="/loopies/$slug"
            params={{ slug: schedule.slug }}
            className="cell-main text-ink hover:text-active"
          >
            {schedule.slug}
          </Link>
          <span className="cell-sub font-mono">{schedule.tz}</span>
        </td>
        <td className="max-w-56">
          <CronReading cron={schedule.cron} tz={schedule.tz} />
        </td>
        <td>
          {schedule.enabled ? (
            <FireTime at={schedule.nextFireAt} now={now} />
          ) : (
            <span className="text-faint">Paused</span>
          )}
        </td>
        <td className="max-w-48">
          {schedule.lastFireKey === null ? (
            <span className="text-faint">Never fired</span>
          ) : (
            <code className="block truncate" title={schedule.lastFireKey}>
              {schedule.lastFireKey}
            </code>
          )}
        </td>
        <td className="max-w-48">
          <InputSummary input={schedule.input} />
        </td>
        <td>
          <span className="flex items-center gap-2.5">
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={schedule.enabled}
              aria-label={`${schedule.enabled ? "Pause" : "Resume"} ${schedule.slug}`}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(!schedule.enabled)}
            >
              <span />
            </button>
            <StatusPill status={schedule.enabled ? "active" : "paused"} small />
          </span>
        </td>
        <td>
          <span className="flex justify-end gap-1.5">
            <Link
              to="/schedules"
              search={
                editing
                  ? { workspace: schedule.workspace }
                  : { workspace: schedule.workspace, slug: schedule.slug }
              }
              className="btn btn-sm"
              aria-expanded={editing}
            >
              {editing ? "Close" : "Edit"}
            </Link>
            <RemoveButton remove={remove} />
          </span>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={SCHEDULE_COLUMNS}>
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
    <tr className="hover:bg-transparent">
      <td colSpan={SCHEDULE_COLUMNS} className="bg-sunken py-4">
        <div className="max-w-3xl">
          <ScheduleForm
            slug={schedule.slug}
            workspace={schedule.workspace}
            draft={schedule}
            onDone={() =>
              void navigate({ to: "/schedules", search: { workspace: schedule.workspace } })
            }
          />
        </div>
      </td>
    </tr>
  );
}
