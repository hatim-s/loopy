import { Link } from "@tanstack/react-router";
import { isTerminalRun, type RunView } from "loopy/contract";
import type { ReactNode } from "react";
import { timestamp } from "../lib/format.ts";
import { Countdown } from "./countdown.tsx";
import { RunActions } from "./run-actions.tsx";
import { RunDuration } from "./run-list.tsx";
import { StatusBadge } from "./status-badge.tsx";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
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

/** The run panel's title: which loopy, which run, its status and what you can do about it. */
export function RunTitle({ run }: { run: RunView }) {
  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <p className="text-xs text-muted">
          <Link
            to="/loopies/$slug"
            params={{ slug: run.slug }}
            className="hover:text-ink hover:underline"
          >
            {run.slug}
          </Link>
        </p>
        <h1
          className="truncate font-mono text-[15px] leading-tight font-medium tracking-tight"
          title={run.id}
        >
          {run.id}
        </h1>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge status={run.status} />
        <RunActions run={run} />
      </div>
    </div>
  );
}

export function RunFacts({ run, now }: { run: RunView; now: number }) {
  return (
    <dl className="space-y-1.5">
      <Fact label="Owner">
        <Owner run={run} />
      </Fact>
      {run.status === "suspended" && run.wakeAt !== null && (
        <Fact label="Wakes">
          <Countdown at={run.wakeAt} now={now} />
        </Fact>
      )}
      <Fact label="Workspace">
        <span title={run.workspace} className="font-mono text-xs">
          {run.workspace}
        </span>
      </Fact>
      <Fact label="Created">
        <time dateTime={run.createdAt}>{timestamp(run.createdAt)}</time>
      </Fact>
      <Fact label="Updated">
        <time dateTime={run.updatedAt}>{timestamp(run.updatedAt)}</time>
      </Fact>
      {(run.status === "running" || isTerminalRun(run.status)) && (
        <Fact label="Duration">
          <span className="font-mono text-xs">
            <RunDuration run={run} now={now} />
          </span>
        </Fact>
      )}
    </dl>
  );
}
