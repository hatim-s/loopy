import type { RunRecord } from "loopy";
import { useEffect, useState } from "react";
import { endpoints } from "../api.ts";

export function useRuns(onError: (cause: unknown) => void, revision: number) {
  const [runs, setRuns] = useState<RunRecord[]>([]);

  useEffect(() => {
    let stale = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      if (stale || document.visibilityState !== "visible") {
        return;
      }

      const requestGeneration = ++generation;

      try {
        const next = await endpoints.runs();

        if (!stale && requestGeneration === generation) {
          setRuns(next);
        }
      } catch (cause) {
        if (!stale && requestGeneration === generation) {
          onError(cause);
        }
      } finally {
        if (!stale && requestGeneration === generation) {
          timer = setTimeout(() => void refresh(), 5000);
        }
      }
    }

    function visibility() {
      generation++;
      clearTimeout(timer);
      void refresh();
    }

    document.addEventListener("visibilitychange", visibility);
    void refresh();

    return () => {
      stale = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [onError, revision]);

  return runs;
}
