import {
  canCancelRun,
  cancelRefusal,
  canResumeRun,
  type GraphView,
  isTerminalRun,
  type RunSnapshotView,
  type RunView,
} from "@loopy/contract";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { bytes, elapsed, runElapsed, timestamp } from "../../lib/format";
import { useRunMutation } from "../../lib/mutations";
import { useRunPayload } from "../../lib/ui-data";
import { isWaiting, type WaitingRun } from "../../lib/waiting";
import { Button } from "../button";
import { Countdown } from "../countdown";
import { ErrorBanner } from "../error-banner";
import { JsonBlock } from "../json-preview";
import { RespondRow } from "../respond";
import { Load } from "../ui/load";
import { RunPill } from "../ui/status";

type RunAction = "resume" | "cancel" | "again";

/** One mutation for the header's actions, so only one runs at a time and its error shows. */
function useRunAction(run: RunView) {
  const navigate = useNavigate();

  const mutation = useRunMutation((backend, action: RunAction) => {
    switch (action) {
      case "resume": {
        return backend.call("resumeRun", { params: { id: run.id } });
      }

      case "cancel": {
        return backend.call("cancelRun", { params: { id: run.id } });
      }

      case "again": {
        return backend.call("startRun", {
          params: { slug: run.slug },
          body: { input: run.input, workspace: run.workspace },
        });
      }
    }
  });

  return {
    pending: mutation.isPending ? mutation.variables : null,
    error: mutation.error,
    start: (action: RunAction) =>
      mutation.mutate(action, {
        onSuccess: (next) => {
          if (action === "again") {
            void navigate({ to: "/runs/$runId", params: { runId: next.id } });
          }
        },
      }),
  };
}

function RunActions({ snapshot, graph }: { snapshot: RunSnapshotView; graph: GraphView | null }) {
  const { run } = snapshot;
  const action = useRunAction(run);
  const busy = action.pending !== null;
  const truncated = run.truncatedFields?.input !== undefined;
  const refusal = cancelRefusal(snapshot.nodeRuns, graph ?? { nodes: [] });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {canCancelRun(run) && (
          <Button
            variant="danger"
            disabled={busy || refusal !== null}
            title={refusal ?? "Cancel this run"}
            onClick={() => action.start("cancel")}
          >
            {action.pending === "cancel" ? "Cancelling" : "Cancel run"}
          </Button>
        )}
        {canResumeRun(run) && (
          <Button
            disabled={busy}
            title={
              run.status === "running"
                ? "Recover the run from its stale owner and queue it"
                : "Wake the run now"
            }
            onClick={() => action.start("resume")}
          >
            {action.pending === "resume" ? "Resuming" : "Resume"}
          </Button>
        )}
        <Button
          disabled={busy || truncated}
          title={
            truncated
              ? "The input is too large to resend from here. Start the run from the CLI."
              : "Start a new run with this run's input"
          }
          onClick={() => action.start("again")}
        >
          {action.pending === "again" ? "Starting" : "Run again"}
        </Button>
      </div>
      {action.error && <ErrorBanner error={action.error} />}
    </div>
  );
}

function Waiting({ run, now }: { run: WaitingRun; now: number }) {
  return (
    <div className="rounded-panel border border-attention/40 bg-attention-soft px-4 py-3">
      <RespondRow run={run} rowClassName="gap-x-3" formClassName="max-w-2xl">
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
      </RespondRow>
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
  graph: GraphView | null;
  revision: string | null;
  olderThanLatest: boolean;
  now: number;
  onShowFailure: (() => void) | null;
}) {
  const { snapshot, graph, revision, olderThanLatest, now, onShowFailure } = props;
  const { run } = snapshot;

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2.5">
            <Link
              to="/loopies/$slug"
              params={{ slug: run.slug }}
              search={{ workspace: run.workspace }}
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
                  {run.owner.pid === null
                    ? run.owner.host
                    : `pid ${run.owner.pid} on ${run.owner.host}`}
                  , stopped heartbeating
                </code>
              </span>
            )}
          </p>
        </div>
        <RunActions snapshot={snapshot} graph={graph} />
      </div>
      {run.status === "suspended" && isWaiting(run) && <Waiting run={run} now={now} />}
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
