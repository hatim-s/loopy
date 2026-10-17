import type { RunView } from "loopy/contract";
import { useRunMutation } from "../lib/mutations.ts";
import { Button } from "./button.tsx";
import { ErrorBanner } from "./error-banner.tsx";

const CANCELLABLE = new Set<RunView["status"]>(["queued", "running", "suspended"]);

export function RunActions({ run }: { run: RunView }) {
  const resume = useRunMutation((backend) => backend.resumeRun(run.id));
  const cancel = useRunMutation((backend) => backend.cancelRun(run.id));
  const busy = resume.isPending || cancel.isPending;
  const error = resume.error ?? cancel.error;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <Button
          disabled={busy || run.status !== "suspended"}
          title="Wake the run now instead of at its scheduled time"
          onClick={() => resume.mutate()}
        >
          {resume.isPending ? "Resuming" : "Resume"}
        </Button>
        <Button disabled={busy || !CANCELLABLE.has(run.status)} onClick={() => cancel.mutate()}>
          {cancel.isPending ? "Cancelling" : "Cancel run"}
        </Button>
      </div>
      {error && <ErrorBanner error={error} />}
    </div>
  );
}
