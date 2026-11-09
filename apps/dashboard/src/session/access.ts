import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { BackendError, type LoopyBackend, type StreamState } from "../backend/backend";
import { followSession } from "../lib/stream/follow";
import { useBackend } from "../router-context";

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
export async function checkAccess(
  backend: Pick<LoopyBackend, "cursor">,
  token: string | null,
): Promise<Access> {
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

        if (error instanceof Error) {
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
