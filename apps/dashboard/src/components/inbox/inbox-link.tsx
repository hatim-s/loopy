import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { waitingCount } from "../../lib/inbox.ts";
import { inboxQuery } from "../../lib/queries.ts";
import { useBackend } from "../../router-context.ts";

function useWaitingCount(): number {
  const inbox = useQuery(inboxQuery(useBackend()));

  return inbox.data ? waitingCount(inbox.data) : 0;
}

export function InboxLink() {
  const count = useWaitingCount();

  return (
    <Link
      to="/inbox"
      className="mr-4 ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
      activeProps={{ className: "bg-raised text-ink" }}
      aria-label={count > 0 ? `Inbox, ${count} waiting` : "Inbox"}
    >
      Inbox
      {count > 0 && (
        <span className="rounded bg-attention/15 px-1.5 font-mono text-xs text-attention tabular-nums">
          {count}
        </span>
      )}
    </Link>
  );
}
