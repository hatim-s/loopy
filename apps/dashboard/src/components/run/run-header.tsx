import { Link, useNavigate } from "@tanstack/react-router";
import { isTerminalRun, type RunSnapshotView, type RunView } from "loopy/contract";
import { useId, useState } from "react";
import { elapsed, timestamp } from "../../lib/format.ts";
import { useResolveHook, useRunMutation } from "../../lib/mutations.ts";
import { useRunPayload } from "../../lib/ui-data.ts";
import { Button } from "../button.tsx";
import { Countdown } from "../countdown.tsx";
import { ErrorBanner } from "../error-banner.tsx";
import { JsonBlock } from "../json-preview.tsx";
import { PayloadEditor, ResolveError } from "../resolve-form.tsx";
import { bytes, runElapsed } from "../runs/run-table.tsx";
import { Load } from "../ui/load.tsx";
import { RunPill } from "../ui/status.tsx";

/** A running run can be resumed only once its owner's lease lapsed; the server recovers it. */
function resumable(run: RunView): boolean {
  return (
    run.status === "queued" ||
    run.status === "suspended" ||
    (run.status === "running" && run.ownerStale)
  );
}

function RunActions({ run }: { run: RunView }) {
  const navigate = useNavigate();
  const resume = useRunMutation((backend) => backend.resumeRun(run.id));
  const cancel = useRunMutation((backend) => backend.cancelRun(run.id));
  const again = useRunMutation((backend) => backend.startRun(run.slug, run.input, run.workspace));
  const busy = resume.isPending || cancel.isPending || again.isPending;
  const error = resume.error ?? cancel.error ?? again.error;
  const truncated = run.truncatedFields?.input !== undefined;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {!isTerminalRun(run.status) && (
          <Button variant="danger" disabled={busy} onClick={() => cancel.mutate()}>
            {cancel.isPending ? "Cancelling" : "Cancel run"}
          </Button>
        )}
        {resumable(run) && (
          <Button
            disabled={busy}
            title={
              run.status === "running"
                ? "Recover the run from its stale owner and queue it"
                : "Wake the run now"
            }
            onClick={() => resume.mutate()}
          >
            {resume.isPending ? "Resuming" : "Resume"}
          </Button>
        )}
        <Button
          disabled={busy || truncated}
          title={
            truncated
              ? "The input is too large to resend from here. Start the run from the CLI."
              : "Start a new run with this run's input"
          }
          onClick={() =>
            again.mutate(undefined, {
              onSuccess: (next) =>
                void navigate({ to: "/runs/$runId", params: { runId: next.id } }),
            })
          }
        >
          {again.isPending ? "Starting" : "Run again"}
        </Button>
      </div>
      {error && <ErrorBanner error={error} />}
    </div>
  );
}

function Waiting({
  run,
  now,
}: {
  run: RunView & { waitingOn: NonNullable<RunView["waitingOn"]> };
  now: number;
}) {
  const resolve = useResolveHook(run.waitingOn.token);
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-panel border border-attention/40 bg-attention-soft px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-medium">
          Waiting on <code className="text-[13px]">{run.waitingOn.hook}</code>
        </p>
        <span className="text-xs text-muted">
          since {elapsed(now - Date.parse(run.waitingOn.since))}
          {run.waitingOn.expiresAt && (
            <>
              , expires <Countdown at={run.waitingOn.expiresAt} now={now} />
            </>
          )}
        </span>
        <Button small className="ml-auto" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Close" : "Respond"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 max-w-2xl">
          <PayloadEditor resolve={resolve} />
          {resolve.error && <ResolveError error={resolve.error} />}
        </div>
      )}
    </div>
  );
}

/** Input and output. Previews come with the run; the full payload loads when opened. */
function RunPayload({ run }: { run: RunView }) {
  const [open, setOpen] = useState(false);
  const payload = useRunPayload(open ? run.id : null);
  const id = useId();
  const truncated = run.truncatedFields;

  return (
    <div>
      <button
        type="button"
        className="link-btn text-xs"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide input and output" : "Show input and output"}
      </button>
      {truncated && (truncated.input !== undefined || truncated.output !== undefined) && (
        <span className="ml-2 text-xs text-muted">
          {truncated.input !== undefined && `Input ${bytes(truncated.input)}. `}
          {truncated.output !== undefined && `Output ${bytes(truncated.output)}.`}
        </span>
      )}
      {open && (
        <div id={id} className="mt-2 grid gap-3 lg:grid-cols-2">
          <Load
            value={payload}
            pending={<p className="text-xs text-muted">Loading the full input and output.</p>}
          >
            {(data) => (
              <>
                <div>
                  <h3 className="text-xs font-semibold text-muted">Input</h3>
                  <JsonBlock value={data.input} />
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-muted">Output</h3>
                  {data.output === undefined ? (
                    <p className="mt-1.5 text-xs text-muted">
                      {run.status === "succeeded"
                        ? "No output."
                        : "Only a succeeded run has an output."}
                    </p>
                  ) : (
                    <JsonBlock value={data.output} />
                  )}
                </div>
              </>
            )}
          </Load>
        </div>
      )}
    </div>
  );
}

export function RunHeader(props: {
  snapshot: RunSnapshotView;
  revision: string | null;
  olderThanLatest: boolean;
  now: number;
  onShowFailure: (() => void) | null;
}) {
  const { snapshot, revision, olderThanLatest, now, onShowFailure } = props;
  const { run } = snapshot;

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2.5">
            <Link
              to="/loopies/$slug"
              params={{ slug: run.slug }}
              className="text-ink hover:text-active"
            >
              {run.slug}
            </Link>
            <RunPill run={run} />
          </h1>
          <p className="facts">
            <span>
              <span>Started</span>
              <time dateTime={run.createdAt}>{timestamp(run.createdAt)}</time>
            </span>
            <span>
              <span>{isTerminalRun(run.status) ? "Took" : "Elapsed"}</span>
              <span className="tabular-nums">{elapsed(runElapsed(run, now))}</span>
            </span>
            {revision && (
              <span
                title={
                  olderThanLatest ? "The loopy has been saved since this run started" : undefined
                }
              >
                <span>Revision</span>
                <code>{revision.slice(0, 8)}</code>
                {olderThanLatest && (
                  <span className="ml-1.5 text-attention">older than the latest save</span>
                )}
              </span>
            )}
            <span>
              <span>Run</span>
              <code>{run.id}</code>
            </span>
            {run.owner && run.ownerStale && (
              <span title="Resume recovers the run from this owner">
                <span>Owner</span>
                <code className="text-attention">
                  pid {run.owner.pid} on {run.owner.host}, stopped heartbeating
                </code>
              </span>
            )}
          </p>
        </div>
        <RunActions run={run} />
      </div>
      {run.status === "suspended" && run.waitingOn && (
        <Waiting run={{ ...run, waitingOn: run.waitingOn }} now={now} />
      )}
      {run.status === "failed" && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-3 rounded-panel bg-danger-soft px-4 py-3 text-danger"
        >
          <pre className="min-w-0 flex-1 font-mono text-xs whitespace-pre-wrap">{run.error}</pre>
          {onShowFailure && (
            <Button small onClick={onShowFailure}>
              Show the failed node
            </Button>
          )}
        </div>
      )}
      <RunPayload run={run} />
    </header>
  );
}
