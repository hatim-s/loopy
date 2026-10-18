import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { encodeRunCursor } from "loopy/contract";
import type { LoopyBackend, RunsQuery } from "../backend/backend.ts";
import { INBOX_QUERY, inboxGroups } from "./inbox.ts";
import { keys, type RunFilters } from "./keys.ts";

export const RUN_PAGE_SIZE = 25;

export function loopiesQuery(backend: LoopyBackend) {
  return queryOptions({ queryKey: keys.loopies, queryFn: () => backend.loopies() });
}

// The server page boundary survives stream removals, including removal of its oldest row.
function runPage(runs: Awaited<ReturnType<LoopyBackend["runs"]>>) {
  const oldest = runs.at(-1);

  return {
    runs,
    nextCursor:
      runs.length < RUN_PAGE_SIZE || oldest === undefined ? undefined : encodeRunCursor(oldest),
  };
}

export type RunPage = ReturnType<typeof runPage>;

export function runPagesQuery(backend: LoopyBackend, filters: RunFilters) {
  return infiniteQueryOptions({
    queryKey: keys.runPages(filters),
    queryFn: async ({ pageParam }: { pageParam: RunsQuery["before"] }) =>
      runPage(await backend.runs({ ...filters, limit: RUN_PAGE_SIZE, before: pageParam })),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor,
    select: (data) => ({ ...data, pages: data.pages.map((page) => page.runs) }),
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

export function schedulesQuery(backend: LoopyBackend, workspace?: string) {
  return queryOptions({
    queryKey: workspace === undefined ? keys.schedules : keys.schedulesIn(workspace),
    queryFn: () => backend.schedules(workspace),
  });
}
