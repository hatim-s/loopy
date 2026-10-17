import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { encodeRunCursor } from "loopy/contract";
import type { LoopyBackend, RunsQuery } from "../backend/backend.ts";
import { INBOX_QUERY, inboxGroups } from "./inbox.ts";
import { keys, type RunFilters } from "./keys.ts";

export const RUN_PAGE_SIZE = 25;

export function loopiesQuery(backend: LoopyBackend) {
  return queryOptions({ queryKey: keys.loopies, queryFn: () => backend.loopies() });
}

export function runsQuery(backend: LoopyBackend, query: RunsQuery) {
  return queryOptions({ queryKey: keys.runs(query), queryFn: () => backend.runs(query) });
}

/** Newest first. A short page is the last one; otherwise its oldest run is the next cursor. */
export function runPagesQuery(backend: LoopyBackend, filters: RunFilters) {
  return infiniteQueryOptions({
    queryKey: keys.runPages(filters),
    queryFn: ({ pageParam }: { pageParam: RunsQuery["before"] }) =>
      backend.runs({ ...filters, limit: RUN_PAGE_SIZE, before: pageParam }),
    initialPageParam: undefined,
    getNextPageParam: (page) => {
      const oldest = page.at(-1);

      return page.length < RUN_PAGE_SIZE || oldest === undefined
        ? undefined
        : encodeRunCursor(oldest);
    },
  });
}

/** The event stream keeps a loaded snapshot current, so it never goes stale by time. */
export function runQuery(backend: LoopyBackend, id: string) {
  return queryOptions({
    queryKey: keys.run(id),
    queryFn: ({ signal }) => backend.run(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Polled, since the daemon's counters do not travel on the event stream. */
export function daemonQuery(backend: LoopyBackend) {
  return queryOptions({
    queryKey: keys.daemon,
    queryFn: () => backend.daemon(),
    refetchInterval: 5000,
    retry: false,
  });
}

export function inboxQuery(backend: LoopyBackend) {
  return queryOptions({
    queryKey: keys.runs(INBOX_QUERY),
    queryFn: () => backend.runs(INBOX_QUERY),
    select: inboxGroups,
  });
}
