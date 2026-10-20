import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ErrorBanner } from "../components/error-banner.tsx";
import { InboxGroup } from "../components/inbox/inbox-group.tsx";
import { useClock } from "../lib/clock.ts";
import { waitingCount } from "../lib/inbox.ts";
import { inboxQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";

export const Route = createFileRoute("/inbox")({ component: Inbox });

function Inbox() {
  const inbox = useQuery(inboxQuery(useBackend()));
  const now = useClock();
  const total = inbox.data ? waitingCount(inbox.data) : 0;

  return (
    <section aria-labelledby="inbox-heading" className="page max-w-4xl space-y-5">
      <header className="space-y-0.5">
        <h1 id="inbox-heading" className="text-base font-semibold">
          Inbox
        </h1>
        {total > 0 && (
          <p className="text-xs text-muted">
            {total === 1 ? "One run is" : `${total} runs are`} waiting on a hook, oldest first.
          </p>
        )}
      </header>
      {inbox.error && <ErrorBanner error={inbox.error} />}
      {inbox.isPending && <p className="text-muted">Loading waiting runs.</p>}
      {inbox.data?.length === 0 && (
        <div className="space-y-1 border-y border-line py-6">
          <p>Nothing is waiting on you.</p>
          <p className="text-xs text-muted">
            Runs that call <code className="font-mono">hook()</code> show up here until someone
            resolves them.
          </p>
        </div>
      )}
      {inbox.data?.map((group) => (
        <InboxGroup key={group.slug} group={group} now={now} />
      ))}
    </section>
  );
}
