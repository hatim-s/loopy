import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { StreamState } from "../backend/backend.ts";
import { httpBaseUrl } from "../backend/config.ts";
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

/** The fragment is a bootstrap secret, so remove it before touching storage. */
export function browserConnection(options: {
  baseUrl: string;
  pageUrl: string;
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  replaceUrl: (url: string) => void;
}) {
  const page = new URL(options.pageUrl);
  const fragment = new URLSearchParams(page.hash.slice(1));
  const token = fragment.get("token");

  if (fragment.has("token")) {
    fragment.delete("token");
    page.hash = fragment.toString();
    options.replaceUrl(page.href);
  }

  const baseUrl = httpBaseUrl(options.baseUrl);
  const key = `loopy-token:${baseUrl}`;
  let stored: string | null = null;

  try {
    const storage = options.storage();

    storage.removeItem("loopy-token");

    if (token) {
      storage.setItem(key, token);
    }

    stored = storage.getItem(key);
  } catch {
    // A blocked storage API must not leave the bootstrap token in the URL.
  }

  return { baseUrl, token: token || stored };
}
