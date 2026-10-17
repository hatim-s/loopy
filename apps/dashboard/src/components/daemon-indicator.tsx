import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BackendError } from "../backend/backend.ts";
import { daemonQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

export function isUnreachable(error: Error | null): boolean {
  return error instanceof BackendError && error.code === "unreachable";
}

/** The header's link to the daemon page, with its slot use at a glance. */
export function DaemonIndicator() {
  const daemon = useQuery(daemonQuery(useBackend()));

  const unreachable = isUnreachable(daemon.error);
  const tone = unreachable ? "text-danger" : "text-muted";
  let text = "Daemon";

  if (unreachable) {
    text = "Daemon not reachable";
  } else if (daemon.data) {
    text = `Daemon, ${daemon.data.running} of ${daemon.data.concurrency} running`;
  }

  return (
    <Link
      to="/daemon"
      className={`flex items-center gap-1.5 text-xs whitespace-nowrap hover:text-ink ${tone}`}
      activeProps={{ className: "text-ink" }}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full border border-current" />
      {text}
    </Link>
  );
}
