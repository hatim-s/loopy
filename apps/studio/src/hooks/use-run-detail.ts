import type { ExecutionMode, Json, RunRecord } from "loopy";
import { useState } from "react";
import { endpoints, type RunDetail } from "../api.ts";
import type { ErrorReporter } from "./use-error-reporter.ts";
import { useRequest } from "./use-request.ts";
import { useRunPolling } from "./use-run-polling.ts";
import { useScopedState } from "./use-scoped-state.ts";

type Options = {
  slug: string | null;
  /** False until the workflow and its runs have arrived; the first selection waits for them. */
  loaded: boolean;
  runs: RunRecord[];
  putRun: (run: RunRecord) => void;
  errors: ErrorReporter;
};

// The resume endpoint answers before the run row changes, so we remember the
// updatedAt we saw and keep polling until the server reports a newer one.
type ResumeBaseline = { id: string; updatedAt: string };

/** The selected run, its loaded detail, live polling, and the start and resume actions. */
export function useRunDetail({ slug, loaded, runs, putRun, errors }: Options) {
  // Undefined means nothing chosen yet; null means the saved definition. The newest run is
  // pinned once per workflow so a later refresh does not move the selection.
  const [chosen, selectRun] = useScopedState<string | null | undefined>(slug, undefined);
  if (loaded && chosen === undefined) {
    selectRun(runs[0]?.id ?? null);
  }
  const selectedRunId = chosen ?? null;
  const [detail, setDetail] = useScopedState<RunDetail | null>(selectedRunId, null);
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState<ResumeBaseline | null>(null);

  useRequest(
    {
      load: selectedRunId ? () => endpoints.run(selectedRunId) : null,
      apply: setDetail,
      onError: errors.report,
    },
    [selectedRunId],
  );

  const live = detail?.run.status === "pending" || detail?.run.status === "running";
  const awaitingResume = baseline?.id === selectedRunId;
  useRunPolling({
    runId: selectedRunId,
    active: live || awaitingResume,
    apply: (next) => {
      putRun(next.run);
      setDetail(next);
      if (baseline?.id === next.run.id && next.run.updatedAt !== baseline.updatedAt) {
        setBaseline(null);
      }
    },
    onError: errors.report,
  });

  async function start(input: Json, mode: ExecutionMode) {
    if (!slug) {
      return;
    }
    setBusy(true);
    errors.clear();
    try {
      const run = await endpoints.start(slug, input, mode);
      putRun(run);
      selectRun(run.id);
    } catch (cause) {
      errors.report(cause);
    } finally {
      setBusy(false);
    }
  }

  async function resume(retryUncertain: boolean) {
    if (!selectedRunId || !detail) {
      return;
    }
    setBusy(true);
    errors.clear();
    try {
      const run = await endpoints.resume(selectedRunId, retryUncertain);
      putRun(run);
      setDetail({ ...detail, run });
      setBaseline({ id: run.id, updatedAt: detail.run.updatedAt });
    } catch (cause) {
      errors.report(cause);
    } finally {
      setBusy(false);
    }
  }

  return { selectedRunId, selectRun, detail, busy, start, resume };
}
