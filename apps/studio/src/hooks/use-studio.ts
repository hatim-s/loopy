import type { LoopySummary } from "loopy";
import { useCallback, useEffect, useState } from "react";
import { endpoints } from "../api.ts";
import { useRequest } from "./use-request.ts";
import { useRun } from "./use-run.ts";
import { useRuns } from "./use-runs.ts";

export function useStudio() {
  const [loopies, setLoopies] = useState<LoopySummary[]>([]);
  const [slug, setSlug] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  const onError = useCallback(
    (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );

  const detail = useRun(runId, onError, revision);
  const allRuns = useRuns(onError, revision);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    function visible() {
      if (document.visibilityState === "visible") {
        setRevision((value) => value + 1);
      }
    }

    document.addEventListener("visibilitychange", visible);

    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  useRequest({ load: endpoints.loopies, apply: setLoopies, onError }, [revision]);

  function selectSlug(value: string) {
    setSlug(value);
    setRunId(undefined);
  }

  return {
    loopies,
    slug,
    allRuns,
    runs: allRuns.filter((run) => run.slug === slug),
    runId,
    detail,
    error,
    selectSlug,
    selectRun: setRunId,
    refresh,
    dismissError: () => setError(undefined),
  };
}
