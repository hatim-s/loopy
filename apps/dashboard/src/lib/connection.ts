import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { StreamState } from "../backend/backend.ts";
import { useBackend } from "../router-context.ts";
import { followRun } from "./stream.ts";

/** idle: no page holds a stream open. */
export type ConnectionState = StreamState | "idle";

let current: ConnectionState = "idle";

const listeners = new Set<() => void>();

function publish(state: ConnectionState): void {
  current = state;

  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribe, () => current);
}

/** Holds one event stream open for as long as the run page is mounted. */
export function useRunStream(runId: string): void {
  const client = useQueryClient();
  const backend = useBackend();

  useEffect(() => {
    const controller = new AbortController();

    followRun({ client, backend, runId, signal: controller.signal, onState: publish }).catch(() => {
      if (!controller.signal.aborted) {
        publish("stale");
      }
    });

    return () => {
      controller.abort();
      publish("idle");
    };
  }, [client, backend, runId]);
}
