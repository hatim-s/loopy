import type { RunDetail } from "loopy";
import { useEffect, useState } from "react";
import { endpoints } from "../api.ts";
import { shouldPoll } from "../lib/polling.ts";

export function useRun(
  id: string | undefined,
  onError: (cause: unknown) => void,
  revision: number,
) {
  const [detail, setDetail] = useState<RunDetail>();
  useEffect(() => {
    let stale = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: RunDetail | undefined;
    setDetail(undefined);

    async function refresh() {
      if (!id || document.visibilityState !== "visible" || stale) {
        return;
      }

      const requestGeneration = ++generation;

      try {
        const next = await endpoints.run(id);
        const cursor = current?.logs.at(-1)?.seq ?? 0;
        const increments = await endpoints.logs(id, cursor);

        const logs = new Map(
          [...(current?.logs ?? []), ...next.logs, ...increments].map((log) => [log.seq, log]),
        );

        if (stale || requestGeneration !== generation || document.visibilityState !== "visible") {
          return;
        }

        current = { ...next, logs: [...logs.values()].sort((a, b) => a.seq - b.seq) };

        setDetail(current);

        if (shouldPoll(current.run, true, Date.now())) {
          timer = setTimeout(() => void refresh(), 2000);
        } else if (current.run.status === "suspended" && current.run.wakeAt) {
          timer = setTimeout(
            () => void refresh(),
            Math.min(2_147_483_647, Math.max(1, Date.parse(current.run.wakeAt) - Date.now())),
          );
        }
      } catch (cause) {
        if (!stale && requestGeneration === generation && document.visibilityState === "visible") {
          onError(cause);
          timer = setTimeout(() => void refresh(), 2000);
        }
      }
    }

    function visibility() {
      generation++;
      clearTimeout(timer);

      if (document.visibilityState === "visible") {
        void refresh();
      }
    }

    document.addEventListener("visibilitychange", visibility);
    void refresh();

    return () => {
      stale = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [id, onError, revision]);

  return detail;
}
