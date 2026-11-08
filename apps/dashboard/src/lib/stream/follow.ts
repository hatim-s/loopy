import type { QueryClient } from "@tanstack/react-query";
import type { LoopyBackend, StreamState } from "../../backend/backend";
import { applyBatch, resetStream } from "./apply";

type FollowOptions = {
  client: QueryClient;
  backend: Pick<LoopyBackend, "cursor" | "events">;
  signal: AbortSignal;
  onState: (state: StreamState) => void;
};

/**
 * Keeps the cache current from the event stream. A cursor precedes the initial refetch so
 * writes during that refetch are replayed. Transport reconnects keep their cursor; a reset
 * starts a new cache session from a fresh cursor.
 */
export async function followSession(options: FollowOptions): Promise<void> {
  const { client, backend, signal, onState } = options;

  try {
    while (!signal.aborted) {
      const cursor = await backend.cursor(signal);
      await client.invalidateQueries();

      if (signal.aborted) {
        return;
      }

      const end = await backend.events({
        after: cursor.cursor,
        epoch: cursor.epoch,
        signal,
        onState,
        onBatch: (batch) => applyBatch(client, batch),
      });

      if (end === "aborted" || signal.aborted) {
        return;
      }

      resetStream(client);
      onState("reconnecting");
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
}
