import type { ScheduleView } from "@loopy/contract";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useRemoveSchedule, useToggleSchedule } from "../../lib/mutations";
import { Button } from "../button";
import { CodedError } from "../error-banner";
import { StatusPill } from "../ui/status";
import { ScheduleForm } from "./form";
import { CronReading, FireTime } from "./text";

const COLUMNS = [
  { label: "Loopy" },
  { label: "Schedule" },
  { label: "Next fire", className: "w-36" },
  { label: "Last fire" },
  { label: "Input" },
  { label: "State", className: "w-36" },
  { label: "Actions", className: "w-40", hidden: true },
] satisfies { label: string; className?: string; hidden?: true }[];

export function ScheduleHead() {
  return (
    <thead>
      <tr>
        {COLUMNS.map((column) => (
          <th key={column.label} scope="col" className={column.className}>
            {"hidden" in column ? <span className="sr-only">{column.label}</span> : column.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

type Remove = ReturnType<typeof useRemoveSchedule>;

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
            search={{ workspace: schedule.workspace }}
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
          <td colSpan={COLUMNS.length}>
            <CodedError error={error} />
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
      <td colSpan={COLUMNS.length} className="bg-sunken py-4">
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
