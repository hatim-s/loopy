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

/**
 * Holds one event stream open while mounted. The run's snapshot supplies the starting
 * cursor; the stream then carries events for every run. Null holds nothing open.
 */
export function useRunStream(runId: string | null): void {
  const client = useQueryClient();
  const backend = useBackend();

  useEffect(() => {
    if (runId === null) {
      return;
    }

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
