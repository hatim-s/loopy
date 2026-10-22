import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { BackendError, type LoopyBackend, type StreamState } from "../backend/backend.ts";
import { httpBaseUrl } from "../backend/config.ts";
import { useBackend } from "../router-context.ts";
import { followSession } from "./stream.ts";

/** idle: the application stream has not mounted yet. */
export type ConnectionState = StreamState | "idle";

/**
 * Whether this page may use the API. missing: no token reached the page. rejected: the daemon
 * refused the token, which happens after it restarts with a new one. unreachable: nothing answered.
 */
export type Access = "checking" | "open" | "missing" | "rejected" | "unreachable";

// Long enough for a busy local daemon, short enough that a dead address does not hang the gate.
const PROBE_TIMEOUT_MS = 5000;

function externalValue<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set(next: T) {
      value = next;

      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

const stream = externalValue<ConnectionState>("idle");

const access = externalValue<Access>("checking");

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(stream.subscribe, stream.get);
}

export function useAccess(): Access {
  return useSyncExternalStore(access.subscribe, access.get);
}

/**
 * Asks the API once before the dashboard mounts, so a missing or stale token shows one gate
 * instead of an error in every widget. Other API errors open the dashboard, where each widget
 * reports its own failure.
 */
export async function checkAccess(backend: LoopyBackend, token: string | null): Promise<Access> {
  if (token === null) {
    access.set("missing");

    return "missing";
  }

  access.set("checking");

  try {
    await backend.cursor(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    access.set("open");
  } catch (error) {
    // The probe's own timeout rejects with a DOMException, which also means nothing answered.
    if (!(error instanceof BackendError) || error.code === "unreachable") {
      access.set("unreachable");
    } else {
      access.set(error.code === "unauthorized" ? "rejected" : "open");
    }
  }

  return access.get();
}

/** A 401 after the gate opened means the daemon restarted, so close the gate again. */
export function closeOnUnauthorized(error: Error): void {
  if (error instanceof BackendError && error.code === "unauthorized") {
    access.set("rejected");
  }
}

/** Reads the bootstrap token from an address such as the one `loopy ui` prints. */
export function addressToken(address: URL): string | null {
  return new URLSearchParams(address.hash.slice(1)).get("token") || null;
}

export function useSessionStream(): void {
  const client = useQueryClient();
  const backend = useBackend();

  useEffect(() => {
    const controller = new AbortController();

    followSession({ client, backend, signal: controller.signal, onState: stream.set }).catch(
      (error) => {
        if (controller.signal.aborted) {
          return;
        }

        stream.set("stale");

        if (error instanceof BackendError) {
          closeOnUnauthorized(error);
        }
      },
    );

    return () => {
      controller.abort();
      stream.set("idle");
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
  const token = addressToken(page);

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

  return { baseUrl, token: token ?? stored };
}
