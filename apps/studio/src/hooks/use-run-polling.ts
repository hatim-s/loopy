import { useEffect, useState } from "react";
import { endpoints, type RunDetail } from "../api.ts";
import { useRequest } from "./use-request.ts";

const POLL_MS = 1000;

type Options = {
  runId: string | null;
  active: boolean;
  apply: (detail: RunDetail) => void;
  onError: (cause: unknown) => void;
};

/** Refetches the run once per second while `active`, plus once as soon as it turns on. */
export function useRunPolling({ runId, active, apply, onError }: Options): void {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => setTick((count) => count + 1), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  const load = active && runId ? () => endpoints.run(runId) : null;
  useRequest({ load, apply, onError }, [tick, runId, active]);
}
