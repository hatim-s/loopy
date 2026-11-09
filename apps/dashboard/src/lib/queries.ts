import type { RunsQuery } from "@loopy/contract";
import { queryOptions, skipToken } from "@tanstack/react-query";
import type { ApiQuery, LoopyBackend } from "../backend/backend";
import { keys } from "./keys";

const QUERY_GC_TIME = 60_000;

/**
 * The daemon lists workspaces it knows from runs and schedules. Naming a workspace also lists
 * that workspace's registry, which may hold loopies nothing has run or scheduled yet.
 */
export function loopiesQuery(backend: LoopyBackend, workspace?: string) {
  return queryOptions({
    queryKey: workspace === undefined ? keys.loopies : keys.workspaceLoopies(workspace),
    queryFn: ({ signal }) => backend.call("loopies", { query: { workspace } }, signal),
  });
}

/**
 * The stream keeps a shown page current by patching rows and refetching on membership changes.
 * The server's next cursor stays with the page, so stream removals never move its boundary.
 */
export function runPageQuery(backend: LoopyBackend, query: RunsQuery & { limit: number }) {
  return queryOptions({
    queryKey: keys.runPage(query),
    queryFn: ({ signal }) => backend.call("runs", { query }, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
  });
}

/**
 * The event stream patches every snapshot field in place, so it never goes stale by time.
 * Scoped node events change only the scope counts, which scopesQuery owns.
 */
export function runQuery(backend: LoopyBackend, id: string) {
  return queryOptions({
    queryKey: keys.run(id),
    queryFn: ({ signal }) => backend.call("run", { params: { id } }, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
  });
}

/** Saves do not travel on the event stream, so the latest definition refetches by time. */
export function loopyGraphQuery(backend: LoopyBackend, slug: string, workspace: string) {
  return queryOptions({
    queryKey: keys.loopyGraph(slug, workspace),
    queryFn: ({ signal }) =>
      backend.call("graph", { params: { slug }, query: { workspace } }, signal),
  });
}

/** A run's revision is fixed when the run is created, so its graph never changes. */
export function runGraphQuery(backend: LoopyBackend, id: string) {
  return queryOptions({
    queryKey: keys.runGraph(id),
    queryFn: ({ signal }) => backend.call("runGraph", { params: { id } }, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
  });
}

/** Polled, since the daemon's counters do not travel on the event stream. */
export function daemonQuery(backend: LoopyBackend) {
  return queryOptions({
    queryKey: keys.daemon,
    queryFn: ({ signal }) => backend.call("daemon", {}, signal),
    refetchInterval: 5000,
    retry: false,
  });
}

export function scheduleOverviewQuery(backend: LoopyBackend) {
  return queryOptions({
    queryKey: keys.scheduleOverview,
    queryFn: ({ signal }) => backend.call("scheduleOverview", {}, signal),
  });
}

export function schedulesQuery(backend: LoopyBackend, workspace: string | null) {
  return queryOptions({
    queryKey: keys.schedules(workspace),
    queryFn:
      workspace === null
        ? skipToken
        : ({ signal }) => backend.call("schedules", { query: { workspace } }, signal),
  });
}

export function overviewQuery(backend: LoopyBackend, query: ApiQuery<"overview">) {
  return queryOptions({
    queryKey: keys.overview(query),
    queryFn: ({ signal }) => backend.call("overview", { query }, signal),
    gcTime: QUERY_GC_TIME,
    meta: { refresh: { on: "run", runId: null } },
  });
}

export function runSourceQuery(backend: LoopyBackend, id: string) {
  return queryOptions({
    queryKey: keys.runSource(id),
    queryFn: ({ signal }) => backend.call("runSource", { params: { id } }, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
  });
}

export function loopySourceQuery(backend: LoopyBackend, slug: string, workspace: string) {
  return queryOptions({
    queryKey: keys.source(slug, workspace),
    queryFn: ({ signal }) =>
      backend.call("source", { params: { slug }, query: { workspace } }, signal),
    gcTime: QUERY_GC_TIME,
  });
}

export function executionPageQuery(
  backend: LoopyBackend,
  id: string,
  query: ApiQuery<"executions"> | null,
) {
  return queryOptions({
    queryKey: keys.executionPage(id, query),
    queryFn:
      query === null
        ? skipToken
        : ({ signal }) => backend.call("executions", { params: { id }, query }, signal),
    gcTime: 0,
    meta: { refresh: { on: "node", runId: id } },
  });
}

export function executionQuery(backend: LoopyBackend, id: string, key: string | undefined) {
  return queryOptions({
    queryKey: keys.execution(id, key),
    queryFn:
      key === undefined
        ? skipToken
        : ({ signal }) => backend.call("execution", { params: { id }, query: { key } }, signal),
    gcTime: QUERY_GC_TIME,
    meta: { refresh: { on: "node", runId: id } },
  });
}

export function scopePageQuery(backend: LoopyBackend, id: string, query: ApiQuery<"scopeItems">) {
  return queryOptions({
    queryKey: keys.scopePage(id, query),
    queryFn: ({ signal }) => backend.call("scopeItems", { params: { id }, query }, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
    meta: { refresh: { on: "node", runId: id } },
  });
}

/** `live` keeps the page current while it is the newest page and the reader follows it. */
export function logPageQuery(backend: LoopyBackend, query: ApiQuery<"globalLogs">, live: boolean) {
  return queryOptions({
    queryKey: keys.logPage(query),
    queryFn: ({ signal }) => backend.call("globalLogs", { query }, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
    meta: live ? { refresh: { on: "log" } } : {},
  });
}

export function logQuery(backend: LoopyBackend, id: number | undefined) {
  return queryOptions({
    queryKey: keys.log(id),
    queryFn:
      id === undefined
        ? skipToken
        : ({ signal }) => backend.call("log", { params: { id } }, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
  });
}

/** `live` keeps the page current while it is the newest page. */
export function eventPageQuery(
  backend: LoopyBackend,
  query: ApiQuery<"eventHistory">,
  live: boolean,
) {
  return queryOptions({
    queryKey: keys.eventPage(query),
    queryFn: ({ signal }) => backend.call("eventHistory", { query }, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
    meta: live ? { refresh: { on: "feed" } } : {},
  });
}

export function eventQuery(backend: LoopyBackend, sequence: number | undefined) {
  return queryOptions({
    queryKey: keys.event(sequence),
    queryFn:
      sequence === undefined
        ? skipToken
        : ({ signal }) => backend.call("event", { params: { sequence } }, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: QUERY_GC_TIME,
  });
}

export function scopesQuery(backend: LoopyBackend, id: string, parentScope: string) {
  return queryOptions({
    queryKey: keys.scopes(id, parentScope),
    queryFn: ({ signal }) =>
      backend.call("scopes", { params: { id }, query: { parentScope } }, signal),
    gcTime: 0,
    meta: { refresh: { on: "node", runId: id } },
  });
}

export function runPayloadQuery(backend: LoopyBackend, id: string | null) {
  return queryOptions({
    queryKey: keys.runPayload(id),
    queryFn:
      id === null
        ? skipToken
        : ({ signal }) => backend.call("runPayload", { params: { id } }, signal),
    gcTime: 0,
    meta: id === null ? {} : { refresh: { on: "run", runId: id } },
  });
}
