import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { StreamState } from "../backend/backend.ts";
import { useBackend } from "../router-context.ts";
import { followSession } from "./stream.ts";

/** idle: the application stream has not mounted yet. */
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

export function useSessionStream(): void {
  const client = useQueryClient();
  const backend = useBackend();

  useEffect(() => {
    const controller = new AbortController();

    followSession({ client, backend, signal: controller.signal, onState: publish }).catch(() => {
      if (!controller.signal.aborted) {
        publish("stale");
      }
    });

    return () => {
      controller.abort();
      publish("idle");
    };
  }, [client, backend]);
}
