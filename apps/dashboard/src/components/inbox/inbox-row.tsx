import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { span } from "../../lib/format.ts";
import { type WaitingRun, waitingSince } from "../../lib/inbox.ts";
import { useResolveHook } from "../../lib/mutations.ts";
import { Button } from "../button.tsx";
import { Countdown } from "../countdown.tsx";
import { PayloadEditor, ResolveError } from "../resolve-form.tsx";

function Expiry({ at, now }: { at: string | null; now: number }) {
  return at === null ? (
    <span className="text-muted">no expiry</span>
  ) : (
    <span>
      expires <Countdown at={at} now={now} />
    </span>
  );
}

/** One waiting run. The row leaves the list once its waitingOn clears. */
export function InboxRow({ run, now }: { run: WaitingRun; now: number }) {
  const [editing, setEditing] = useState(false);
  const resolve = useResolveHook(run.waitingOn.token);
  const since = waitingSince(run);

  return (
    <li className="space-y-3 border-l-2 border-attention py-2.5 pr-2 pl-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="w-36 shrink-0 truncate font-mono font-medium" title={run.waitingOn.hook}>
          {run.waitingOn.hook}
        </span>
        <span className="min-w-0 flex-1 basis-64 text-xs text-muted">
          <Link
            to="/runs/$runId"
            params={{ runId: run.id }}
            className="break-all text-ink underline-offset-2 hover:underline"
          >
            {run.slug} <span className="font-mono text-muted">{run.id}</span>
          </Link>
          <span className="block tabular-nums">
            <time dateTime={since} className="text-attention">
              waiting {span(now - Date.parse(since))}
            </time>
            , <Expiry at={run.waitingOn.expiresAt} now={now} />
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <Button variant="primary" disabled={resolve.isPending} onClick={() => resolve.mutate({})}>
            Resolve with <code className="ml-1 font-mono">{"{}"}</code>
          </Button>
          <Button aria-expanded={editing} onClick={() => setEditing((open) => !open)}>
            {editing ? "Hide payload" : "Edit payload"}
          </Button>
        </span>
      </div>
      {editing && <PayloadEditor resolve={resolve} />}
      {resolve.error && <ResolveError error={resolve.error} />}
    </li>
  );
}
