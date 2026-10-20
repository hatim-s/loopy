import type { NodeRunView, RunStatus, StepRecord } from "loopy/contract";

type Status = RunStatus | StepRecord["status"] | NodeRunView["status"];

const TONE = {
  queued: "text-active",
  running: "text-active",
  suspended: "text-attention",
  waiting: "text-attention",
  sleeping: "text-attention",
  retrying: "text-attention",
  rate_limited: "text-attention",
  succeeded: "text-success",
  failed: "text-danger",
  cancelled: "text-neutral",
  skipped: "text-neutral",
} satisfies Record<Status, string>;

/** Statuses where work is in flight; their dot pulses so motion means "still going". */
const LIVE = new Set<Status>(["running", "retrying"]);

export function statusTone(status: Status): string {
  return TONE[status];
}

function dotFill(status: Status): string {
  // Queued has not started, so it draws as an empty ring instead of a filled dot.
  if (status === "queued") {
    return "ring-[1.5px] ring-current ring-inset";
  }

  return LIVE.has(status) ? "bg-current motion-safe:animate-pulse" : "bg-current";
}

export function StatusDot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${TONE[status]} ${dotFill(status)}`}
    />
  );
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${TONE[status]}`}>
      <StatusDot status={status} />
      {status.replace("_", " ")}
    </span>
  );
}
