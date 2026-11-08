import { encodeRunCursor } from "@loopy/contract";
import { queryOptions, skipToken } from "@tanstack/react-query";
import type {
  EventHistoryQuery,
  ExecutionQuery,
  GlobalLogsQuery,
  LoopyBackend,
  OverviewQuery,
  RunsQuery,
  ScopeItemsQuery,
} from "../backend/backend";
import { keys } from "./keys";

const QUERY_GC_TIME = 60_000;

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
export function runPage(runs: Awaited<ReturnType<LoopyBackend["runs"]>>, limit: number) {
  const oldest = runs.at(-1);

  return {
    runs,
    nextCursor: runs.length < limit || oldest === undefined ? undefined : encodeRunCursor(oldest),
  };
}

export type RunPage = ReturnType<typeof runPage>;

// The stream keeps a shown page current by patching rows and refetching on membership changes.
export function runPageQuery(backend: LoopyBackend, query: RunsQuery & { limit: number }) {
  return queryOptions({
    queryKey: keys.runPage(query),
    queryFn: async () => runPage(await backend.runs(query), query.limit),
    gcTime: 0,
    placeholderData: (previous) => previous,
  });
}

/** The event stream keeps a loaded snapshot current, so it never goes stale by time. */
export function runQuery(backend: Pick<LoopyBackend, "run">, id: string) {
  return queryOptions({
    queryKey: keys.run(id),
    queryFn: ({ signal }) => backend.run(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
    meta: { refresh: { on: "scope", runId: id } },
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
    meta: { refresh: { on: "run", runId: null } },
  });
}

export function runSourceQuery(backend: LoopyBackend, id: string) {
  return queryOptions({
    queryKey: keys.runSource(id),
    queryFn: ({ signal }) => backend.runSource(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
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

export function executionPageQuery(
  backend: LoopyBackend,
  id: string,
  query: ExecutionQuery | null,
) {
  return queryOptions({
    queryKey: keys.executionPage(id, query),
    queryFn: query === null ? skipToken : ({ signal }) => backend.executions(id, query, signal),
    gcTime: 0,
    meta: { refresh: { on: "node", runId: id } },
  });
}

export function executionQuery(backend: LoopyBackend, id: string, key: string | undefined) {
  return queryOptions({
    queryKey: keys.execution(id, key),
    queryFn: key === undefined ? skipToken : ({ signal }) => backend.execution(id, { key }, signal),
    gcTime: QUERY_GC_TIME,
    meta: { refresh: { on: "node", runId: id } },
  });
}

export function scopePageQuery(backend: LoopyBackend, id: string, query: ScopeItemsQuery) {
  return queryOptions({
    queryKey: keys.scopePage(id, query),
    queryFn: ({ signal }) => backend.scopeItems(id, query, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
    meta: { refresh: { on: "node", runId: id } },
  });
}

/** `live` keeps the page current while it is the newest page and the reader follows it. */
export function logPageQuery(backend: LoopyBackend, query: GlobalLogsQuery, live: boolean) {
  return queryOptions({
    queryKey: keys.logPage(query),
    queryFn: ({ signal }) => backend.globalLogs(query, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
    meta: live ? { refresh: { on: "log" } } : {},
  });
}

export function logQuery(backend: LoopyBackend, id: number | undefined) {
  return queryOptions({
    queryKey: keys.log(id),
    queryFn: id === undefined ? skipToken : ({ signal }) => backend.log(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
  });
}

/** `live` keeps the page current while it is the newest page. */
export function eventPageQuery(backend: LoopyBackend, query: EventHistoryQuery, live: boolean) {
  return queryOptions({
    queryKey: keys.eventPage(query),
    queryFn: ({ signal }) => backend.eventHistory(query, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
    meta: live ? { refresh: { on: "feed" } } : {},
  });
}

export function eventQuery(backend: LoopyBackend, sequence: number | undefined) {
  return queryOptions({
    queryKey: keys.event(sequence),
    queryFn: sequence === undefined ? skipToken : ({ signal }) => backend.event(sequence, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
  });
}

export function scopesQuery(
  backend: Pick<LoopyBackend, "scopes">,
  id: string,
  parentScope: string,
) {
  return queryOptions({
    queryKey: keys.scopes(id, parentScope),
    queryFn: ({ signal }) => backend.scopes(id, { parentScope }, signal),
    gcTime: 0,
    meta: { refresh: { on: "node", runId: id } },
  });
}

export function runPayloadQuery(backend: LoopyBackend, id: string | null) {
  return queryOptions({
    queryKey: keys.runPayload(id),
    queryFn: id === null ? skipToken : ({ signal }) => backend.runPayload(id, signal),
    gcTime: 0,
    meta: id === null ? {} : { refresh: { on: "run", runId: id } },
  });
}
