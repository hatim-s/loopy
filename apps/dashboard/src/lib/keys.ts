import type {
  EventHistoryQuery,
  ExecutionQuery,
  GlobalLogsQuery,
  OverviewQuery,
  RunsQuery,
  ScopeItemsQuery,
} from "../backend/backend.ts";

/** The filters a paged run list is keyed by; the page cursor lives in the query itself. */
export type RunFilters = Omit<RunsQuery, "before" | "limit">;

export type ExecutionFilters = Omit<ExecutionQuery, "after" | "limit">;

export type ScopeItemsFilters = Omit<ScopeItemsQuery, "after" | "limit">;

export type LogFilters = Omit<GlobalLogsQuery, "before" | "after" | "limit">;

export type EventFilters = Omit<EventHistoryQuery, "before" | "after" | "limit">;

/** Every Query key the dashboard uses. The stream reducer writes into the same keys. */
export const keys = {
  overview: (query: OverviewQuery) => ["overview", query] as const,
  overviews: ["overview"],
  loopies: ["loopies"],
  workspaceLoopies: (workspace: string | null) => ["loopies", workspace] as const,
  source: (slug: string, workspace: string) => ["source", "loopy", workspace, slug] as const,
  runPayload: (id: string | null) => ["run-payload", id] as const,
  runSource: (id: string) => ["source", "run", id] as const,
  executionPage: (id: string, query: ExecutionQuery | null) => ["executions", id, query] as const,
  scopePage: (id: string, query: ScopeItemsQuery) => ["scope-items", id, query] as const,
  logPage: (query: GlobalLogsQuery) => ["logs", query] as const,
  eventPage: (query: EventHistoryQuery) => ["event-history", query] as const,
  scopes: (id: string, parentScope: string) => ["scopes", id, parentScope] as const,
  executionLists: (id: string) => ["executions", id] as const,
  executions: (id: string, filters: ExecutionFilters) => ["executions", id, filters] as const,
  executionDetails: (id: string) => ["execution", id] as const,
  execution: (id: string, key: string | undefined) => ["execution", id, key] as const,
  scopeLists: (id: string) => ["scope-items", id] as const,
  scopeItems: (id: string, filters: ScopeItemsFilters) => ["scope-items", id, filters] as const,
  logLists: ["logs"],
  logPages: (filters: LogFilters) => ["logs", filters] as const,
  log: (id: number | undefined) => ["log", id] as const,
  eventLists: ["event-history"],
  eventPages: (filters: EventFilters) => ["event-history", filters] as const,
  event: (sequence: number | undefined) => ["event", sequence] as const,
  runLists: ["runs"],
  runPage: (query: RunsQuery) => ["runs", "page", query] as const,
  runs: (query: RunsQuery) => ["runs", query] as const,
  runPages: (filters: RunFilters) => ["runs", "pages", filters] as const,
  run: (id: string) => ["run", id] as const,
  loopyGraph: (slug: string, workspace: string) => ["graph", "loopy", workspace, slug] as const,
  runGraph: (id: string) => ["graph", "run", id] as const,
  daemon: ["daemon"],
  scheduleOverview: ["schedule-overview"] as const,
  scheduleLists: ["schedules"],
  schedules: (workspace: string | null) => ["schedules", workspace] as const,
} as const;

type DashboardKey = (typeof keys)[keyof typeof keys];

type QueryKey = DashboardKey extends infer Key
  ? Key extends (...args: never[]) => infer Result
    ? Result
    : Key
  : never;

declare module "@tanstack/react-query" {
  interface Register {
    queryKey: QueryKey;
  }
}
