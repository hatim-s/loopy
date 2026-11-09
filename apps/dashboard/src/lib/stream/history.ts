import type { RunView } from "@loopy/contract";
import type { Query, QueryClient } from "@tanstack/react-query";

const STREAM_HISTORY_LIMIT = 2048;

export type SeenRun = { sequence: number; run: RunView };

/**
 * What this cache session has already applied. Lists have no wire cursor, so replay protection
 * lives here: the newest sequence per run or schedule, the newest run per id, and per list
 * query the runs it accepted. Query identity lets garbage collection drop a list's entry.
 */
export type StreamHistory = {
  sequences: Map<string, number>;
  runs: Map<string, SeenRun>;
  lists: WeakMap<Query, Map<string, SeenRun>>;
};

const histories = new WeakMap<QueryClient, StreamHistory>();

export function historyOf(client: QueryClient): StreamHistory {
  const history = histories.get(client) ?? {
    sequences: new Map(),
    runs: new Map(),
    lists: new WeakMap(),
  };

  histories.set(client, history);

  return history;
}

export function seenRun(client: QueryClient, id: string): RunView | undefined {
  return histories.get(client)?.runs.get(id)?.run;
}

export function forgetHistory(client: QueryClient): void {
  histories.delete(client);
}

export function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);

  if (map.size > STREAM_HISTORY_LIMIT) {
    const oldest = map.keys().next();

    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
}
