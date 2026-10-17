import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { DaemonView } from "loopy/contract";
import type { ReactNode } from "react";
import { Countdown } from "../components/countdown.tsx";
import { isUnreachable } from "../components/daemon-indicator.tsx";
import { ErrorBanner } from "../components/error-banner.tsx";
import { useClock } from "../lib/clock.ts";
import { ago, timestamp } from "../lib/format.ts";
import { daemonQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

export const Route = createFileRoute("/daemon")({ component: DaemonPage });

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 px-2 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

function DaemonFacts({ daemon, now }: { daemon: DaemonView; now: number }) {
  return (
    <dl className="divide-y divide-line border-y border-line">
      <Fact label="Process">
        <span className="font-mono">pid {daemon.pid}</span>
      </Fact>
      <Fact label="Started">
        <time dateTime={daemon.startedAt} title={timestamp(daemon.startedAt)}>
          {ago(daemon.startedAt, now)}
        </time>
      </Fact>
      <Fact label="Concurrency">{daemon.concurrency} runs at once</Fact>
      <Fact label="Running">{daemon.running}</Fact>
      <Fact label="Next wake">
        {daemon.nextWakeAt === null ? (
          <span className="text-muted">No run is waiting on a timer.</span>
        ) : (
          <Countdown at={daemon.nextWakeAt} now={now} />
        )}
      </Fact>
    </dl>
  );
}

function NotReachable() {
  return (
    <div className="space-y-2">
      <p className="text-danger">Daemon not reachable.</p>
      <p className="text-muted">
        Start it with{" "}
        <code className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-ink">
          loopy daemon run
        </code>
        , then reload.
      </p>
    </div>
  );
}

function DaemonStatus() {
  const daemon = useQuery(daemonQuery(useBackend()));
  const now = useClock();

  if (isUnreachable(daemon.error)) {
    return <NotReachable />;
  }

  if (daemon.error) {
    return <ErrorBanner error={daemon.error} />;
  }

  return daemon.data ? (
    <DaemonFacts daemon={daemon.data} now={now} />
  ) : (
    <p className="text-muted">Asking the daemon.</p>
  );
}

function DaemonPage() {
  return (
    <section aria-labelledby="daemon-heading" className="mx-auto max-w-4xl space-y-4 px-6 py-6">
      <h1 id="daemon-heading" className="text-base font-semibold">
        Daemon
      </h1>
      <DaemonStatus />
    </section>
  );
}
