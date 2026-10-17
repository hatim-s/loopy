import { queryOptions } from "@tanstack/react-query";
import type { LoopyBackend, RunsQuery } from "../backend/backend.ts";
import { keys } from "./keys.ts";

export function loopiesQuery(backend: LoopyBackend) {
  return queryOptions({ queryKey: keys.loopies, queryFn: () => backend.loopies() });
}

export function runsQuery(backend: LoopyBackend, query: RunsQuery) {
  return queryOptions({ queryKey: keys.runs(query), queryFn: () => backend.runs(query) });
}

/** The event stream keeps a loaded snapshot current, so it never goes stale by time. */
export function runQuery(backend: LoopyBackend, id: string) {
  return queryOptions({
    queryKey: keys.run(id),
    queryFn: ({ signal }) => backend.run(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
