import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LoopyView, RunStatus } from "loopy/contract";
import type { ReactNode } from "react";
import { waitingCount } from "../../lib/inbox.ts";
import { nextFire, totalCounts } from "../../lib/overview.ts";
import { daemonQuery, inboxQuery } from "../../lib/queries.ts";
import { useBackend } from "../../router-context.ts";
import { Countdown } from "../countdown.tsx";
import { isUnreachable } from "../daemon-indicator.tsx";
import { statusTone } from "../status-badge.tsx";

const CELL =
  "flex min-w-0 flex-col justify-between gap-1 bg-panel px-3.5 py-2.5 -outline-offset-2 hover:bg-sunken";

function Figure({
  value,
  tone = "",
  children,
}: {
  value: ReactNode;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <>
      <span className="truncate text-xs text-muted">{children}</span>
      <span className={`truncate font-mono text-lg leading-6 tabular-nums ${tone}`}>{value}</span>
    </>
  );
}

/** A count that filters the run history below to its status. */
function StatusCell({ status, count, label }: { status: RunStatus; count: number; label: string }) {
  return (
    <Link
      from="/"
      to="/"
      search={(previous) => ({ ...previous, status })}
      hash="runs"
      className={CELL}
    >
      <Figure value={count} tone={count > 0 ? statusTone(status) : "text-faint"}>
        {label}
      </Figure>
    </Link>
  );
}

const LOADING = <span className="text-faint">-</span>;

const FAILED = <span className="text-danger">error</span>;

function SlotsCell() {
  const daemon = useQuery(daemonQuery(useBackend()));
  let value = LOADING;

  if (isUnreachable(daemon.error)) {
    value = <span className="text-danger">offline</span>;
  } else if (daemon.error) {
    value = FAILED;
  } else if (daemon.data) {
    value = (
      <>
        <span className={daemon.data.running > 0 ? "text-active" : ""}>{daemon.data.running}</span>
        <span className="text-faint">/{daemon.data.concurrency}</span>
      </>
    );
  }

  return (
    <Link to="/daemon" title={daemon.error?.message} className={CELL}>
      <Figure value={value}>Slots in use</Figure>
    </Link>
  );
}

function WaitingCell() {
  const inbox = useQuery(inboxQuery(useBackend()));
  const count = inbox.data ? waitingCount(inbox.data) : 0;
  let value = LOADING;

  if (inbox.error) {
    value = FAILED;
  } else if (inbox.data) {
    value = <span className={count > 0 ? "text-attention" : "text-faint"}>{count}</span>;
  }

  return (
    <Link to="/inbox" title={inbox.error?.message} className={CELL}>
      <Figure value={value}>In inbox</Figure>
    </Link>
  );
}

function NextFireCell({ loopies, now }: { loopies: LoopyView[]; now: number }) {
  const next = nextFire(loopies);

  return (
    <Link to="/schedules" className={`${CELL} col-span-2`}>
      <Figure
        value={next ? <Countdown at={next.at} now={now} /> : "none"}
        tone={next ? "" : "text-faint"}
      >
        {next ? (
          <>
            Next fire, <span className="text-ink">{next.slug}</span>
          </>
        ) : (
          "No enabled schedule"
        )}
      </Figure>
    </Link>
  );
}

/**
 * The whole system in one row. Every cell is real data and links to where it is acted on. The
 * status cells sum `LoopyView.counts`, so they cover saved loopies only; the caller says so.
 */
export function SummaryStrip({ loopies, now }: { loopies: LoopyView[]; now: number }) {
  const counts = totalCounts(loopies);

  return (
    <nav
      aria-label="System summary"
      className="panel grid grid-cols-2 gap-px bg-line sm:grid-cols-4 2xl:grid-cols-8"
    >
      <SlotsCell />
      <StatusCell status="queued" count={counts.queued} label="Queued" />
      <WaitingCell />
      <StatusCell status="suspended" count={counts.suspended} label="Suspended" />
      <StatusCell status="failed" count={counts.failed} label="Failed" />
      <StatusCell status="succeeded" count={counts.succeeded} label="Succeeded" />
      <NextFireCell loopies={loopies} now={now} />
    </nav>
  );
}
