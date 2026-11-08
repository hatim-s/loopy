import type { RunsQuery } from "@loopy/contract";
import type { ApiQuery } from "../backend/backend";

/**
 * Which stream events make a query stale. The stream patches run lists, snapshots and schedules
 * in place; everything it cannot patch declares one of these and refetches.
 * feed: every event. log: log lines. run: run transitions, of one run or of any (`null`).
 * node: node events of one run. scope: node events inside a map or other scope of one run.
 */
export type Refresh =
  | { on: "feed" }
  | { on: "log" }
  | { on: "run"; runId: string | null }
  | { on: "node"; runId: string }
  | { on: "scope"; runId: string };

export const keys = {
  overview: (query: ApiQuery<"overview">) => ["overview", query] as const,
  loopies: ["loopies"],
  workspaceLoopies: (workspace: string) => ["loopies", workspace] as const,
  source: (slug: string, workspace: string) => ["source", "loopy", workspace, slug] as const,
  runPayload: (id: string | null) => ["run-payload", id] as const,
  runSource: (id: string) => ["source", "run", id] as const,
  executionPage: (id: string, query: ApiQuery<"executions"> | null) =>
    ["executions", id, query] as const,
  execution: (id: string, key: string | undefined) => ["execution", id, key] as const,
  scopePage: (id: string, query: ApiQuery<"scopeItems">) => ["scope-items", id, query] as const,
  scopes: (id: string, parentScope: string) => ["scopes", id, parentScope] as const,
  logPage: (query: ApiQuery<"globalLogs">) => ["logs", query] as const,
  log: (id: number | undefined) => ["log", id] as const,
  eventPage: (query: ApiQuery<"eventHistory">) => ["event-history", query] as const,
  event: (sequence: number | undefined) => ["event", sequence] as const,
  runLists: ["runs"],
  runPage: (query: RunsQuery) => ["runs", query] as const,
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
    queryMeta: { refresh?: Refresh };
  }
}
