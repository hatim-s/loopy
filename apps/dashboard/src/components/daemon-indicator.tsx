import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BackendError } from "../backend/backend.ts";
import { daemonQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

export function isUnreachable(error: Error | null): boolean {
  return error instanceof BackendError && error.code === "unreachable";
}

/** One cell per worker slot, filled while a run holds it. Wide pools fall back to the numbers. */
function SlotMeter({ running, concurrency }: { running: number; concurrency: number }) {
  if (concurrency > 8) {
    return null;
  }

  return (
    <span aria-hidden="true" className="flex gap-0.5 max-sm:hidden">
      {[...Array(concurrency).keys()].map((slot) => (
        <span
          key={slot}
          className={`h-3 w-1.5 rounded-[2px] ${slot < running ? "bg-active" : "bg-line-strong"}`}
        />
      ))}
    </span>
  );
}

function placeholderLabel(error: Error | null): string {
  if (error === null) {
    return "Daemon";
  }

  return isUnreachable(error) ? "Daemon offline" : "Daemon error";
}

/** The header's link to the daemon page, with its slot use at a glance. */
export function DaemonIndicator() {
  const daemon = useQuery(daemonQuery(useBackend()));

  // The query does not retry, so an error stays until the next poll succeeds. Say so instead of
  // looking like a first load.
  if (daemon.error || !daemon.data) {
    return (
      <Link
        to="/daemon"
        title={daemon.error?.message}
        className={`tab text-xs whitespace-nowrap ${daemon.error ? "text-danger" : ""}`}
        activeProps={{ className: "bg-raised text-ink" }}
      >
        <span aria-hidden="true" className="size-2 rounded-full border border-current" />
        {placeholderLabel(daemon.error)}
      </Link>
    );
  }

  const { running, concurrency } = daemon.data;

  return (
    <Link
      to="/daemon"
      aria-label={`Daemon, ${running} of ${concurrency} worker slots in use`}
      className="tab text-xs whitespace-nowrap"
      activeProps={{ className: "bg-raised text-ink" }}
    >
      <SlotMeter running={running} concurrency={concurrency} />
      <span className="font-mono tabular-nums">
        {running}/{concurrency}
      </span>
      <span className="max-sm:hidden">slots</span>
    </Link>
  );
}
