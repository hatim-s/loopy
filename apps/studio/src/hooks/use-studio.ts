import type { RunDetail, RunRecord } from "loopy";
import { useEffect, useState } from "react";
import { endpoints, type LoopySummary } from "../api.ts";
import { useRequest } from "./use-request.ts";

export function useStudio() {
  const [loopies, setRegistry] = useState<LoopySummary[]>([]);
  const [slug, setSlug] = useState<string>();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runId, setRunId] = useState<string>();
  const [detail, setDetail] = useState<RunDetail>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  const onError = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));

  useEffect(() => {
    const timer = setInterval(() => setRevision((value) => value + 1), 2000);

    return () => clearInterval(timer);
  }, []);

  useRequest({ load: endpoints.loopies, apply: setRegistry, onError }, [revision]);
  useRequest({ load: slug ? () => endpoints.runs(slug) : null, apply: setRuns, onError }, [
    slug,
    revision,
  ]);
  useRequest({ load: runId ? () => endpoints.run(runId) : null, apply: setDetail, onError }, [
    runId,
    revision,
  ]);

  function selectSlug(value: string) {
    setSlug(value);
    setRuns([]);
    setRunId(undefined);
    setDetail(undefined);
  }

  function selectRun(value: string) {
    setRunId(value);
    setDetail(undefined);
  }

  return {
    loopies,
    slug,
    runs,
    runId,
    detail,
    error,
    selectSlug,
    selectRun,
    dismissError: () => setError(undefined),
  };
}
