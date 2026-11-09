import {
  DEFAULT_PAGE_SIZE,
  type EventSummaryView,
  executionKeyString,
  type GlobalLogsPage,
  PAGE_LIMIT,
  type RunView,
} from "@loopy/contract";
import { type QueryKey, type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useBackend } from "../router-context";
import { loaded, mapLoaded } from "./loaded";
import { type Period, periodStart } from "./period";
import {
  eventPageQuery,
  executionPageQuery,
  logPageQuery,
  runPageQuery,
  scopePageQuery,
} from "./queries";
import type {
  EventFilters,
  ExecutionRow,
  ExecutionScope,
  LogFilters,
  LogRow,
  Pager,
  RunListFilters,
  ScanInfo,
  ScopeItemQuery,
  ScopeItemRow,
} from "./view-models";

/**
 * Keyset cursors for the pages behind the shown one, so the page depth is the stack length.
 * A new identity starts at the newest page.
 */
function useCursorStack<C extends string | number>(identity: string) {
  const [state, setState] = useState<{ identity: string; cursors: C[] }>({
    identity,
    cursors: [],
  });

  const current = state.identity === identity ? state : { identity, cursors: [] };

  if (state.identity !== identity) {
    setState(current);
  }

  return {
    cursor: current.cursors.at(-1),
    depth: current.cursors.length,
    hasPrevious: current.cursors.length > 0,
    push: (cursor: C) => setState((value) => ({ identity, cursors: [...value.cursors, cursor] })),
    pop: () => setState((value) => ({ ...value, cursors: value.cursors.slice(0, -1) })),
    reset: () => setState({ identity, cursors: [] }),
  };
}

function usePager<
  C extends string | number,
  D,
  K extends QueryKey,
  Row,
  Extra extends object,
>(spec: {
  identity: unknown;
  pageSize: number;
  query: (cursor: C | undefined, depth: number) => UseQueryOptions<D, Error, D, K>;
  nextCursor: (data: D) => C | null;
  view: (data: D, depth: number) => { rows: Row[] } & Extra;
}): Pager<Row, Extra> {
  const stack = useCursorStack<C>(JSON.stringify(spec.identity));
  const page = useQuery(spec.query(stack.cursor, stack.depth));

  return {
    ...mapLoaded(loaded(page), (data) => ({
      ...spec.view(data, stack.depth),
      offset: stack.depth * spec.pageSize,
      hasNext: spec.nextCursor(data) !== null,
      hasPrevious: stack.hasPrevious,
    })),
    next: () => {
      const cursor = page.data === undefined ? null : spec.nextCursor(page.data);

      if (!page.isFetching && cursor !== null) {
        stack.push(cursor);
      }
    },
    previous: stack.pop,
    first: stack.reset,
  };
}

function useFrom(period?: Period) {
  return useMemo(() => (period ? periodStart(period, Date.now()) : undefined), [period]);
}

function scanInfo(page: Pick<GlobalLogsPage, "scannedToAt" | "oldestAt" | "newestAt">): ScanInfo {
  return {
    searchedBackTo: page.scannedToAt ?? null,
    retained:
      page.oldestAt && page.newestAt ? { oldest: page.oldestAt, newest: page.newestAt } : null,
  };
}

export function useRunPages(filters: RunListFilters, pageSize: number): Pager<RunView> {
  const backend = useBackend();
  const from = useFrom(filters.period);

  return usePager({
    identity: { filters, pageSize },
    pageSize,
    query: (before: string | undefined) =>
      runPageQuery(backend, {
        slug: filters.slug,
        status: filters.status,
        waiting: filters.waiting,
        workspace: filters.workspace,
        from,
        limit: Math.min(PAGE_LIMIT, pageSize),
        before,
      }),
    nextCursor: (data) => data.nextCursor ?? null,
    view: (data) => ({ rows: data.runs }),
  });
}

export function useExecutions(
  runId: string,
  filters: ExecutionScope | null,
): Pager<ExecutionRow, { complete: boolean }> {
  const backend = useBackend();

  return usePager({
    identity: { runId, filters },
    pageSize: DEFAULT_PAGE_SIZE,
    query: (after: string | undefined) =>
      executionPageQuery(
        backend,
        runId,
        filters === null
          ? null
          : {
              scope: JSON.stringify(filters.scope),
              nodeId: filters.nodeId,
              after,
              limit: DEFAULT_PAGE_SIZE,
            },
      ),
    nextCursor: (data) => data.next,
    view: (data, depth) => ({
      rows: data.items.map((execution) => ({
        execution,
        truncatedOutputBytes: data.truncatedOutputs[executionKeyString(execution.key)] ?? null,
      })),
      complete: depth === 0 && data.next === null,
    }),
  });
}

export function useScopeItems(runId: string, filters: ScopeItemQuery): Pager<ScopeItemRow> {
  const backend = useBackend();

  return usePager({
    identity: { runId, filters },
    pageSize: DEFAULT_PAGE_SIZE,
    query: (after: number | undefined) =>
      scopePageQuery(backend, runId, {
        nodeId: filters.nodeId,
        parentScope: JSON.stringify(filters.parentScope),
        status: filters.status,
        after,
        limit: DEFAULT_PAGE_SIZE,
      }),
    nextCursor: (data) => data.next,
    view: (data) => ({ rows: data.items }),
  });
}

export function useLogPages(filters: LogFilters): Pager<LogRow, ScanInfo> {
  const backend = useBackend();
  const from = useFrom(filters.period);

  return usePager({
    identity: filters,
    pageSize: DEFAULT_PAGE_SIZE,
    query: (before: number | undefined, depth) =>
      logPageQuery(
        backend,
        {
          slug: filters.slug,
          workspace: filters.workspace,
          runId: filters.runId,
          nodeId: filters.nodeId,
          status: filters.status,
          level: filters.level,
          text: filters.text,
          executionKey: filters.executionKey,
          from,
          before,
          limit: DEFAULT_PAGE_SIZE,
        },
        filters.tail && depth === 0,
      ),
    nextCursor: (data) => (data.hasMore ? data.next : null),
    view: (data) => ({
      rows: data.items.map(({ dataBytes, ...row }) => ({ ...row, hasData: dataBytes > 0 })),
      ...scanInfo(data),
    }),
  });
}

export function useEventPages(filters: EventFilters): Pager<EventSummaryView, ScanInfo> {
  const backend = useBackend();
  const from = useFrom(filters.period);

  return usePager({
    identity: filters,
    pageSize: DEFAULT_PAGE_SIZE,
    query: (before: number | undefined, depth) =>
      eventPageQuery(
        backend,
        {
          slug: filters.slug,
          workspace: filters.workspace,
          runId: filters.runId,
          nodeId: filters.nodeId,
          entity: filters.entity,
          status: filters.status,
          kind: filters.kind,
          txn: filters.txn,
          from,
          before,
          limit: DEFAULT_PAGE_SIZE,
        },
        depth === 0,
      ),
    nextCursor: (data) => (data.hasMore ? data.next : null),
    view: (data) => ({ rows: data.items, ...scanInfo(data) }),
  });
}
