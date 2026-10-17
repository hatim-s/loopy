import type { RunStatus, StepRecord } from "loopy/contract";

type Status = RunStatus | StepRecord["status"];

const TONE = {
  queued: "text-active",
  running: "text-active",
  suspended: "text-attention",
  waiting: "text-attention",
  sleeping: "text-attention",
  retrying: "text-attention",
  succeeded: "text-success",
  failed: "text-danger",
  cancelled: "text-muted",
} satisfies Record<Status, string>;

export function statusTone(status: Status): string {
  return TONE[status];
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${TONE[status]}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
