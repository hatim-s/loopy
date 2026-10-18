import type { RunView } from "loopy/contract";
import type { ReactNode } from "react";
import { timestamp } from "../lib/format.ts";
import { Countdown } from "./countdown.tsx";
import { RunActions } from "./run-actions.tsx";
import { StatusBadge } from "./status-badge.tsx";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

function Owner({ run }: { run: RunView }) {
  if (run.owner === null) {
    return <span className="text-muted">none</span>;
  }

  return (
    <span title={`Last heartbeat ${timestamp(run.owner.heartbeatAt)}`}>
      {run.owner.host} <span className="font-mono text-xs text-muted">pid {run.owner.pid}</span>
      {run.ownerStale && (
        <span
          className="ml-2 text-danger"
          title="No heartbeat within the lease. Another worker may claim the run."
        >
          stale
        </span>
      )}
    </span>
  );
}

export function RunHeader({ run, now }: { run: RunView; now: number }) {
  return (
    <header className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{run.slug}</h1>
            <StatusBadge status={run.status} />
          </div>
          <p className="font-mono text-xs break-all text-muted">{run.id}</p>
        </div>
        <RunActions run={run} />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Fact label="Owner">
          <Owner run={run} />
        </Fact>
        <Fact label={run.status === "suspended" ? "Wakes" : "Workspace"}>
          {run.status === "suspended" && run.wakeAt !== null ? (
            <Countdown at={run.wakeAt} now={now} />
          ) : (
            <span title={run.runDirectory}>{run.runDirectory}</span>
          )}
        </Fact>
        <Fact label="Created">
          <time dateTime={run.createdAt}>{timestamp(run.createdAt)}</time>
        </Fact>
        <Fact label="Updated">
          <time dateTime={run.updatedAt}>{timestamp(run.updatedAt)}</time>
        </Fact>
      </dl>
    </header>
  );
}
