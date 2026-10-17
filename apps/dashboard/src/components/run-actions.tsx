import type { RunView } from "loopy/contract";
import { useRunMutation } from "../lib/mutations.ts";
import { Button } from "./button.tsx";
import { ErrorBanner } from "./error-banner.tsx";

const CANCELLABLE = new Set<RunView["status"]>(["queued", "running", "suspended"]);

/** A running run can only be resumed once its owner's lease lapsed; the server recovers it. */
function resumable(run: RunView): boolean {
  return (
    run.status === "queued" ||
    run.status === "suspended" ||
    (run.status === "running" && run.ownerStale)
  );
}

export function RunActions({ run }: { run: RunView }) {
  const resume = useRunMutation((backend) => backend.resumeRun(run.id));
  const cancel = useRunMutation((backend) => backend.cancelRun(run.id));
  const busy = resume.isPending || cancel.isPending;
  const error = resume.error ?? cancel.error;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <Button
          disabled={busy || !resumable(run)}
          title={
            run.status === "running"
              ? "Recover the run from its stale owner and queue it"
              : "Wake the run now instead of at its scheduled time"
          }
          onClick={() => {
            cancel.reset();
            resume.mutate();
          }}
        >
          {resume.isPending ? "Resuming" : "Resume"}
        </Button>
        <Button
          disabled={busy || !CANCELLABLE.has(run.status)}
          onClick={() => {
            resume.reset();
            cancel.mutate();
          }}
        >
          {cancel.isPending ? "Cancelling" : "Cancel run"}
        </Button>
      </div>
      {error && <ErrorBanner error={error} />}
    </div>
  );
}
