import { infiniteQueryOptions, queryOptions, skipToken } from "@tanstack/react-query";
import { encodeRunCursor } from "loopy/contract";
import type { LoopyBackend, OverviewQuery, RunsQuery } from "../backend/backend.ts";
import { INBOX_QUERY, inboxGroups } from "./inbox.ts";
import {
  type EventFilters,
  type ExecutionFilters,
  keys,
  type LogFilters,
  type RunFilters,
  type ScopeItemsFilters,
} from "./keys.ts";

export const RUN_PAGE_SIZE = 25;

export const PAGE_SIZE = 50;

export const MAX_CACHED_ROWS = 200;

export const QUERY_GC_TIME = 60_000;

export function loopiesQuery(backend: LoopyBackend) {
  return queryOptions({ queryKey: keys.loopies, queryFn: () => backend.loopies() });
}

export function workspaceLoopiesQuery(backend: LoopyBackend, workspace: string | null) {
  return queryOptions({
    queryKey: keys.workspaceLoopies(workspace),
    queryFn: workspace === null ? skipToken : () => backend.loopies(workspace),
  });
}

// The server page boundary survives stream removals, including removal of its oldest row.
export function runPage(runs: Awaited<ReturnType<LoopyBackend["runs"]>>, limit = RUN_PAGE_SIZE) {
  const oldest = runs.at(-1);

  return {
    runs,
    nextCursor: runs.length < limit || oldest === undefined ? undefined : encodeRunCursor(oldest),
  };
}

export type RunPage = ReturnType<typeof runPage>;

export function runPagesQuery(backend: LoopyBackend, filters: RunFilters) {
  return infiniteQueryOptions({
    queryKey: keys.runPages(filters),
    maxPages: MAX_CACHED_ROWS / RUN_PAGE_SIZE,
    gcTime: QUERY_GC_TIME,
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
    gcTime: QUERY_GC_TIME,
  });
}

/** Saves do not travel on the event stream, so the latest definition refetches by time. */
export function loopyGraphQuery(backend: LoopyBackend, slug: string, workspace: string) {
  return queryOptions({
    queryKey: keys.loopyGraph(slug, workspace),
    queryFn: () => backend.loopyGraph(slug, workspace),
  });
}

/** A run's revision is fixed when the run is created, so its graph never changes. */
export function runGraphQuery(backend: LoopyBackend, id: string) {
  return queryOptions({
    queryKey: keys.runGraph(id),
    queryFn: () => backend.runGraph(id),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
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

export function scheduleOverviewQuery(backend: LoopyBackend) {
  return queryOptions({
    queryKey: keys.scheduleOverview,
    queryFn: ({ signal }) => backend.scheduleOverview(signal),
  });
}

export function schedulesQuery(backend: LoopyBackend, workspace: string | null) {
  return queryOptions({
    queryKey: keys.schedules(workspace),
    queryFn: workspace === null ? skipToken : () => backend.schedules(workspace),
  });
}

export function overviewQuery(backend: LoopyBackend, query: OverviewQuery) {
  return queryOptions({
    queryKey: keys.overview(query),
    queryFn: ({ signal }) => backend.overview(query, signal),
    gcTime: QUERY_GC_TIME,
  });
}

export function runSourceQuery(backend: LoopyBackend, id: string) {
  return queryOptions({
    queryKey: keys.runSource(id),
    queryFn: ({ signal }) => backend.runSource(id, signal),
    staleTime: Infinity,
    gcTime: QUERY_GC_TIME,
  });
}

export function loopySourceQuery(backend: LoopyBackend, slug: string, workspace: string) {
  return queryOptions({
    queryKey: keys.source(slug, workspace),
    queryFn: ({ signal }) => backend.source(slug, workspace, signal),
    gcTime: QUERY_GC_TIME,
  });
}

export function executionsQuery(backend: LoopyBackend, id: string, filters: ExecutionFilters) {
  return infiniteQueryOptions({
    queryKey: keys.executions(id, filters),
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      backend.executions(id, { ...filters, after: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    maxPages: MAX_CACHED_ROWS / PAGE_SIZE,
    gcTime: QUERY_GC_TIME,
  });
}

export function executionQuery(backend: LoopyBackend, id: string, key: string | undefined) {
  return queryOptions({
    queryKey: keys.execution(id, key),
    queryFn: key === undefined ? skipToken : ({ signal }) => backend.execution(id, { key }, signal),
    gcTime: QUERY_GC_TIME,
  });
}

export function scopeItemsQuery(backend: LoopyBackend, id: string, filters: ScopeItemsFilters) {
  return infiniteQueryOptions({
    queryKey: keys.scopeItems(id, filters),
    queryFn: ({ pageParam, signal }: { pageParam: number | undefined; signal: AbortSignal }) =>
      backend.scopeItems(id, { ...filters, after: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    maxPages: MAX_CACHED_ROWS / PAGE_SIZE,
    gcTime: QUERY_GC_TIME,
  });
}

export function logPagesQuery(backend: LoopyBackend, filters: LogFilters) {
  return infiniteQueryOptions({
    queryKey: keys.logPages(filters),
    queryFn: ({ pageParam, signal }: { pageParam: number | undefined; signal: AbortSignal }) =>
      backend.globalLogs({ ...filters, before: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined,
    getNextPageParam: (page) => (page.hasMore ? (page.next ?? undefined) : undefined),
    maxPages: MAX_CACHED_ROWS / PAGE_SIZE,
    gcTime: QUERY_GC_TIME,
  });
}

export function logQuery(backend: LoopyBackend, id: number | undefined) {
  return queryOptions({
    queryKey: keys.log(id),
    queryFn: id === undefined ? skipToken : ({ signal }) => backend.log(id, signal),
    staleTime: Infinity,
    gcTime: QUERY_GC_TIME,
  });
}

export function eventPagesQuery(backend: LoopyBackend, filters: EventFilters) {
  return infiniteQueryOptions({
    queryKey: keys.eventPages(filters),
    queryFn: ({ pageParam, signal }: { pageParam: number | undefined; signal: AbortSignal }) =>
      backend.eventHistory({ ...filters, before: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined,
    getNextPageParam: (page) => (page.hasMore ? (page.next ?? undefined) : undefined),
    maxPages: MAX_CACHED_ROWS / PAGE_SIZE,
    gcTime: QUERY_GC_TIME,
  });
}

export function eventQuery(backend: LoopyBackend, sequence: number | undefined) {
  return queryOptions({
    queryKey: keys.event(sequence),
    queryFn: sequence === undefined ? skipToken : ({ signal }) => backend.event(sequence, signal),
    staleTime: Infinity,
    gcTime: QUERY_GC_TIME,
  });
}

export function scopesQuery(backend: LoopyBackend, id: string, parentScope: string) {
  return queryOptions({
    queryKey: keys.scopes(id, parentScope),
    queryFn: ({ signal }) => backend.scopes(id, { parentScope }, signal),
    gcTime: 0,
  });
}

export function runPayloadQuery(backend: LoopyBackend, id: string | null) {
  return queryOptions({
    queryKey: keys.runPayload(id),
    queryFn: id === null ? skipToken : ({ signal }) => backend.runPayload(id, signal),
    gcTime: 0,
  });
}
