import { useEffect, useRef } from "react";
import { endpoints, type RunDetail } from "../api.ts";

const POLL_MS = 1000;

type Options = {
  runId: string | null;
  active: boolean;
  apply: (detail: RunDetail) => void;
  onError: (cause: unknown) => void;
};

/**
 * Refetches the run while `active`: once immediately, then one second after each
 * response lands. Waiting for the response keeps a slow server from piling up
 * requests whose results would be dropped as stale.
 */
export function useRunPolling({ runId, active, apply, onError }: Options): void {
  // The callbacks close over the latest render; the effect reads them through a ref so
  // a changed callback does not restart the loop.
  const callbacks = useRef({ apply, onError });
  callbacks.current = { apply, onError };

  useEffect(() => {
    if (!active || !runId) {
      return;
    }

    const id = runId;
    let stopped = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const detail = await endpoints.run(id);

        if (!stopped) {
          callbacks.current.apply(detail);
        }
      } catch (cause) {
        if (!stopped) {
          callbacks.current.onError(cause);
        }
      }

      if (!stopped) {
        timer = window.setTimeout(() => void poll(), POLL_MS);
      }
    }

    void poll();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, runId]);
}
