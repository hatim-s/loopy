import { skipToken, type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  executionKeyString,
  type GraphRevisionView,
  type LogRecord,
  type RunSnapshotView,
  type RunView,
  type routes,
  type ScheduleOverviewView,
  type ScheduleView,
  type ServerEvent,
} from "loopy/contract";
import { useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import { useBackend } from "../router-context.ts";
import { keys } from "./keys.ts";
import {
  daemonQuery,
  eventQuery,
  executionQuery,
  logQuery,
  loopiesQuery,
  loopyGraphQuery,
  loopySourceQuery,
  overviewQuery,
  runGraphQuery,
  runPage,
  runPayloadQuery,
  runQuery,
  runSourceQuery,
  scheduleOverviewQuery,
  schedulesQuery,
  scopesQuery,
  workspaceLoopiesQuery,
} from "./queries.ts";
import type {
  DaemonDetail,
  EventFilters,
  EventRow,
  ExecutionDetail,
  ExecutionQuery,
  ExecutionRow,
  Lazy,
  Loaded,
  LogFilters,
  LogRow,
  LoopyRow,
  OverviewView,
  Pager,
  Period,
  RunListFilters,
  ScanInfo,
  ScopeItemQuery,
  ScopeItemRow,
  ScopeSummary,
  ScopeTuple,
  SourceView,
} from "./view-models.ts";

export const PERIOD_MS = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
} satisfies Record<Period, number>;

function loaded<T>(query: UseQueryResult<T>): Loaded<T> {
  if (query.isPending) {
    return { state: "loading" };
  }

  if (query.isError) {
    return { state: "error", error: query.error };
  }

  return { state: "ready", data: query.data, fetching: query.isFetching };
}

function mapLoaded<T, U>(value: Loaded<T>, map: (data: T) => U): Loaded<U> {
  return value.state === "ready" ? { ...value, data: map(value.data) } : value;
}

export function useOverview(period: Period, slug?: string): Loaded<OverviewView> {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);
  const bucketSeconds = period === "1h" ? 300 : period === "24h" ? 3600 : 86_400;

  const result = useQuery(
    overviewQuery(useBackend(), {
      slug,
      from: new Date(now - PERIOD_MS[period]).toISOString(),
      to: new Date(now).toISOString(),
      bucketSeconds,
    }),
  );

  return mapLoaded(loaded(result), (data) => ({
    period,
    from: data.from,
    to: data.to,
    bucketSeconds: data.bucketSeconds,
    totals: data.counts,
    previous: null,
    buckets: data.buckets.map((bucket) => ({ start: bucket.at, counts: bucket.counts })),
  }));
}

export function useLoopyRows(): Loaded<LoopyRow[]> {
  return mapLoaded(loaded(useQuery(loopiesQuery(useBackend()))), (rows) =>
    rows.map((row) => ({ ...row, latestRuns: row.latestRuns ?? [] })),
  );
}

export function useWorkspaceLoopyRows(workspace: string | null): Lazy<LoopyRow[]> {
  const query = useQuery(workspaceLoopiesQuery(useBackend(), workspace));

  if (workspace === null) {
    return { state: "idle" };
  }

  return mapLoaded(loaded(query), (rows) =>
    rows.map((row) => ({ ...row, latestRuns: row.latestRuns ?? [] })),
  );
}

// Cursor metadata stays bounded even if a tab pages through an entire retained history.
function useCursorStack<C extends string | number>(identity: string) {
  const [state, setState] = useState<{ identity: string; cursors: C[]; offset: number }>({
    identity,
    cursors: [],
    offset: 0,
  });

  const current = state.identity === identity ? state : { identity, cursors: [], offset: 0 };

  if (state.identity !== identity) {
    setState(current);
  }

  return {
    cursor: current.cursors.at(-1),
    depth: current.offset,
    hasPrevious: current.cursors.length > 1 || current.offset === 1,
    push: (cursor: C) =>
      setState((value) => ({
        identity,
        cursors: [...value.cursors, cursor].slice(-200),
        offset: value.offset + 1,
      })),
    pop: () =>
      setState((value) => ({
        ...value,
        cursors: value.cursors.slice(0, -1),
        offset: Math.max(0, value.offset - 1),
      })),
    reset: () => setState({ identity, cursors: [], offset: 0 }),
  };
}

function useFrom(period?: Period) {
  return useMemo(
    () => (period ? new Date(Date.now() - PERIOD_MS[period]).toISOString() : undefined),
    [period],
  );
}

export function useRunPages(filters: RunListFilters, pageSize: number): Pager<RunView> {
  const backend = useBackend();
  const stack = useCursorStack<string>(JSON.stringify({ filters, pageSize }));
  const from = useFrom(filters.period);

  const query = {
    slug: filters.slug,
    status: filters.status,
    waiting: filters.waiting,
    workspace: filters.workspace,
    from,
    limit: Math.min(200, pageSize),
    before: stack.cursor,
  };

  const page = useQuery({
    queryKey: keys.runPage(query),
    queryFn: async () => runPage(await backend.runs(query), query.limit),
    gcTime: 0,
    placeholderData: (previous) => previous,
  });

  return {
    ...mapLoaded(loaded(page), (data) => ({
      rows: data.runs,
      offset: stack.depth * pageSize,
      hasNext: data.nextCursor !== undefined,
      hasPrevious: stack.hasPrevious,
    })),
    next: () => {
      if (!page.isFetching && page.data?.nextCursor !== undefined) {
        stack.push(page.data.nextCursor);
      }
    },
    previous: stack.pop,
    first: stack.reset,
  };
}

export function useRunSnapshot(id: string): Loaded<RunSnapshotView> {
  return loaded(useQuery(runQuery(useBackend(), id)));
}

export function useRunGraph(id: string): Loaded<GraphRevisionView> {
  return loaded(useQuery(runGraphQuery(useBackend(), id)));
}

export function useLoopyGraph(slug: string, workspace: string): Loaded<GraphRevisionView> {
  return loaded(useQuery(loopyGraphQuery(useBackend(), slug, workspace)));
}

export function useRunPayload(
  runId: string | null,
): Lazy<z.output<typeof routes.runPayload.response>> {
  const query = useQuery(runPayloadQuery(useBackend(), runId));

  return runId === null ? { state: "idle" } : loaded(query);
}

export function useRunSource(runId: string): Loaded<SourceView> {
  return loaded(useQuery(runSourceQuery(useBackend(), runId)));
}

export function useLoopySource(slug: string, workspace: string): Loaded<SourceView> {
  return loaded(useQuery(loopySourceQuery(useBackend(), slug, workspace)));
}

export function useScopes(runId: string, parentScope: ScopeTuple): Loaded<ScopeSummary[]> {
  return loaded(useQuery(scopesQuery(useBackend(), runId, JSON.stringify(parentScope))));
}

export function useExecutions(
  runId: string,
  filters: ExecutionQuery | null,
): Pager<ExecutionRow, { complete: boolean }> {
  const backend = useBackend();
  const stack = useCursorStack<string>(JSON.stringify({ runId, filters }));

  const query =
    filters === null
      ? null
      : {
          scope: JSON.stringify(filters.scope),
          nodeId: filters.nodeId,
          after: stack.cursor,
          limit: 50,
        };

  const page = useQuery({
    queryKey: keys.executionPage(runId, query),
    queryFn: query === null ? skipToken : ({ signal }) => backend.executions(runId, query, signal),
    gcTime: 0,
  });

  return {
    ...mapLoaded(loaded(page), (data) => ({
      rows: data.items.map((execution) => ({
        execution,
        truncatedOutputBytes: data.truncatedOutputs[executionKeyString(execution.key)] ?? null,
      })),
      offset: stack.depth * 50,
      complete: stack.depth === 0 && data.next === null,
      hasNext: data.next !== null,
      hasPrevious: stack.hasPrevious,
    })),
    next: () => {
      if (!page.isFetching && page.data?.next != null) {
        stack.push(page.data.next);
      }
    },
    previous: stack.pop,
    first: stack.reset,
  };
}

export function useExecution(runId: string, key: string | null): Lazy<ExecutionDetail> {
  const page = useQuery(executionQuery(useBackend(), runId, key ?? undefined));

  if (key === null) {
    return { state: "idle" };
  }

  return mapLoaded(loaded(page), (data) => ({
    execution: data.node,
    input:
      data.node.inputView?.state === "available"
        ? { state: "recorded", value: data.node.inputView.value }
        : (data.node.inputView ?? { state: "not_recorded" }),
    // Attempts follow the server order, oldest first.
    attempts: data.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      startedAt: attempt.startedAt,
      endedAt: "endedAt" in attempt ? attempt.endedAt : null,
      error: "error" in attempt ? attempt.error : null,
    })),
    attemptsIncomplete: data.attemptsNext !== null || data.attempts.length < data.node.attempt,
  }));
}

export function useScopeItems(runId: string, filters: ScopeItemQuery): Pager<ScopeItemRow> {
  const backend = useBackend();
  const stack = useCursorStack<number>(JSON.stringify({ runId, filters }));

  const query = {
    nodeId: filters.nodeId,
    parentScope: JSON.stringify(filters.parentScope),
    status: filters.status,
    after: stack.cursor,
    limit: 50,
  };

  const page = useQuery({
    queryKey: keys.scopePage(runId, query),
    queryFn: ({ signal }) => backend.scopeItems(runId, query, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
  });

  return {
    ...mapLoaded(loaded(page), (data) => ({
      rows: data.items,
      offset: stack.depth * 50,
      hasNext: data.next !== null,
      hasPrevious: stack.hasPrevious,
    })),
    next: () => {
      if (!page.isFetching && page.data?.next != null) {
        stack.push(page.data.next);
      }
    },
    previous: stack.pop,
    first: stack.reset,
  };
}

export function useLogPages(filters: LogFilters): Pager<LogRow, ScanInfo> {
  const backend = useBackend();
  const stack = useCursorStack<number>(JSON.stringify(filters));
  const from = useFrom(filters.period);

  const query = {
    slug: filters.slug,
    runId: filters.runId,
    nodeId: filters.nodeId,
    status: filters.status,
    level: filters.level,
    text: filters.text,
    executionKey: filters.executionKey,
    from,
    before: stack.cursor,
    limit: 50,
  };

  const page = useQuery({
    queryKey: keys.logPage(query),
    meta: { live: filters.tail && stack.depth === 0 },
    queryFn: ({ signal }) => backend.globalLogs(query, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
  });

  return {
    ...mapLoaded(loaded(page), (data) => ({
      rows: data.items.map((row) => ({
        ...row,
        nodeId: row.nodeId || null,
        executionKey: row.executionKey || null,
        hasData: row.dataBytes > 0,
      })),
      offset: stack.depth * 50,
      hasNext: data.hasMore && data.next !== null,
      hasPrevious: stack.hasPrevious,
      searchedBackTo: data.scannedToAt ?? null,
      retained:
        data.oldestAt && data.newestAt ? { oldest: data.oldestAt, newest: data.newestAt } : null,
      newer: null,
    })),
    next: () => {
      if (!page.isFetching && page.data?.hasMore && page.data.next !== null) {
        stack.push(page.data.next);
      }
    },
    previous: stack.pop,
    first: stack.reset,
  };
}

export function useLog(id: number | null): Lazy<LogRecord> {
  const page = useQuery(logQuery(useBackend(), id ?? undefined));

  return id === null ? { state: "idle" } : mapLoaded(loaded(page), (data) => data.log);
}

export function useEventPages(filters: EventFilters): Pager<EventRow, ScanInfo> {
  const backend = useBackend();
  const stack = useCursorStack<number>(JSON.stringify(filters));
  const from = useFrom(filters.period);

  const query = {
    slug: filters.slug,
    runId: filters.runId,
    nodeId: filters.nodeId,
    entity: filters.entity,
    status: filters.status,
    kind: filters.kind,
    txn: filters.txn,
    from,
    before: stack.cursor,
    limit: 50,
  };

  const page = useQuery({
    queryKey: keys.eventPage(query),
    meta: { live: stack.depth === 0 },
    queryFn: ({ signal }) => backend.eventHistory(query, signal),
    gcTime: 0,
    placeholderData: (previous) => previous,
  });

  return {
    ...mapLoaded(loaded(page), (data) => ({
      rows: data.items,
      offset: stack.depth * 50,
      hasNext: data.hasMore && data.next !== null,
      hasPrevious: stack.hasPrevious,
      searchedBackTo: data.scannedToAt ?? null,
      retained:
        data.oldestAt && data.newestAt ? { oldest: data.oldestAt, newest: data.newestAt } : null,
      newer: null,
    })),
    next: () => {
      if (!page.isFetching && page.data?.hasMore && page.data.next !== null) {
        stack.push(page.data.next);
      }
    },
    previous: stack.pop,
    first: stack.reset,
  };
}

export function useEvent(sequence: number | null): Lazy<ServerEvent> {
  const page = useQuery(eventQuery(useBackend(), sequence ?? undefined));

  return sequence === null ? { state: "idle" } : loaded(page);
}

export function useDaemon(): Loaded<DaemonDetail> {
  return mapLoaded(loaded(useQuery(daemonQuery(useBackend()))), (daemon) => ({
    ...daemon,
    slots: null,
  }));
}

export function useScheduleOverview(): Loaded<ScheduleOverviewView> {
  return loaded(useQuery(scheduleOverviewQuery(useBackend())));
}

export function useSchedules(workspace: string | null): Loaded<ScheduleView[]> {
  return loaded(useQuery(schedulesQuery(useBackend(), workspace)));
}
